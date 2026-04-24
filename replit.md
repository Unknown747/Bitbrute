# Project Overview

A Node.js command-line script (`main.js`) that generates random Bitcoin private keys, derives the corresponding public key and address (P2PKH / legacy), and queries the Blockstream public API for the wallet balance. Originally a Python script (`main.py`); rewritten in JavaScript and the broken external API was replaced.

## Project Structure

- `main.js` — Node.js script: key generation, address derivation, balance lookup, main loop.
- `package.json` / `package-lock.json` — Node project / dependency lockfile.
- `.replit` — Replit configuration.
- `.gitignore` — ignores `node_modules`, build artifacts, and `bitforce-found.txt`.

## Runtime / Tooling

- Language: Node.js 20
- Dependency: `bitcore-lib` (Bitcoin key & address handling)
- HTTP: built-in global `fetch`
- Balance API: `https://blockstream.info/api/address/<address>` (replaces the defunct `webbtc.com` endpoint used by the original Python version)

## Workflows

- `Start application` — runs `node main.js` as a console process. No port; this is a CLI loop, not a web app.

## Behavior

- Generates a random private key, prints its address with balance `0` for each iteration (the overwhelming common case).
- If a non-zero balance is ever found, the full record (address, hex private key, WIF, uncompressed public key, balance in satoshis) is printed and appended to `bitforce-found.txt`.
- Handles HTTP 429 (rate-limit) and other errors with sleep-and-retry.

## Notes

- No frontend, no backend server, no database. Pure CLI script — therefore no port binding and no deployment configuration.
