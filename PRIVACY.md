# Privacy posture

This page describes what the code enforces. The tests in `test/analytics.test.mjs` fail if
any of it stops being true.

## What can leave

Only fields declared in the schema can leave, and each one is capped. The defaults:

| Field | Type | Tier |
|---|---|---|
| `ts` | timestamp | presence |
| `kind` | string, ≤32 | presence |
| `skill` | string, ≤64 | usage |
| `ok` | bool | usage |
| `durationMs`, `seq`, `turns`, `activeMs` | int ≥ 0 | usage |
| `errorClass` | string, ≤64 (the class, never the message) | usage |
| `session` | string, ≤40 | usage |
| `version` | string, ≤32 | usage |
| `os` | string, ≤64 | full |
| `tzOffset` | int | full |
| `workspace` | string, ≤16 (a hash, via `hashId`) | full |

An app can add fields with `defineSchema`. A string field must have a cap or an enum,
because otherwise it can carry a whole sentence. A value of the wrong type is dropped rather
than coerced into something it was not.

## What never leaves

Any field that was not declared. That covers prompts, arguments, output, file paths,
message text and error messages, unless an app deliberately declares a field for one of
them. A reviewer should reject a schema that does.

## Who decides

The operator does, one recipient at a time, in `recipients.json`, a file they own. The
controls are:

- the recipient's tier
- a list of skills to hide or allow
- a list of fields to drop
- whether snapshots go at all (full tier only)
- a pause switch per recipient
- a global off switch

## The operator's copy

- **Events.** Each event is appended to `<appDir>/sent/<recipient>/<YYYY-MM>.jsonl` before it
  is handed to the transport.
- **Snapshots.** Each snapshot is written to `<appDir>/sent/<recipient>/snapshots/`, read back,
  and only the bytes on disk are sent.
- **Failures.** If the local write fails, nothing is sent.
- **Opting out.** A recipient who is paused or opted out gets a single line, `sharing-off`, so
  they can tell a pause apart from someone who stopped using the tool. That line says nothing
  else. `SUPERSUIT_ANALYTICS=off` silences it too.

## Snapshots

A snapshot is whatever the app puts in it. This package guarantees who receives one (only
full-tier recipients who opted in) and that the operator's copy exists first. It does not
guarantee what the snapshot contains. For names, use `scrub`, and for labels, use `closed`.
