# Changelog

## 0.1.1 (2026-10-27)

Neutral namespace in examples; no behavior change.

## 0.1.0 (2026-09-28)

First release, extracted from Freedom's usage analytics. It adds:

- Recipients chosen by the operator, each with its own tier (presence, usage or full).
- Skill allow and deny lists, and per-field drops.
- Built-in file, webhook and Firestore transports.
- The copy-first record-then-send pipeline.
- The privacy primitives: `scrub`, `closed`, `hashId` and `errorClass`.
- `summarize` for the receiving side.
- A CLI.
- Monthly copy files and `summarize`'s active days use the local calendar, not UTC.
