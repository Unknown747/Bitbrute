import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { ensureBloomCache } from "./bloom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATE_FILE = "state.json";
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

const BATCH_SIZE = 2000;

const MIN_WORKERS = 1;
const MAX_WORKERS = Math.max(1, os.cpus().length);
const SCALE_INTERVAL_MS = 5000;
const SCALE_COOLDOWN_MS = 8000;
const LAG_HIGH_MS = 120;
const LAG_LOW_MS = 30;
const FREE_MEM_MIN = 0.15;

const BALANCE_PROVIDERS = [
  {
    name: "blockstream",
    url: (a) => `https://blockstream.info/api/address/${a}`,
    parse: async (res) => {
      const data = await res.json();
      const f = data.chain_stats?.funded_txo_sum ?? 0;
      const s = data.chain_stats?.spent_txo_sum ?? 0;
      return f - s;
    },
  },
  {
    name: "mempool.space",
    url: (a) => `https://mempool.space/api/address/${a}`,
    parse: async (res) => {
      const data = await res.json();
      const f = data.chain_stats?.funded_txo_sum ?? 0;
      const s = data.chain_stats?.spent_txo_sum ?? 0;
      return f - s;
    },
  },
  {
    name: "blockchain.info",
    url: (a) => `https://blockchain.info/q/addressbalance/${a}?confirmations=0`,
    parse: async (res) => {
      const text = await res.text();
      const n = Number(text.trim());
      return Number.isFinite(n) ? n : null;
    },
  },
];

const session = {
  startTime: 0,
  startCounter: 0,
  vanity: 0,
  bloomMatch: 0,
  found: 0,
  scanned: 0,
  peakWorkers: 0,
  scaleEvents: 0,
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
  const seed = randomBytes(32).toString("hex");
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

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function measureEventLoopLag() {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const start = process.hrtime.bigint();
    await new Promise((r) => setImmediate(r));
    const lag = Number(process.hrtime.bigint() - start) / 1e6;
    samples.push(lag);
  }
  return Math.max(...samples);
}

function freeMemRatio() {
  return os.freemem() / os.totalmem();
}

const balanceState = { providerIdx: 0, consecutiveErrors: 0 };

async function getBalance(address) {
  for (let attempt = 0; attempt < BALANCE_PROVIDERS.length; attempt++) {
    const provider =
      BALANCE_PROVIDERS[
        (balanceState.providerIdx + attempt) % BALANCE_PROVIDERS.length
      ];
    try {
      const res = await fetch(provider.url(address), {
        headers: { Accept: "application/json,text/plain" },
      });
      if (res.status === 429) {
        console.log(`\n[balance] ${provider.name} rate-limited, trying next.`);
        continue;
      }
      if (!res.ok) {
        console.log(`\n[balance] ${provider.name} HTTP ${res.status}, trying next.`);
        continue;
      }
      const balance = await provider.parse(res);
      balanceState.providerIdx =
        (balanceState.providerIdx + attempt) % BALANCE_PROVIDERS.length;
      balanceState.consecutiveErrors = 0;
      return { balance, providerName: provider.name };
    } catch (err) {
      console.log(
        `\n[balance] ${provider.name} error: ${err.message}, trying next.`,
      );
    }
  }
  balanceState.consecutiveErrors++;
  return { balance: null, providerName: null };
}

async function handleHit(hit, state) {
  const baseRec =
    `counter=${hit.counter}  type=${hit.type}\n` +
    `Address: ${hit.addr}\n` +
    `WIF: ${hit.wif}\n` +
    `Private Key (hex): ${hit.privHex}\n`;

  if (hit.vanity) {
    const rec = `\n[VANITY ${hit.vanity}] ${baseRec}`;
    console.log(rec);
    fs.appendFileSync(VANITY_FILE, rec);
    session.vanity++;
    state.totals.vanity++;
  }

  if (hit.bloomMatch) {
    const rec = `\n[BLOOM MATCH] ${baseRec}`;
    console.log(rec);
    fs.appendFileSync(NEAR_MISS_FILE, rec);
    session.bloomMatch++;
    state.totals.bloomMatch++;

    const { balance, providerName } = await getBalance(hit.addr);
    if (balance !== null && balance > 0) {
      const rec2 =
        `\n[FOUND via ${providerName}] ${baseRec}` +
        `Balance (sat): ${balance}\n`;
      console.log(rec2);
      fs.appendFileSync(FOUND_FILE, rec2);
      session.found++;
      state.totals.found++;
    }
  }
}

