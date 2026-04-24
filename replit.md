# Project Overview

A multi-threaded Node.js command-line scanner that generates Bitcoin private keys, derives **four address types** per key (P2PKH compressed, P2PKH uncompressed, P2SH-wrapped SegWit, native Bech32 SegWit), checks each address against a local bloom filter of known-funded addresses, hits public balance APIs only on bloom matches, scans for vanity-prefix addresses, and persists deterministic scan progress so it can resume across restarts.

Originally a Python script that hit a defunct external balance API on every key. Rewritten in modern ESM Node.js with the following architecture.

## Features

1. **Worker-thread pool with adaptive scaling** — master spawns N workers (default starts at 2), and a 5-second monitor automatically scales workers up when the device is idle (low event-loop lag, free memory available) and scales down when the device is under load (high lag or low memory). Bounded by `MIN_WORKERS=1` and `MAX_WORKERS=os.cpus().length`. Each scale event is logged with the trigger reason. There is an 8-second cooldown between scale changes.
2. **Native-speed ECC via @noble/secp256k1 v2** — pure-JS but heavily optimized. Replaced `bitcore-lib` (slow, generic) for ~3-5x faster public-key derivation per worker.
3. **4 address types per private key** — every scanned key is checked against P2PKH compressed (`1...`), P2PKH uncompressed (`1...`), P2SH-wrapped SegWit (`3...`), and native Bech32 SegWit (`bc1q...`). Coverage per key is 4x without extra ECC operations beyond one compressed + one uncompressed pubkey.
4. **Bloom filter pre-check** — addresses are checked in-memory against a bloom filter built from `addresses.txt` (or `addresses.txt.gz`). Workers each load the bloom from the cache file at startup. The remote balance API is only queried when the bloom filter reports a possible match.
5. **Multi-provider balance failover** — bloom matches are queried against `blockstream.info`, then `mempool.space`, then `blockchain.info`. The next provider is tried automatically on rate-limit (HTTP 429), network error, or non-OK status. The last successful provider becomes the default for the next call.
6. **WIF in every record** — vanity hits, bloom matches, and confirmed found wallets are logged with both raw hex private key and Wallet Import Format (importable directly into Electrum / Bitcoin Core / etc.). WIF compression flag matches the address type.
7. **Deterministic resumable scan** — a 32-byte seed plus a counter are saved to `state.json` periodically. On restart, the scan resumes from the saved counter using the same seed. Master tracks completed batch ranges and slides the persisted counter forward only over contiguous prefixes, so resume is always safe even with multi-worker out-of-order completion.
8. **Vanity pattern detection** — every address is screened against a list of vanity prefixes (e.g. `1Love`, `1Lucky`, `1Bitcoin`, `1Satoshi`) and matches are logged to `vanity.txt` regardless of balance.
9. **Streaming address-list loader** — `addresses.txt` is read line-by-line via a stream so loading a 1.5 GB file uses only a few KB of RAM at any time. Works transparently with gzipped input (`addresses.txt.gz`).
10. **Persistent bloom-filter cache** — once the bloom filter is built, it is serialized and gzipped to `addresses.bloom.gz`. Subsequent restarts (and all worker spawns) load the cache instantly. The cache is invalidated automatically if the source file's modification time changes.
11. **Pre-sized filter + progress + event-loop yielding** — the bloom filter is sized from the source file size. During build, progress is printed every 1M lines and the event loop yields every 50k lines so the process stays responsive.
12. **Lazy WIF / hex computation** — WIF and hex private key are only encoded inside the worker when an address actually triggers a vanity match or bloom hit. Skipped on the 99.99%+ of iterations that produce nothing.

## Project Structure

- `main.js` — master orchestrator: state, worker pool, work distribution, adaptive scaling, hit handling, multi-provider balance lookup, signal handling.
- `worker.js` — per-worker scanner: derives 4 addresses per private key, checks each against vanity patterns and the bloom filter, posts hits back to master.
- `keys.js` — key/address derivation helpers: `isValidPrivKey`, `deriveAll` (returns 4 addresses), `wifEncode`, hex helpers. Uses `@noble/secp256k1`, `@noble/hashes`, `bs58check`, `bech32`.
- `bloom.js` — bloom filter helpers: source detection, cache build/save/load, capacity estimation.
- `get-wallets.js` — utility to download the latest known-funded Bitcoin address list (~500 MB gzipped) into `addresses.txt.gz`. Run with `node get-wallets.js`. Supports `--force`, `--url`, `--out`, `--help`. After download it auto-invalidates the bloom cache so the next `main.js` run rebuilds.
- `addresses.txt` — sample of well-known Bitcoin addresses for the bloom filter on Replit. Replace with the real ~50M-address dump on a real machine / VPS — easiest way is to run `node get-wallets.js`.
- `package.json` / `package-lock.json` — Node ESM project (`"type": "module"`).
- `.replit` — Replit configuration.
- `.gitignore` — ignores `node_modules`, runtime state, output files, and the bloom cache.

## Runtime / Tooling

- Language: Node.js 20+, ESM modules.
- Dependencies: `@noble/secp256k1` (ECC), `@noble/hashes` (SHA-256 + RIPEMD-160), `bs58check` (base58check encoding), `bech32` (SegWit encoding), `bloom-filters` (probabilistic membership test).
- HTTP: built-in global `fetch`.
- Balance APIs (in failover order): `blockstream.info`, `mempool.space`, `blockchain.info`.

## Workflows

- `Start application` — runs `node main.js` as a console process. No port; this is a CLI loop, not a web app.

## Runtime Files (gitignored)

- `state.json` — `{ seed, counter, totals }`, persisted every ~2 seconds and on shutdown.
- `addresses.bloom.gz` — gzipped serialized bloom filter (auto-generated; deleted means rebuild on next start).
- `addresses.txt.gz` — optional gzipped source list (preferred for large dumps).
- `found.txt` — actual wallets with balance > 0 (full hex + WIF + balance + provider name).
- `near-miss.txt` — bloom matches that turned out to be zero balance (still saved with WIF and address type).
- `vanity.txt` — addresses matching a vanity prefix.

## Adaptive Scaling Tuning

- `LAG_HIGH_MS = 120` — event-loop lag above this triggers scale-down.
- `LAG_LOW_MS = 30` — lag below this triggers scale-up (when free memory > 30%).
- `FREE_MEM_MIN = 0.15` — free memory below this triggers scale-down.
- `SCALE_INTERVAL_MS = 5000` — how often the monitor evaluates.
- `SCALE_COOLDOWN_MS = 8000` — minimum time between scale events.
- `BATCH_SIZE = 2000` — keys per worker batch (≈4× addresses derived).

## Replit vs. Real Machine

- On Replit (this project): `addresses.txt` ships with a small sample of famous addresses just to demonstrate the bloom-filter architecture. Hits in this set are statistically impossible from random scanning — it is for setup verification only.
- On your own machine / VPS: just run `node get-wallets.js`. That fetches the latest list from `http://addresses.loyce.club/` directly to `addresses.txt.gz` (gzipped, ~500 MB) and clears the old bloom cache. Then run `node main.js` — the first start will stream-build the bloom filter (~3–5 min for 50M entries on typical hardware) and cache it to `addresses.bloom.gz` (~150 MB). Every restart after that is instant. Each worker holds its own copy of the bloom in memory; budget RAM accordingly.
