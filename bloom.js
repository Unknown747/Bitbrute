import * as fs from "fs";
import * as readline from "readline";
import * as zlib from "zlib";
import bloomPkg from "bloom-filters";

const { BloomFilter } = bloomPkg;

export const ADDRESSES_TXT = "addresses.txt";
export const ADDRESSES_GZ = "addresses.txt.gz";
export const BLOOM_CACHE_FILE = "addresses.bloom.gz";
export const BLOOM_FP_RATE = 0.0001;

const BUILD_PROGRESS_LINES = 1_000_000;
const BUILD_YIELD_LINES = 50_000;

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function findAddressesSource() {
  if (fs.existsSync(ADDRESSES_GZ)) return ADDRESSES_GZ;
  if (fs.existsSync(ADDRESSES_TXT)) return ADDRESSES_TXT;
  return null;
}

function estimateAddressCount(sourcePath, sizeBytes) {
  const bytesPerAddr = 35;
  const compressionRatio = sourcePath.endsWith(".gz") ? 4 : 1;
  const est = Math.ceil((sizeBytes * compressionRatio) / bytesPerAddr);
  return Math.max(1024, Math.ceil(est * 1.2));
}

function openAddressStream(sourcePath) {
  let stream = fs.createReadStream(sourcePath);
  if (sourcePath.endsWith(".gz")) {
    stream = stream.pipe(zlib.createGunzip());
  }
  return stream;
}

async function buildBloomFromStream(sourcePath, capacity) {
  const filter = BloomFilter.create(capacity, BLOOM_FP_RATE);
  const rl = readline.createInterface({
    input: openAddressStream(sourcePath),
    crlfDelay: Infinity,
  });

  let count = 0;
  const start = Date.now();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    filter.add(line);
    count++;

    if (count % BUILD_PROGRESS_LINES === 0) {
      const sec = (Date.now() - start) / 1000;
      const rate = Math.round(count / sec);
      console.log(
        `  [build] ${count.toLocaleString()} addresses indexed (${rate.toLocaleString()}/s, ${sec.toFixed(1)}s)`,
      );
    }
    if (count % BUILD_YIELD_LINES === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }
  const sec = (Date.now() - start) / 1000;
  console.log(
    `  [build] complete: ${count.toLocaleString()} addresses in ${sec.toFixed(1)}s`,
  );
  return { filter, count };
}

async function saveBloomCache(filter, sourceMtimeMs, count, capacity) {
  const payload = {
    version: 2,
    sourceMtimeMs,
    count,
    capacity,
    fpRate: BLOOM_FP_RATE,
    filter: filter.saveAsJSON(),
  };
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(BLOOM_CACHE_FILE);
    const gz = zlib.createGzip({ level: 6 });
    gz.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    gz.on("error", reject);
    gz.end(JSON.stringify(payload));
  });
}

async function loadBloomCacheMeta(expectedSourceMtimeMs) {
  if (!fs.existsSync(BLOOM_CACHE_FILE)) return null;
  return new Promise((resolve) => {
    const chunks = [];
    fs.createReadStream(BLOOM_CACHE_FILE)
      .pipe(zlib.createGunzip())
      .on("data", (c) => chunks.push(c))
      .on("end", () => {
        try {
          const obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            expectedSourceMtimeMs != null &&
            obj.sourceMtimeMs !== expectedSourceMtimeMs
          ) {
            console.log(
              "Bloom cache is stale (source file changed). Rebuilding...",
            );
            return resolve(null);
          }
          resolve({ count: obj.count });
        } catch (e) {
          console.log(`Bloom cache unreadable (${e.message}). Rebuilding...`);
          resolve(null);
        }
      })
      .on("error", (err) => {
        console.log(`Bloom cache read error (${err.message}). Rebuilding...`);
        resolve(null);
      });
  });
}

export function loadBloomFromCacheSync() {
  const buf = fs.readFileSync(BLOOM_CACHE_FILE);
  const decompressed = zlib.gunzipSync(buf);
  const obj = JSON.parse(decompressed.toString("utf8"));
  return BloomFilter.fromJSON(obj.filter);
}

export async function ensureBloomCache() {
  const sourcePath = findAddressesSource();
  if (!sourcePath) {
    console.log(
      `No ${ADDRESSES_TXT} or ${ADDRESSES_GZ} found — bloom filter disabled, will hit API every iteration.`,
    );
    return null;
  }

  const stat = fs.statSync(sourcePath);
  const cached = await loadBloomCacheMeta(stat.mtimeMs);
  if (cached) {
    const cacheStat = fs.statSync(BLOOM_CACHE_FILE);
    console.log(
      `Bloom cache HIT: ${cached.count.toLocaleString()} addresses, ${fmtBytes(cacheStat.size)} on disk.`,
    );
    return { path: BLOOM_CACHE_FILE, count: cached.count };
  }

  const capacity = estimateAddressCount(sourcePath, stat.size);
  console.log(
    `Building bloom filter from ${sourcePath} (${fmtBytes(stat.size)}), capacity=${capacity.toLocaleString()}, fp=${BLOOM_FP_RATE}`,
  );
  const { filter, count } = await buildBloomFromStream(sourcePath, capacity);

  console.log(`Saving bloom cache to ${BLOOM_CACHE_FILE}...`);
  try {
    await saveBloomCache(filter, stat.mtimeMs, count, capacity);
    const cacheStat = fs.statSync(BLOOM_CACHE_FILE);
    console.log(`Bloom cache saved (${fmtBytes(cacheStat.size)}).`);
  } catch (e) {
    console.log(`Could not save bloom cache: ${e.message}`);
    return null;
  }
  return { path: BLOOM_CACHE_FILE, count };
}
