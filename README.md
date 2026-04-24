# btc-key-scanner

Multi-threaded Node.js CLI that brute-scans deterministic Bitcoin private keys, derives **five address types** per key (legacy compressed/uncompressed, P2SH-SegWit, native SegWit, Taproot), and pre-filters every address against a local SharedArrayBuffer-backed bloom filter of known-funded addresses before ever touching a remote balance API.

> **Educational / research use only.** Brute-forcing real Bitcoin keys is mathematically futile — the keyspace is 2²⁵⁶. The probability of finding any funded address by random search is, for all practical purposes, zero. This project exists as an architecture exercise (worker-thread pool, shared-memory bloom filter, BIP-341 Taproot derivation, multi-provider failover) and as a vanity-address generator. **Do not use it expecting to find money.** Do not use it to attack any wallet you do not own.

---

## Features

- **5 address types per key** — P2PKH (`1...`, both compressed and uncompressed pubkey forms), P2SH-SegWit (`3...`), native SegWit Bech32 (`bc1q...`), and Taproot Bech32m (`bc1p...`, BIP-341 keypath). Each type is individually toggleable.
- **Adaptive worker pool** — starts with 2 workers, scales up when the host is idle (low event-loop lag, free memory), scales down when the host is under load. Bounded by CPU count.
- **SharedArrayBuffer bloom filter** — built once in the master, all workers read the same memory. A 50M-address bloom costs ~150 MB regardless of worker count.
- **Multi-provider balance failover** — `blockstream.info` → `mempool.space` → `blockchain.info`. Auto-rotates on rate limits or errors.
- **Telegram notifications** — optional. Ping your phone the moment a hit lands. Configurable per event type (found / vanity / bloom-match).
- **Deterministic resumable scan** — `state.json` persists a 32-byte seed and a counter; `tmp + rename` write makes it crash-safe.
- **Vanity prefix scanner** — match user-defined prefixes (`1Love`, `1Bitcoin`, `1Satoshi`, …) regardless of balance.
- **Lazy hot path** — WIF and hex private-key encoding only happen on actual hits; the hot loop only does ECC + hashing + bloom lookup.

## Requirements

- Node.js **20 or newer** (uses global `fetch`, `SharedArrayBuffer`, ESM).
- ~150 MB RAM if you use the full address dump.
- Outbound HTTPS to the balance providers (only used on bloom matches).

## Install

```bash
git clone <your-fork-url>
cd btc-key-scanner
npm install
```

## Quick start

```bash
# 1. Provide a list of known-funded Bitcoin addresses
#    (one per line, plain text or gzip).
#    Easiest:
node get-wallets.js                    # downloads ~500 MB to addresses.txt.gz

#    Or supply your own:
echo "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" > addresses.txt

# 2. Run the scanner
node main.js
```

First run:

1. Creates `config.json` with default settings (Telegram disabled).
2. Streams `addresses.txt` / `addresses.txt.gz` and builds the bloom filter.
3. Caches the bloom to `addresses.bloom.bin` (next start is instant).
4. Spawns 2 workers, then auto-scales based on load.

Stop with **Ctrl-C**. The scan resumes from the saved counter on next start.

## Output files

| File | Contents |
|---|---|
| `state.json` | seed + counter + lifetime totals (atomic write) |
| `vanity.txt` | every address matching a vanity prefix |
| `near-miss.txt` | bloom matches that turned out to have zero balance (false positives + spent wallets) |
| `found.txt` | bloom matches confirmed by a balance API to have **balance > 0** |

