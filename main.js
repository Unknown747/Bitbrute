const bitcore = require("bitcore-lib");
const { BloomFilter } = require("bloom-filters");
const fs = require("fs");
const readline = require("readline");
const zlib = require("zlib");
const crypto = require("crypto");

const STATE_FILE = "state.json";
const ADDRESSES_TXT = "addresses.txt";
const ADDRESSES_GZ = "addresses.txt.gz";
const BLOOM_CACHE_FILE = "addresses.bloom.gz";
const FOUND_FILE = "found.txt";
const VANITY_FILE = "vanity.txt";
const NEAR_MISS_FILE = "near-miss.txt";

const VANITY_PATTERNS = [
  "1Love",
  "1Lucky",
  "1Bitcoin",
  "1Satoshi",
  "1Crypto",
  "1Money",
  "1Cash",
  "1Boss",
  "1ABCD",
  "1Free",
];

const BLOOM_FP_RATE = 0.0001;
const SAVE_INTERVAL = 1000;
const YIELD_INTERVAL = 200;

const BUILD_PROGRESS_LINES = 1_000_000;
const BUILD_YIELD_LINES = 50_000;

const apiState = { pause: 0 };

const session = {
  startTime: 0,
  startCounter: 0,
  vanity: 0,
  bloomMatch: 0,
  found: 0,
};

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (s.seed && typeof s.counter === "number") {
        s.totals = s.totals || { vanity: 0, bloomMatch: 0, found: 0 };
        return s;
      }
    } catch (e) {
      console.log("state.json is corrupted, starting fresh.");
    }
  }
  const seed = crypto.randomBytes(32).toString("hex");
  const state = {
    seed,
    counter: 0,
    totals: { vanity: 0, bloomMatch: 0, found: 0 },
  };
  saveState(state);
  return state;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function findAddressesSource() {
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

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
    version: 1,
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

async function loadBloomCache(expectedSourceMtimeMs) {
  if (!fs.existsSync(BLOOM_CACHE_FILE)) return null;
  return new Promise((resolve, reject) => {
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
          const filter = BloomFilter.fromJSON(obj.filter);
          resolve({ filter, count: obj.count });
        } catch (e) {
          console.log(
            `Bloom cache unreadable (${e.message}). Rebuilding...`,
          );
          resolve(null);
        }
      })
      .on("error", (err) => {
        console.log(`Bloom cache read error (${err.message}). Rebuilding...`);
        resolve(null);
      });
  });
}

async function loadBloomFilter() {
  const sourcePath = findAddressesSource();
  if (!sourcePath) {
    console.log(
      `No ${ADDRESSES_TXT} or ${ADDRESSES_GZ} found — bloom filter disabled, will hit API every iteration.`,
    );
    return null;
  }

  const stat = fs.statSync(sourcePath);
  const cached = await loadBloomCache(stat.mtimeMs);
  if (cached) {
    const cacheStat = fs.statSync(BLOOM_CACHE_FILE);
    console.log(
      `Bloom cache HIT: ${cached.count.toLocaleString()} addresses, ${formatBytes(cacheStat.size)} on disk.`,
    );
    return cached.filter;
  }

  const capacity = estimateAddressCount(sourcePath, stat.size);
  console.log(
    `Building bloom filter from ${sourcePath} (${formatBytes(stat.size)}), capacity=${capacity.toLocaleString()}, fp=${BLOOM_FP_RATE}`,
  );
  const { filter, count } = await buildBloomFromStream(sourcePath, capacity);

  console.log(`Saving bloom cache to ${BLOOM_CACHE_FILE}...`);
  try {
    await saveBloomCache(filter, stat.mtimeMs, count, capacity);
    const cacheStat = fs.statSync(BLOOM_CACHE_FILE);
    console.log(`Bloom cache saved (${formatBytes(cacheStat.size)}).`);
  } catch (e) {
    console.log(`Could not save bloom cache: ${e.message}`);
  }
  return filter;
}

function deriveKeyFromSeed(seedHex, counter) {
  const seedBuf = Buffer.from(seedHex, "hex");
  const ctrBuf = Buffer.alloc(8);
  ctrBuf.writeBigUInt64BE(BigInt(counter));
  return crypto.createHash("sha256").update(seedBuf).update(ctrBuf).digest();
}

function makeKey(privBuf) {
  try {
    return new bitcore.PrivateKey(privBuf.toString("hex"));
  } catch (e) {
    return null;
  }
}

