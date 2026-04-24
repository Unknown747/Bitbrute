# Project Overview

Multi-threaded Node.js CLI scanner that generates deterministic Bitcoin private keys, derives **five address types** per key (P2PKH compressed, P2PKH uncompressed, P2SH-wrapped SegWit, native Bech32 SegWit, and Taproot / P2TR), checks each address against a SharedArrayBuffer-backed bloom filter of known-funded addresses, hits public balance APIs only on bloom matches, scans for vanity-prefix addresses, and persists deterministic scan progress so it can resume across restarts.

Originally a Python script that hit a defunct external balance API on every key. Rewritten in modern ESM Node.js with the architecture below.

## Features

1. **Worker-thread pool with adaptive scaling** — master spawns 2 workers and a 5-second monitor scales up when the device is idle (low event-loop lag, free memory) and scales down when the device is under load (high lag or low memory). Bounded by `scaling.minWorkers` and `scaling.maxWorkers` (default = `os.cpus().length`). Each scale event is logged with the trigger reason. 8-second cooldown between scale changes.
2. **Native-speed ECC via @noble/secp256k1 v2** — pure-JS but heavily optimized. Roughly 3–5× faster than `bitcore-lib` for compressed-pubkey derivation per worker.
3. **5 address types per private key** — P2PKH compressed (`1...`), P2PKH uncompressed (`1...`), P2SH-wrapped SegWit (`3...`), native Bech32 SegWit (`bc1q...`), and Taproot (`bc1p...`, BIP-341 keypath). Each type can be toggled in `config.json`.
4. **SharedArrayBuffer bloom filter** — bloom is built once in master and exposed to workers via a `SharedArrayBuffer`. All workers read the same memory, so a 50M-address bloom (~150 MB) costs the same RAM regardless of worker count. Custom implementation uses SHA-256 + Kirsch-Mitzenmacher derived indices.
5. **Multi-provider balance failover** — bloom matches are queried against `blockstream.info`, then `mempool.space`, then `blockchain.info`. The next provider is tried automatically on rate-limit (HTTP 429), network error, or non-OK status. The last successful provider becomes the default for the next call.
6. **Atomic state writes** — `state.json` is written via `tmp + rename`, so a crash mid-write cannot corrupt the persisted scan state.
7. **Telegram notifications** — optional. Set `telegram.enabled = true` in `config.json` with `botToken` and `chatId`. Notify on `found`, on every `vanity` hit, and/or on every `bloomMatch`.
8. **Deterministic resumable scan** — 32-byte seed plus a counter saved every ~2 seconds and on shutdown. Master tracks completed batch ranges and slides the persisted counter forward only over contiguous prefixes, so resume is always safe with multi-worker out-of-order completion.
9. **Vanity pattern detection** — every address is screened against a configurable list of vanity prefixes (default `1Love`, `1Lucky`, `1Bitcoin`, `1Satoshi`, etc.) and matches are logged to `vanity.txt` regardless of balance.
10. **Streaming address-list loader** — `addresses.txt` (or `addresses.txt.gz`) is read line-by-line via a stream so loading a multi-GB file uses only a few KB of RAM at a time. Gzip is decoded transparently.
11. **Persistent bloom-filter cache** — once built, the bloom is serialized to `addresses.bloom.bin` (small JSON header + raw bits, no compression because random bits are incompressible). Auto-invalidated when source `mtime` changes.
12. **Lazy WIF / hex computation** — WIF and hex private key are encoded inside the worker only when an address triggers a vanity match or bloom hit. Skipped on the 99.99%+ of iterations that produce nothing.

## Project Structure

