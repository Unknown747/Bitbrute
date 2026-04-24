# Project Overview

A Python command-line script (`main.py`) that generates random Bitcoin private keys, derives the corresponding public key and address, and queries an external API to look up the wallet balance.

## Project Structure

- `main.py` — single-file Python script containing all logic (key generation, address derivation, balance lookup, main loop).
- `pyproject.toml` / `uv.lock` — Python project / dependency lockfile (managed by `uv`).
- `.replit` — Replit configuration (Python 3.12, NixOS stable-25_05).

## Runtime / Tooling

- Language: Python 3.12
- Dependencies: `bit`, `ecdsa`, `requests` (with transitive deps `coincurve`, `certifi`, `urllib3`, etc.)
- Package manager: `uv` (managed automatically by Replit's package tooling)

## Workflows

- `Start application` — runs `python main.py` as a console process (no port; this is a CLI script, not a web app).

## Known Issues

- The script calls `http://webbtc.com/address/<addr>.json` for balance lookups. That endpoint appears to be offline / no longer returning JSON, which causes a `JSONDecodeError` at runtime. This is an upstream third-party issue in the original code and is unrelated to the Replit environment setup.

## Notes

- No frontend, no backend server, no database. Pure CLI script — therefore no port binding and no deployment configuration.