function checkVanity(address) {
  for (const p of VANITY_PATTERNS) {
    if (address.startsWith(p)) return p;
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getBalance(address) {
  try {
    const res = await fetch(`https://blockstream.info/api/address/${address}`, {
      headers: { Accept: "application/json" },
    });
    if (res.status === 429) {
      apiState.pause += 1;
      if (apiState.pause >= 10) {
        console.log("\nRate limited. Sleeping 30s...\n");
        await sleep(30000);
        apiState.pause = 0;
      }
      return null;
    }
    if (!res.ok) {
      console.log(`\nHTTP ${res.status}, retrying in 10s\n`);
      await sleep(10000);
      return null;
    }
    const data = await res.json();
    apiState.pause = 0;
    const funded = data.chain_stats?.funded_txo_sum ?? 0;
    const spent = data.chain_stats?.spent_txo_sum ?? 0;
    return funded - spent;
  } catch (err) {
    console.log(`\nNetwork error: ${err.message}, retrying in 10s\n`);
    await sleep(10000);
    return null;
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function printStartStats(state, bloom) {
  console.log("");
  console.log("================ START ================");
  if (state.counter === 0) {
    console.log(`  Mode      : new scan (seed=${state.seed.slice(0, 8)}...)`);
  } else {
    console.log(
      `  Mode      : resume (seed=${state.seed.slice(0, 8)}..., counter=${state.counter.toLocaleString()})`,
    );
  }
  console.log(`  Bloom     : ${bloom ? "enabled" : "disabled (API per key)"}`);
  console.log(
    `  Lifetime  : vanity=${state.totals.vanity}  bloom-match=${state.totals.bloomMatch}  found=${state.totals.found}`,
  );
  console.log("=======================================");
  console.log("");
}

function printStopStats(state) {
  const elapsed = Date.now() - session.startTime;
  const scanned = state.counter - session.startCounter;
  const rate = elapsed > 0 ? (scanned / (elapsed / 1000)).toFixed(1) : "0";
  console.log("");
  console.log("================ STOP =================");
  console.log(`  Session   : ${formatDuration(elapsed)}`);
  console.log(`  Scanned   : ${scanned.toLocaleString()} keys (${rate}/s)`);
  console.log(
    `  Hits      : vanity=${session.vanity}  bloom-match=${session.bloomMatch}  found=${session.found}`,
  );
  console.log(`  Counter   : ${state.counter.toLocaleString()}`);
  console.log(
    `  Lifetime  : vanity=${state.totals.vanity}  bloom-match=${state.totals.bloomMatch}  found=${state.totals.found}`,
  );
  console.log("=======================================");
  console.log("");
}

async function main() {
  const state = loadState();
  const bloom = await loadBloomFilter();

  session.startCounter = state.counter;
  session.startTime = Date.now();
  printStartStats(state, bloom);

  const shutdown = (signal) => {
    try {
      saveState(state);
    } catch (e) {}
    console.log(`\nReceived ${signal}, stopping...`);
    printStopStats(state);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (true) {
    const privBuf = deriveKeyFromSeed(state.seed, state.counter);
    const pk = makeKey(privBuf);
    if (!pk) {
      state.counter++;
      continue;
    }

    const pub = pk.toPublicKey();
    const address = pub.toAddress().toString();
    const wif = pk.toWIF();
    const privHex = pk.toString();
    const pubHex =
      "04" +
      pub.point.getX().toString(16, 64) +
      pub.point.getY().toString(16, 64);

    const vanity = checkVanity(address);
    if (vanity) {
      const rec =
        `\n[VANITY ${vanity}] counter=${state.counter}\n` +
        `Address: ${address}\n` +
        `WIF: ${wif}\n` +
        `Private Key (hex): ${privHex}\n` +
        `Public Key: ${pubHex.toUpperCase()}\n`;
      console.log(rec);
      fs.appendFileSync(VANITY_FILE, rec);
      session.vanity++;
      state.totals.vanity++;
    }

    let queryApi = !bloom;
    if (bloom && bloom.has(address)) {
      const rec =
        `\n[BLOOM MATCH] counter=${state.counter}\n` +
        `Address: ${address}\n` +
        `WIF: ${wif}\n` +
        `Private Key (hex): ${privHex}\n`;
      console.log(rec);
      fs.appendFileSync(NEAR_MISS_FILE, rec);
      session.bloomMatch++;
      state.totals.bloomMatch++;
      queryApi = true;
    }

    if (queryApi) {
      const balance = await getBalance(address);
      if (balance !== null && balance > 0) {
        const rec =
          `\n[FOUND] counter=${state.counter}\n` +
          `Address: ${address}\n` +
          `Balance (sat): ${balance}\n` +
          `WIF: ${wif}\n` +
          `Private Key (hex): ${privHex}\n` +
          `Public Key: ${pubHex.toUpperCase()}\n`;
        console.log(rec);
        fs.appendFileSync(FOUND_FILE, rec);
        session.found++;
        state.totals.found++;
      }
    }

    state.counter++;

    if (state.counter % SAVE_INTERVAL === 0) {
      saveState(state);
    }
    if (state.counter % YIELD_INTERVAL === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
