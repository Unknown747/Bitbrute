const bitcore = require("bitcore-lib");
const { BloomFilter } = require("bloom-filters");
const fs = require("fs");
const crypto = require("crypto");

const STATE_FILE = "state.json";
const ADDRESSES_FILE = "addresses.txt";
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

const PROGRESS_INTERVAL = 1000;
const SAVE_INTERVAL = 1000;

const apiState = { pause: 0 };

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (s.seed && typeof s.counter === "number") {
        console.log(
          `Resuming deterministic scan: seed=${s.seed.slice(0, 8)}... counter=${s.counter}`,
        );
        return s;
      }
    } catch (e) {
      console.log("state.json is corrupted, starting fresh.");
    }
  }
  const seed = crypto.randomBytes(32).toString("hex");
  const state = { seed, counter: 0 };
  saveState(state);
  console.log(
    `New deterministic scan started: seed=${seed.slice(0, 8)}... counter=0`,
  );
  return state;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function loadBloomFilter() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.log(
      `No ${ADDRESSES_FILE} found — bloom filter disabled, will hit API every iteration.`,
    );
    return null;
  }
  const lines = fs
    .readFileSync(ADDRESSES_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) {
    console.log("addresses.txt is empty — bloom filter disabled.");
    return null;
  }
  const filter = BloomFilter.create(Math.max(lines.length, 1024), 0.0001);
  for (const a of lines) filter.add(a);
  console.log(
    `Loaded ${lines.length} addresses into bloom filter (FP rate ~0.01%).`,
  );
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

async function main() {
  console.log("\n-----------------Warning Wallet Balance---------------!");
  const state = loadState();
  const bloom = loadBloomFilter();

  const startCounter = state.counter;
  const startTime = Date.now();

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
      }
    }

    state.counter++;

    if (state.counter % PROGRESS_INTERVAL === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = ((state.counter - startCounter) / elapsed).toFixed(1);
      console.log(`[${state.counter}] ${address}  (${rate}/s)`);
    }
    if (state.counter % SAVE_INTERVAL === 0) {
      saveState(state);
    }
  }
}

let shuttingDown = false;
function gracefulSave(state) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    saveState(state);
    console.log("\nState saved. Exiting.");
  } catch (e) {}
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