Every record includes the raw hex private key, the WIF (matching the address type's compression flag), and the address type label.

## Configuration (`config.json`)

`config.json` is created on first run with defaults and gitignored (because the Telegram token is sensitive). Schema:

```jsonc
{
  "telegram": {
    "enabled": false,
    "botToken": "",            // from @BotFather
    "chatId": "",              // your chat id (string or number)
    "notifyOnFound": true,     // ping when balance > 0
    "notifyOnVanity": false,   // ping on every vanity hit
    "notifyOnBloomMatch": false // ping on every bloom hit (incl. false positives)
  },

  "vanityPatterns": [
    "1Love", "1Lucky", "1Bitcoin", "1Satoshi", "1Crypto",
    "1Money", "1Cash", "1Boss", "1ABCD", "1Free"
  ],

  "scanning": {
    "batchSize": 2000,                   // keys per worker batch
    "addressTypes": {                    // disable to skip per-key cost
      "p2pkhComp":    true,
      "p2pkhUncomp":  true,              // costs an extra ECC op per key
      "p2sh":         true,
      "p2wpkh":       true,
      "p2tr":         true               // costs one Taproot tweak per key
    }
  },

  "scaling": {
    "minWorkers":  1,
    "maxWorkers":  null,                 // null = os.cpus().length
    "lagHighMs":   120,                  // event-loop lag → scale down
    "lagLowMs":    30,                   // event-loop lag → scale up
    "freeMemMin":  0.15,                 // <15% free → scale down
    "intervalMs":  5000,                 // scaling decision interval
    "cooldownMs":  8000                  // min time between scale events
  }
}
```

### Telegram setup

1. In Telegram, message **@BotFather**, `/newbot`, follow prompts, copy the token.
2. Message your new bot once (any text).
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser, copy `chat.id` from the JSON.
4. Set `enabled: true`, paste `botToken` and `chatId` into `config.json`. Restart.

A `[FOUND]` event will look like:

```
🚨 FOUND (blockstream)
Type: p2wpkh
Balance: 12345 sat
Address: bc1q...
WIF: L1...
Key: 7f3a...
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  main.js  (master)                                          │
│  ─ loads config.json                                        │
│  ─ loads / builds bloom into a SharedArrayBuffer            │
│  ─ atomic state.json save (tmp + rename)                    │
│  ─ spawns N workers, dispatches counter ranges              │
│  ─ adaptive scaling: lag + memory monitor every 5s          │
│  ─ on bloom-match: queries blockstream → mempool → bc.info  │
│  ─ on found: writes found.txt + Telegram                    │
└─────────────────────────────────────────────────────────────┘
                           │ workerData: { sab, m, k, ... }
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  worker.js  (× N)                                           │
│  ─ deriveKey(counter) = sha256(seed || u64BE(counter))      │
│  ─ derive enabled address types via @noble/secp256k1        │
│  ─ check vanity prefix + bloom.has(addr) for each address   │
│  ─ on hit: lazy-encode WIF + hex, post back to master       │
└─────────────────────────────────────────────────────────────┘
```

### Bloom filter

Custom implementation in `bloom.js`:

- `m` (bit array size) sized from source file size with conservative 1.2× headroom and `fp_rate = 1e-4`.
- `k` (hash count) chosen as `(m / n) * ln(2)`, rounded.
- Indices via Kirsch-Mitzenmacher: `g_i(x) = (h1 + i·h2) mod m` where `h1`/`h2` are the first 8 bytes of `SHA256(x)`.
- Bits live in a `SharedArrayBuffer`. Master builds (writes) before workers start; workers only read. The `postMessage` for the scan command provides the necessary memory-ordering barrier — no `Atomics` needed.
- Cache file `addresses.bloom.bin` layout: `[uint32 BE header length][JSON header][raw bit bytes]`.

### Resumable counter

`deriveKey(counter) = SHA-256(seed || u64BE(counter))`, where `seed` is a per-installation 32-byte random and `counter` starts at 0 and increments. Master tracks completed batches in a Map keyed by `startCounter`; the persisted `state.json:counter` advances only over the contiguous-completed prefix, so out-of-order worker completions never produce a "skipped" range.

### Taproot (P2TR)

Implements BIP-341 keypath-only:

```
xOnly       = compressedPub[1..33]
P_internal  = lift(xOnly, evenY=true)
tweak       = SHA256(SHA256("TapTweak") || SHA256("TapTweak") || xOnly) mod n
Q           = P_internal + tweak·G          // via noble multiplyAndAddUnsafe
witness_pgm = Q.x   (32 bytes, x-only)
address     = bech32m("bc", witver=1, witness_pgm)
```

The logged WIF is the standard compressed key for the *internal* pubkey. To spend, your wallet must reapply the BIP-341 tweak — Sparrow, Electrum, and Bitcoin Core 22+ do this automatically when you import the WIF as a Taproot output.

## Performance

Reference figures from an 8-core dev container, 5 address types enabled, sample bloom:

| Metric | Value |
|---|---:|
| Keys/sec at 6 workers | ~3,200 |
| Addresses checked/sec | ~16,400 |
| Per-key cost | 1× compressed pub + 1× uncompressed pub + 1× Taproot tweak + 5× hash160/bech32/base58 + 5× bloom lookup |
| Bloom RAM (full 50M dump) | ~150 MB total (shared across all workers) |

A real address dump (~50M entries) builds in 3–5 min on first run; subsequent starts are instant from the cache file.

## Disabling address types for speed

If you only care about modern wallets, disable the legacy types:

```jsonc
"addressTypes": {
  "p2pkhComp":   false,
  "p2pkhUncomp": false,    // skips one full pubkey derivation
  "p2sh":        false,
  "p2wpkh":      true,
  "p2tr":        true
}
```

Disabling `p2pkhUncomp` alone saves ~30% per key (one full ECC scalar mult).

## CLI helpers

```bash
node get-wallets.js               # download ~500 MB known-funded list
node get-wallets.js --force       # re-download
node get-wallets.js --url <url>   # custom source
node get-wallets.js --out <file>  # custom output path
```

After download, `main.js` will rebuild the bloom on its next start.

## Ethics & legality

- This tool reads only public APIs and your own machine. It does not "hack" anything.
- The scan is **statistically guaranteed not to find** any funded wallet via brute-force. The math is the security.
- Treat any apparent "hit" with extreme suspicion — it is overwhelmingly likely to be a bloom false-positive (~1 in 10,000 by default) or a wallet that was funded long ago and emptied.
- Do not run this against keyspaces seeded from non-random sources (e.g. brain wallets, leaked wordlists) without the wallet owner's permission. Doing so may be illegal in your jurisdiction.
- The author of this project is not responsible for misuse.

## License

MIT
