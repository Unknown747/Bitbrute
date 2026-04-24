import * as fs from "fs";
import * as readline from "readline";
import * as zlib from "zlib";
import { sha256 } from "@noble/hashes/sha256";

export const ADDRESSES_TXT = "addresses.txt";
export const ADDRESSES_GZ = "addresses.txt.gz";
export const BLOOM_CACHE_FILE = "addresses.bloom.bin";
export const LEGACY_BLOOM_CACHE_FILE = "addresses.bloom.gz";
export const BLOOM_FP_RATE = 0.0001;
const CACHE_VERSION = 3;

const BUILD_PROGRESS_LINES = 1_000_000;
const BUILD_YIELD_LINES = 50_000;

const TEXT_ENCODER = new TextEncoder();

export class SabBloom {
  constructor(sab, m, k) {
    this.sab = sab;
    this.m = m;
    this.k = k;
    this.bytes = new Uint8Array(sab);
  }

  static create(capacity, fpRate) {
    const m = Math.max(
      64,
      Math.ceil(-capacity * Math.log(fpRate) / (Math.LN2 * Math.LN2)),
    );
    const k = Math.max(1, Math.round((m / capacity) * Math.LN2));
    const sab = new SharedArrayBuffer(Math.ceil(m / 8));
    return new SabBloom(sab, m, k);
  }

  _indices(item) {
    const bytes =
      typeof item === "string" ? TEXT_ENCODER.encode(item) : item;
    const h = sha256(bytes);
    const h1 =
      ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    const h2 =
      ((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) >>> 0;
    const out = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      out[i] = (h1 + i * h2) % this.m;
    }
    return out;
  }

  add(item) {
    const idx = this._indices(item);
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i];
      this.bytes[v >>> 3] |= 1 << (v & 7);
    }
  }

  has(item) {
    const idx = this._indices(item);
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i];
      if ((this.bytes[v >>> 3] & (1 << (v & 7))) === 0) return false;
    }
    return true;
  }
}

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
  const bloom = SabBloom.create(capacity, BLOOM_FP_RATE);
  const rl = readline.createInterface({
    input: openAddressStream(sourcePath),
    crlfDelay: Infinity,
  });

  let count = 0;
  const start = Date.now();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    bloom.add(line);
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
  return { bloom, count };
}

function saveBloomCache(bloom, sourceMtimeMs, count) {
  const headerJson = JSON.stringify({
    version: CACHE_VERSION,
    m: bloom.m,
    k: bloom.k,
    sourceMtimeMs,
    count,
  });
  const headerBuf = Buffer.from(headerJson, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(headerBuf.length, 0);
  const bitBuf = Buffer.from(
    bloom.bytes.buffer,
    bloom.bytes.byteOffset,
    bloom.bytes.byteLength,
  );
  const tmp = BLOOM_CACHE_FILE + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, lenBuf);
    fs.writeSync(fd, headerBuf);
    fs.writeSync(fd, bitBuf);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, BLOOM_CACHE_FILE);
}

function loadBloomCache(expectedSourceMtimeMs) {
  if (!fs.existsSync(BLOOM_CACHE_FILE)) return null;
  const fd = fs.openSync(BLOOM_CACHE_FILE, "r");
  try {
    const lenBuf = Buffer.alloc(4);
    fs.readSync(fd, lenBuf, 0, 4, 0);
    const L = lenBuf.readUInt32BE(0);
    if (L < 0 || L > 65536) return null;
    const headerBuf = Buffer.alloc(L);
    fs.readSync(fd, headerBuf, 0, L, 4);
    const header = JSON.parse(headerBuf.toString("utf8"));
    if (header.version !== CACHE_VERSION) return null;
    if (
      expectedSourceMtimeMs != null &&
      header.sourceMtimeMs !== expectedSourceMtimeMs
    ) {
      console.log("Bloom cache stale (source changed). Rebuilding...");
      return null;
    }
    const bitsLen = Math.ceil(header.m / 8);
    const sab = new SharedArrayBuffer(bitsLen);
    const bytes = new Uint8Array(sab);
    fs.readSync(fd, bytes, 0, bitsLen, 4 + L);
    return { sab, m: header.m, k: header.k, count: header.count };
  } catch (e) {
    console.log(`Bloom cache unreadable (${e.message}). Rebuilding...`);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function loadBloomFromShared(sab, m, k) {
  return new SabBloom(sab, m, k);
}

export function cleanupLegacyCache() {
  if (fs.existsSync(LEGACY_BLOOM_CACHE_FILE)) {
    try {
      fs.unlinkSync(LEGACY_BLOOM_CACHE_FILE);
      console.log(
        `Removed legacy ${LEGACY_BLOOM_CACHE_FILE} (replaced by ${BLOOM_CACHE_FILE}).`,
      );
    } catch (_) {}
  }
}

export async function ensureBloomCache() {
  cleanupLegacyCache();
  const sourcePath = findAddressesSource();
  if (!sourcePath) {
    console.log(
      `No ${ADDRESSES_TXT} or ${ADDRESSES_GZ} found — bloom filter disabled, will hit API every iteration.`,
    );
    return null;
  }

  const stat = fs.statSync(sourcePath);
  const cached = loadBloomCache(stat.mtimeMs);
  if (cached) {
    const cacheStat = fs.statSync(BLOOM_CACHE_FILE);
    console.log(
      `Bloom cache HIT: ${cached.count.toLocaleString()} addresses, ${fmtBytes(cacheStat.size)} on disk, m=${cached.m.toLocaleString()} bits, k=${cached.k}.`,
    );
    return cached;
  }

  const capacity = estimateAddressCount(sourcePath, stat.size);
  console.log(
    `Building bloom filter from ${sourcePath} (${fmtBytes(stat.size)}), capacity=${capacity.toLocaleString()}, fp=${BLOOM_FP_RATE}`,
  );
  const { bloom, count } = await buildBloomFromStream(sourcePath, capacity);

  console.log(`Saving bloom cache to ${BLOOM_CACHE_FILE}...`);
  try {
    saveBloomCache(bloom, stat.mtimeMs, count);
    const cacheStat = fs.statSync(BLOOM_CACHE_FILE);
    console.log(
      `Bloom cache saved (${fmtBytes(cacheStat.size)}, m=${bloom.m.toLocaleString()} bits, k=${bloom.k}).`,
    );
  } catch (e) {
    console.log(`Could not save bloom cache: ${e.message}`);
  }
  return { sab: bloom.sab, m: bloom.m, k: bloom.k, count };
}
