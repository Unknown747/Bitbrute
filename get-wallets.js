import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as path from "path";

const DEFAULT_URL =
  "http://addresses.loyce.club/Bitcoin_addresses_LATEST.txt.gz";
const DEFAULT_OUT = "addresses.txt.gz";
const BLOOM_CACHE_FILE = "addresses.bloom.bin";
const LEGACY_BLOOM_CACHE_FILE = "addresses.bloom.gz";

const MAX_RETRIES = 10;
const IDLE_TIMEOUT_MS = 60000;
const RETRY_DELAY_MS = 5000;
const BAR_WIDTH = 28;

function parseArgs(argv) {
  const opts = { url: DEFAULT_URL, out: DEFAULT_OUT, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") opts.force = true;
    else if (a === "--url" || a === "-u") opts.url = argv[++i];
    else if (a === "--out" || a === "-o") opts.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node get-wallets.js [options]

Downloads the latest known-funded Bitcoin address list and saves it to
${DEFAULT_OUT} so main.js can build its bloom filter from it.

Options:
  -u, --url <url>     Source URL (default: ${DEFAULT_URL})
  -o, --out <file>    Output file (default: ${DEFAULT_OUT})
  -f, --force         Re-download even if the output file already exists
  -h, --help          Show this help
`);
      process.exit(0);
    }
  }
  return opts;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDuration(ms) {
  if (!isFinite(ms) || ms < 0) return "--";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtBar(ratio) {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return "[" + "█".repeat(filled) + "░".repeat(empty) + "]";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function get(url, headers = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        get(next, headers, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Connection timed out"));
    });
  });
}

async function downloadChunk(url, tmpPath, startByte, sessionStartByte, overallStart) {
  const headers = {};
  if (startByte > 0) {
    headers["Range"] = `bytes=${startByte}-`;
  }

  const res = await get(url, headers);

  if (startByte > 0 && res.statusCode === 206) {
  } else if (res.statusCode === 200) {
    if (startByte > 0) {
      startByte = 0;
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  } else if (res.statusCode === 416) {
    res.resume();
    return { totalBytes: startByte, done: true };
  } else {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} from ${url}`);
  }

  const contentRange = res.headers["content-range"];
  let totalBytes = 0;
  if (contentRange) {
    const m = contentRange.match(/\/(\d+)$/);
    if (m) totalBytes = parseInt(m[1], 10);
  }
  if (!totalBytes) {
    const cl = parseInt(res.headers["content-length"] || "0", 10);
    totalBytes = startByte + cl;
  }

  const file = fs.createWriteStream(tmpPath, { flags: startByte > 0 ? "a" : "w" });
  let received = startByte;
  let lastPrint = 0;
  let idleTimer = null;

  function resetIdle(rejectFn) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      file.destroy();
      res.destroy(new Error(`Idle timeout — no data for ${IDLE_TIMEOUT_MS / 1000}s`));
    }, IDLE_TIMEOUT_MS);
  }

  return new Promise((resolve, reject) => {
    resetIdle(reject);

    res.on("data", (chunk) => {
      received += chunk.length;
      resetIdle(reject);

      const now = Date.now();
      if (now - lastPrint > 250) {
        const sessionElapsedSec = (now - overallStart) / 1000;
        const sessionDownloaded = received - sessionStartByte;
        const sessionRate = sessionElapsedSec > 0 ? sessionDownloaded / sessionElapsedSec : 0;

        const pct = totalBytes > 0 ? received / totalBytes : 0;
        const bar = totalBytes > 0 ? fmtBar(pct) : fmtBar(0);
        const pctStr = totalBytes > 0 ? `${(pct * 100).toFixed(1)}%` : "??%";
        const etaMs = totalBytes > 0 && sessionRate > 0
          ? ((totalBytes - received) / sessionRate) * 1000
          : -1;
        const etaStr = etaMs >= 0 ? fmtDuration(etaMs) : "--";
        const rateStr = `${fmtBytes(sessionRate)}/s`;
        const sizeStr = totalBytes > 0
          ? `${fmtBytes(received)} / ${fmtBytes(totalBytes)}`
          : fmtBytes(received);
        const elapsed = fmtDuration(now - overallStart);

        process.stdout.write(
          `\r  ${bar} ${pctStr.padStart(5)}  ${sizeStr}  ${rateStr}  ETA ${etaStr}  elapsed ${elapsed}   `
        );
        lastPrint = now;
      }
    });

    res.pipe(file);

    file.on("finish", () => {
      if (idleTimer) clearTimeout(idleTimer);
      file.close((err) => {
        if (err) return reject(err);
        resolve({ totalBytes: Math.max(totalBytes, received), done: false });
      });
    });

    res.on("error", (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      file.destroy();
      reject(err);
    });

    file.on("error", (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      reject(err);
    });
  });
}