function printStartStats(state, bloomInfo, initialWorkers) {
  console.log("");
  console.log("================ START ================");
  if (state.counter === 0) {
    console.log(`  Mode      : new scan (seed=${state.seed.slice(0, 8)}...)`);
  } else {
    console.log(
      `  Mode      : resume (seed=${state.seed.slice(0, 8)}..., counter=${state.counter.toLocaleString()})`,
    );
  }
  console.log(
    `  Bloom     : ${bloomInfo ? `enabled (${bloomInfo.count.toLocaleString()} addresses)` : "disabled (API per key)"}`,
  );
  console.log(
    `  Address   : 4 types per key (P2PKH comp/uncomp, P2SH-SegWit, Bech32 SegWit)`,
  );
  console.log(
    `  Workers   : ${initialWorkers} (adaptive ${MIN_WORKERS}..${MAX_WORKERS}, cores=${os.cpus().length})`,
  );
  console.log(
    `  Providers : ${BALANCE_PROVIDERS.map((p) => p.name).join(", ")}`,
  );
  console.log(
    `  Lifetime  : vanity=${state.totals.vanity}  bloom-match=${state.totals.bloomMatch}  found=${state.totals.found}`,
  );
  console.log("=======================================");
  console.log("");
}

function printStopStats(state, finalWorkers) {
  const elapsed = Date.now() - session.startTime;
  const scanned = session.scanned;
  const rate = elapsed > 0 ? (scanned / (elapsed / 1000)).toFixed(1) : "0";
  console.log("");
  console.log("================ STOP =================");
  console.log(`  Session   : ${formatDuration(elapsed)}`);
  console.log(
    `  Scanned   : ${scanned.toLocaleString()} keys (${rate}/s, ~${(scanned * 4).toLocaleString()} addresses)`,
  );
  console.log(
    `  Hits      : vanity=${session.vanity}  bloom-match=${session.bloomMatch}  found=${session.found}`,
  );
  console.log(
    `  Workers   : final=${finalWorkers}  peak=${session.peakWorkers}  scale-events=${session.scaleEvents}`,
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
  const bloomInfo = await ensureBloomCache();

  session.startCounter = state.counter;
  session.startTime = Date.now();

  const workers = new Map();
  let nextWorkerId = 0;
  let assignedCounter = state.counter;
  const completedBatches = new Map();
  let lastSave = Date.now();
  let lastScale = 0;
  let stopping = false;
  let stoppedSignal = null;

  function advanceCounter() {
    while (completedBatches.has(state.counter)) {
      const c = completedBatches.get(state.counter);
      completedBatches.delete(state.counter);
      state.counter += c;
    }
  }

  function dispatch(entry) {
    if (stopping || entry.stopping) return;
    const start = assignedCounter;
    const count = BATCH_SIZE;
    assignedCounter += count;
    entry.busy = true;
    entry.batchStart = start;
    entry.worker.postMessage({ type: "scan", startCounter: start, count });
  }

  function spawnWorker() {
    const id = nextWorkerId++;
    const worker = new Worker(path.join(__dirname, "worker.js"), {
      workerData: {
        workerId: id,
        seedHex: state.seed,
        bloomCachePath: bloomInfo ? bloomInfo.path : null,
        vanityPatterns: VANITY_PATTERNS,
      },
    });
    const entry = { id, worker, busy: false, stopping: false };
    workers.set(id, entry);

    worker.on("message", async (msg) => {
      if (msg.type === "ready") {
        dispatch(entry);
      } else if (msg.type === "done") {
        session.scanned += msg.scanned;
        completedBatches.set(msg.startCounter, msg.count);
        advanceCounter();
        for (const hit of msg.hits) {
          await handleHit(hit, state);
        }
        if (Date.now() - lastSave > 2000) {
          saveState(state);
          lastSave = Date.now();
        }
        entry.busy = false;
        if (entry.stopping) {
          worker.postMessage({ type: "stop" });
        } else {
          dispatch(entry);
        }
      }
    });

    worker.on("error", (err) => {
      console.error(`[worker ${id}] error: ${err.message}`);
    });

    worker.on("exit", () => {
      workers.delete(id);
    });

    if (workers.size > session.peakWorkers) {
      session.peakWorkers = workers.size;
    }
    return entry;
  }

  function stopOneWorker(reason) {
    let target = null;
    for (const e of workers.values()) {
      if (!e.stopping) {
        target = e;
      }
    }
    if (!target) return false;
    target.stopping = true;
    if (!target.busy) {
      target.worker.postMessage({ type: "stop" });
    }
    console.log(`[scale] workers: ${workers.size} → ${workers.size - 1} (${reason})`);
    session.scaleEvents++;
    return true;
  }

  function startOneWorker(reason) {
    if (workers.size >= MAX_WORKERS) return false;
    spawnWorker();
    console.log(
      `[scale] workers: ${workers.size - 1} → ${workers.size} (${reason})`,
    );
    session.scaleEvents++;
    return true;
  }

  async function scaleTick() {
    if (stopping) return;
    if (Date.now() - lastScale < SCALE_COOLDOWN_MS) return;

    const lag = await measureEventLoopLag();
    const memFree = freeMemRatio();
    const active = [...workers.values()].filter((e) => !e.stopping).length;

    if (memFree < FREE_MEM_MIN && active > MIN_WORKERS) {
      if (
        stopOneWorker(
          `mem low (free=${(memFree * 100).toFixed(0)}%)`,
        )
      ) {
        lastScale = Date.now();
      }
      return;
    }

    if (lag > LAG_HIGH_MS && active > MIN_WORKERS) {
      if (
        stopOneWorker(
          `lag high (${lag.toFixed(0)}ms, free=${(memFree * 100).toFixed(0)}%)`,
        )
      ) {
        lastScale = Date.now();
      }
      return;
    }

    if (lag < LAG_LOW_MS && memFree > 0.3 && active < MAX_WORKERS) {
      if (
        startOneWorker(
          `idle (lag=${lag.toFixed(0)}ms, free=${(memFree * 100).toFixed(0)}%)`,
        )
      ) {
        lastScale = Date.now();
      }
    }
  }

  const initialWorkers = Math.min(2, MAX_WORKERS);
  printStartStats(state, bloomInfo, initialWorkers);
  for (let i = 0; i < initialWorkers; i++) spawnWorker();
  lastScale = Date.now();

  const scaleTimer = setInterval(scaleTick, SCALE_INTERVAL_MS);

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    stoppedSignal = signal;
    clearInterval(scaleTimer);
    console.log(`\nReceived ${signal}, draining workers...`);
    for (const entry of workers.values()) {
      entry.stopping = true;
      if (!entry.busy) {
        entry.worker.postMessage({ type: "stop" });
      }
    }
    const finalWorkers = workers.size;
    const drainDeadline = Date.now() + 8000;
    const checkDone = setInterval(() => {
      if (workers.size === 0 || Date.now() > drainDeadline) {
        clearInterval(checkDone);
        for (const e of workers.values()) {
          try {
            e.worker.terminate();
          } catch (_) {}
        }
        try {
          saveState(state);
        } catch (e) {}
        printStopStats(state, finalWorkers);
        process.exit(0);
      }
    }, 100);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
