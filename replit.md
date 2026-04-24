# Project Overview

A Node.js command-line scanner that generates Bitcoin private keys, derives the corresponding P2PKH (legacy) address, and looks for matches against a local bloom filter of known-funded addresses, with vanity-pattern detection and resumable deterministic state.

Originally a Python script (`main.py`) that hit a defunct external balance API on every key. Rewritten in JavaScript with the following improvements.

## Features

1. **Bloom filter pre-check** — addresses are checked in-memory against `addresses.txt` first. The remote balance API is only hit when the bloom filter reports a possible match, drastically reducing API load and pushing throughput to ~1000+ keys/second (vs. ~30/min on API-per-key).
2. **WIF in every record** — any vanity hit, bloom match, or actual found wallet is logged with both raw hex private key and Wallet Import Format (importable directly into Electrum / Bitcoin Core / etc.).
3. **Deterministic resumable scan** — a 32-byte seed plus a counter are saved to `state.json` every 1000 iterations. On restart, the scan resumes from the saved counter using the same seed, so no work is repeated.
4. **Vanity pattern detection** — every address is screened against a list of vanity prefixes (e.g. `1Love`, `1Lucky`, `1Bitcoin`, `1Satoshi`, etc.) and matches are logged to `vanity.txt` regardless of balance.

## Project Structure

- `main.js` — main loop: state, bloom filter, key derivation, vanity, balance lookup.
- `addresses.txt` — sample (~15) of well-known Bitcoin addresses for the bloom filter. **Replace with the real ~50M-address dump (~1.5 GB) on a real machine / VPS** — see header comment in the file for the source URL.
- `package.json` / `package-lock.json` — Node project / dependency lockfile.
- `.replit` — Replit configuration.
- `.gitignore` — ignores `node_modules`, runtime state, and output files.

## Runtime / Tooling

- Language: Node.js 20
- Dependencies: `bitcore-lib` (Bitcoin keys & addresses), `bloom-filters` (probabilistic membership test)
- HTTP: built-in global `fetch`
- Balance API: `https://blockstream.info/api/address/<address>` (replaces the defunct `webbtc.com` endpoint used by the original Python version)

## Workflows

- `Start application` — runs `node main.js` as a console process. No port; this is a CLI loop, not a web app.

## Runtime Files (gitignored)

- `state.json` — `{ seed, counter }`, written every 1000 iterations.
- `found.txt` — actual wallets with balance > 0 (full hex + WIF + balance).
- `near-miss.txt` — bloom-filter matches that turned out to have zero balance (still saved with WIF, in case the address is interesting).
- `vanity.txt` — addresses matching a vanity prefix.

## Replit vs. Real Machine

- On Replit (this project): `addresses.txt` ships with ~15 famous addresses just to demonstrate the bloom-filter architecture. Hits in this set are statistically impossible from random scanning — it is for setup verification only.
- On your own machine / VPS: download the full known-funded-address list (e.g. from `http://addresses.loyce.club/`), gunzip it, and save as `addresses.txt`. The bloom filter will rebuild automatically on next start with realistic coverage (~50M entries, ~50–100 MB RAM).

## Notes

- No frontend, no backend server, no database. Pure CLI script — therefore no port binding and no deployment configuration.
- To reset progress, delete `state.json`.
- To change vanity patterns, edit `VANITY_PATTERNS` in `main.js`.