async function download(url, outPath) {
  console.log(`Downloading: ${url}`);
  console.log(`Saving to  : ${outPath}`);

  const tmpPath = outPath + ".part";

  let startByte = 0;
  if (fs.existsSync(tmpPath)) {
    startByte = fs.statSync(tmpPath).size;
    if (startByte > 0) {
      console.log(`Resuming from ${fmtBytes(startByte)} (found partial file from previous run).`);
    }
  }

  const sessionStartByte = startByte;
  const overallStart = Date.now();

  console.log("");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { totalBytes, done } = await downloadChunk(
        url, tmpPath, startByte, sessionStartByte, overallStart
      );

      process.stdout.write("\n");

      if (done) break;

      const currentSize = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
      if (totalBytes > 0 && currentSize < totalBytes) {
        startByte = currentSize;
        const pct = ((currentSize / totalBytes) * 100).toFixed(1);
        console.log(
          `  [retry ${attempt}/${MAX_RETRIES}] Incomplete at ${pct}% (${fmtBytes(currentSize)} of ${fmtBytes(totalBytes)}), resuming in ${RETRY_DELAY_MS / 1000}s...`
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      break;
    } catch (err) {
      process.stdout.write("\n");
      const currentSize = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
      startByte = currentSize;
      if (attempt >= MAX_RETRIES) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw new Error(`Failed after ${MAX_RETRIES} attempts: ${err.message}`);
      }
      const pct = startByte > 0 ? ` at ${fmtBytes(startByte)}` : "";
      console.log(
        `  [retry ${attempt}/${MAX_RETRIES}] ${err.message}${pct} — resuming in ${RETRY_DELAY_MS / 1000}s...`
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  try {
    fs.renameSync(tmpPath, outPath);
  } catch (e) {
    throw new Error(`Could not rename temp file: ${e.message}`);
  }

  const finalSize = fs.statSync(outPath).size;
  const elapsed = Date.now() - overallStart;
  const sessionDownloaded = finalSize - sessionStartByte;
  console.log(`Done: ${fmtBytes(finalSize)} total  (downloaded ${fmtBytes(sessionDownloaded)} this session in ${fmtDuration(elapsed)})`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (fs.existsSync(opts.out) && !opts.force) {
    const stat = fs.statSync(opts.out);
    console.log(
      `${opts.out} already exists (${fmtBytes(stat.size)}, modified ${stat.mtime.toISOString()}).`
    );
    console.log("Use --force to re-download.");
    process.exit(0);
  }

  try {
    await download(opts.url, opts.out);
  } catch (err) {
    console.error(`\nDownload failed: ${err.message}`);
    process.exit(1);
  }

  const isAddressList =
    opts.out === DEFAULT_OUT || opts.out === "addresses.txt";
  if (isAddressList) {
    for (const f of [BLOOM_CACHE_FILE, LEGACY_BLOOM_CACHE_FILE]) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
          console.log(
            `Removed stale ${f} — main.js will rebuild it on next start.`
          );
        } catch (e) {}
      }
    }
  }

  if (isAddressList) {
    console.log(
      `\nNext: run "node main.js" — it will detect ${path.basename(opts.out)} and build/cache the bloom filter automatically.`
    );
  }
}

main();