- `main.js` — master orchestrator: config load, state, worker pool, work distribution, adaptive scaling, hit handling, multi-provider balance lookup, signal handling, atomic state save.
- `worker.js` — per-worker scanner: derives the configured address types per private key, checks each against vanity patterns and the shared bloom filter, posts hits back to master.
- `keys.js` — key/address derivation helpers: `isValidPrivKey`, `deriveEnabled` (returns the enabled subset of 5 address types), `wifEncode`, hex helpers, Taproot tagged-hash tweak. Uses `@noble/secp256k1`, `@noble/hashes`, `bs58check`, `bech32`.
- `bloom.js` — `SabBloom` class (SharedArrayBuffer + SHA-256 hash indices), source detection, cache build/save/load, capacity estimation, legacy cache cleanup.
- `config.js` — loads `config.json` (creates from defaults on first run), deep-merges with built-in defaults so missing keys are backfilled.
- `notify.js` — Telegram `sendMessage` helper with `shouldNotify(config, kind)` filter.
- `get-wallets.js` — utility to download the latest known-funded Bitcoin address list (~500 MB gzipped) into `addresses.txt.gz`. Run with `node get-wallets.js`. Supports `--force`, `--url`, `--out`, `--help`. Auto-invalidates the bloom cache on download.
- `package.json` / `package-lock.json` — Node ESM project (`"type": "module"`).
- `.replit` — Replit configuration.
- `.gitignore` — ignores `node_modules`, runtime state, output files, the bloom cache, address lists, and `config.json` (may contain a Telegram token).
- `README.md` — user-facing setup, usage, configuration, ethics/legality.

## Runtime / Tooling

- Language: Node.js 20+, ESM modules.
- Dependencies: `@noble/secp256k1` (ECC), `@noble/hashes` (SHA-256 + RIPEMD-160), `bs58check` (base58check encoding), `bech32` (bech32 + bech32m).
- HTTP: built-in global `fetch`.
- Balance APIs (in failover order): `blockstream.info`, `mempool.space`, `blockchain.info`.

## Workflows

- `Start application` — runs `node main.js` as a console process. No port; this is a CLI loop, not a web app.

## Runtime Files (gitignored)

- `state.json` — `{ seed, counter, totals }`, written via `tmp + rename` every ~2 seconds and on shutdown.
- `config.json` — user config (Telegram, vanity patterns, scaling, address-type toggles). Auto-created on first run from defaults; gitignored because `botToken` is sensitive.
- `addresses.bloom.bin` — serialized bloom cache (header JSON + raw bits). Deleted automatically when source `mtime` changes.
- `addresses.txt` / `addresses.txt.gz` — source list of known-funded addresses (one per line). Either supply manually or `node get-wallets.js`.
- `found.txt` — actual wallets with balance > 0 (full hex + WIF + balance + provider name).
- `near-miss.txt` — bloom matches that turned out to be zero balance.
- `vanity.txt` — addresses matching a vanity prefix.

## Config (`config.json`)

Created on first run from defaults, then editable. Schema:

```json
{
  "telegram": {
    "enabled": false,
    "botToken": "",
    "chatId": "",
    "notifyOnFound": true,
    "notifyOnVanity": false,
    "notifyOnBloomMatch": false
  },
  "vanityPatterns": ["1Love", "1Lucky", "1Bitcoin", "1Satoshi", "..."],
  "scanning": {
    "batchSize": 2000,
    "addressTypes": {
      "p2pkhComp": true, "p2pkhUncomp": true,
      "p2sh": true, "p2wpkh": true, "p2tr": true
    }
  },
  "scaling": {
    "minWorkers": 1,
    "maxWorkers": null,
    "lagHighMs": 120,
    "lagLowMs": 30,
    "freeMemMin": 0.15,
    "intervalMs": 5000,
    "cooldownMs": 8000
  }
}
```

`maxWorkers: null` means use `os.cpus().length`. Disabling address types in `addressTypes` skips the corresponding derivation cost per key.

## Replit vs. Real Machine

- On Replit (this project): supply a small sample `addresses.txt` to verify the architecture. Hits in this set are statistically impossible from random scanning — for setup verification only.
- On your own machine / VPS: run `node get-wallets.js` (downloads ~500 MB to `addresses.txt.gz` and clears any stale bloom cache). Then `node main.js` — the first start streams the bloom from the gzipped source (~3–5 min for 50M entries on typical hardware) and caches it to `addresses.bloom.bin` (~150 MB raw). Every restart after that is instant. The bloom is in a `SharedArrayBuffer` so RAM cost is independent of worker count.

## User Preferences

- User language: Indonesian.
- User does not want a "Next, I can ..." suggestion footer at the end of agent replies.
