# Project Overview

A Node.js command-line scanner that generates Bitcoin private keys, derives the corresponding P2PKH (legacy) address, checks the address against a local bloom filter of known-funded addresses, hits a public balance API only on bloom matches, scans for vanity-prefix addresses, and persists deterministic scan progress so it can resume across restarts.

Originally a Python script (`main.py`) that hit a defunct external balance API on every key. Rewritten in JavaScript with the following improvements.

## Features

1. **Bloom filter pre-check** — addresses are checked in-memory against a bloom filter built from `addresses.txt` (or `addresses.txt.gz`). The remote balance API is only queried when the bloom filter reports a possible match. Throughput on Replit demo is ~1000+ keys/s vs. ~30/min on API-per-key.
2. **WIF in every record** — any vanity hit, bloom match, or actual found wallet is logged with both raw hex private key and Wallet Import Format (importable directly into Electrum / Bitcoin Core / etc.).
3. **Deterministic resumable scan** — a 32-byte seed plus a counter are saved to `state.json` every 1000 iterations. On restart, the scan resumes from the saved counter using the same seed; no key is rescanned.
4. **Vanity pattern detection** — every address is screened against a list of vanity prefixes (e.g. `1Love`, `1Lucky`, `1Bitcoin`, `1Satoshi`) and matches are logged to `vanity.txt` regardless of balance.
5. **Streaming address-list loader** — `addresses.txt` is read line-by-line via a stream so loading a 1.5 GB file uses only a few KB of RAM at any time, never the full file. Works transparently with gzipped input (`addresses.txt.gz`) — no manual unzip needed.
6. **Persistent bloom-filter cache** — once the bloom filter is built, it is serialized and gzipped to `addresses.bloom.gz`. Subsequent restarts load the cache instantly and skip re-reading the source list. The cache is invalidated automatically if the source file's modification time changes.
7. **Pre-sized filter + progress + event-loop yielding** — the bloom filter is sized from the source file size (no need to count lines first). During build, progress is printed every 1M lines and the event loop yields every 50k lines so the process stays responsive.

## Project Structure

- `main.js` — main loop: state, bloom filter (load/build/cache), key derivation, vanity, balance lookup.
- `get-wallets.js` — utility to download the latest known-funded Bitcoin address list (~500 MB gzipped) into `addresses.txt.gz`. Run with `node get-wallets.js`. Supports `--force`, `--url`, `--out`, `--help`. After download it auto-invalidates the bloom cache so the next `main.js` run rebuilds.
- `addresses.txt` — sample (~15) of well-known Bitcoin addresses for the bloom filter on Replit. **Replace with the real ~50M-address dump on a real machine / VPS** — easiest way is to run `node get-wallets.js`.
- `package.json` / `package-lock.json` — Node project / dependency lockfile.
- `.replit` — Replit configuration.
- `.gitignore` — ignores `node_modules`, runtime state, output files, and the bloom cache.

## Runtime / Tooling

- Language: Node.js 20
- Dependencies: `bitcore-lib` (Bitcoin keys & addresses), `bloom-filters` (probabilistic membership test)
- HTTP: built-in global `fetch`
- Balance API: `https://blockstream.info/api/address/<address>` (replaces the defunct `webbtc.com` endpoint used by the original Python version)

## Workflows

- `Start application` — runs `node main.js` as a console process. No port; this is a CLI loop, not a web app.

## Runtime Files (gitignored)

- `state.json` — `{ seed, counter }`, written every 1000 iterations.
- `addresses.bloom.gz` — gzipped serialized bloom filter (auto-generated; deleted means rebuild on next start).
- `addresses.txt.gz` — optional gzipped source list (preferred for large dumps).
- `found.txt` — actual wallets with balance > 0 (full hex + WIF + balance).
- `near-miss.txt` — bloom matches that turned out to be zero balance (still saved with WIF).
- `vanity.txt` — addresses matching a vanity prefix.

## Replit vs. Real Machine

- On Replit (this project): `addresses.txt` ships with ~15 famous addresses just to demonstrate the bloom-filter architecture. Hits in this set are statistically impossible from random scanning — it is for setup verification only.
- On your own machine / VPS: just run `node get-wallets.js`. That fetches the latest list from `http://addresses.loyce.club/` directly to `addresses.txt.gz` (gzipped, ~500 MB) and clears the old bloom cache. Then run `node main.js` — the first start will stream-build the bloom filter (~3–5 min for 50M entries on typical hardware) and cache it to `addresses.bloom.gz` (~150 MB). Every restart after that is instant.

## Notes

- No frontend, no backend server, no database. Pure CLI script — therefore no port binding and no deployment configuration.
- To reset progress, delete `state.json`.
- To force a bloom-filter rebuild, delete `addresses.bloom.gz` (or update `addresses.txt`).
- To change vanity patterns, edit `VANITY_PATTERNS` in `main.js`.
