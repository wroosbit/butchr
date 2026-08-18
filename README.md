# Butchr

Chrome Extension & Agent Pairing Architecture for Herdr.

- **[docs/SETUP.md](docs/SETUP.md)** — install it: clone to a working agent, on Linux.
- [docs/butchr.md](docs/butchr.md) — full specifications.
- [docs/env-knobs.md](docs/env-knobs.md) — every `BUTCHR_*` environment variable
  the daemon reads, what it does, and what it defaults to.
- [docs/staleness.md](docs/staleness.md) — why a merged PR does nothing until you
  pull, rebuild and reload, and how Butchr tells you when you have not.

Already installed? `node daemon/scripts/butchr-doctor.mjs` says whether it still works.
