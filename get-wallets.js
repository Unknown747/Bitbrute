import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as path from "path";

const DEFAULT_URL =
  "http://addresses.loyce.club/Bitcoin_addresses_LATEST.txt.gz";
const DEFAULT_OUT = "addresses.txt.gz";
const BLOOM_CACHE_FILE = "addresses.bloom.gz";

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
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function get(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, (res) => {
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
        get(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}

async function download(url, outPath) {
  console.log(`Downloading: ${url}`);
  console.log(`Saving to  : ${outPath}`);

  const tmpPath = outPath + ".part";
  const res = await get(url);
  const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
  if (totalBytes > 0) {
    console.log(`Size       : ${fmtBytes(totalBytes)}`);
  } else {
    console.log("Size       : (unknown, server did not send Content-Length)");
  }
  console.log("");

  const file = fs.createWriteStream(tmpPath);
  let received = 0;
  const start = Date.now();
  let lastPrint = 0;

  return new Promise((resolve, reject) => {
    res.on("data", (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastPrint > 1000) {
        const elapsed = (now - start) / 1000;
        const rate = received / elapsed;
        const pct =
          totalBytes > 0
            ? `${((received / totalBytes) * 100).toFixed(1)}%`
            : "??";
        const eta =
          totalBytes > 0 && rate > 0
            ? fmtDuration(((totalBytes - received) / rate) * 1000)
            : "??";
        process.stdout.write(
          `\r  ${fmtBytes(received)}${totalBytes > 0 ? " / " + fmtBytes(totalBytes) : ""}  ${pct}  ${fmtBytes(rate)}/s  ETA ${eta}        `,
        );
        lastPrint = now;
      }
    });
    res.pipe(file);
    file.on("finish", () => {
      file.close((err) => {
        if (err) return reject(err);
        process.stdout.write("\n");
        try {
          fs.renameSync(tmpPath, outPath);
        } catch (e) {
          return reject(e);
        }
        const elapsed = Date.now() - start;
        console.log(
          `\nDone: ${fmtBytes(received)} in ${fmtDuration(elapsed)}.`,
        );
        resolve();
      });
    });
    res.on("error", (err) => {
      file.destroy();
      try {
        fs.unlinkSync(tmpPath);
      } catch (e) {}
      reject(err);
    });
    file.on("error", (err) => {
      try {
        fs.unlinkSync(tmpPath);
      } catch (e) {}
      reject(err);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (fs.existsSync(opts.out) && !opts.force) {
    const stat = fs.statSync(opts.out);
    console.log(
      `${opts.out} already exists (${fmtBytes(stat.size)}, modified ${stat.mtime.toISOString()}).`,
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
  if (isAddressList && fs.existsSync(BLOOM_CACHE_FILE)) {
    try {
      fs.unlinkSync(BLOOM_CACHE_FILE);
      console.log(
        `Removed stale ${BLOOM_CACHE_FILE} — main.js will rebuild it on next start.`,
      );
    } catch (e) {}
  }

  if (isAddressList) {
    console.log(
      `\nNext: run "node main.js" — it will detect ${path.basename(opts.out)} and build/cache the bloom filter automatically.`,
    );
  }
}

main();
