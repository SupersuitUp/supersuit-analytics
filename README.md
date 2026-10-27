# @supersuit/analytics

Share how you use your agent setup (your supersuit) with whoever you choose: a teammate, your
company, a community, anyone. You pick how much each one sees. Your own copy of everything is
written before anything leaves your machine. No dependencies. Needs Node 20 or later.

It was extracted from the usage analytics in [Supersuit](https://wiki.supersuit.co). In Supersuit
the recipient was fixed to one backend. Here you pick the recipients.

**It is not published to npm.** Supersuit ships its own vendored copy (`scripts/vendor-supersuit-analytics.mjs` in Supersuit
copies it from this repository), so nothing installs it from a registry. To run it on its own, clone this repository and
call the CLI with Node. Version 0.1.0 on npm (2026-09-28) is the only published release and is not maintained.

## 30 seconds

```bash
node bin/supersuit-analytics.mjs from gary
node bin/supersuit-analytics.mjs add wilson --tier usage --file ~/Dropbox/shared/gary.jsonl --deny "personal:*"
node bin/supersuit-analytics.mjs preview wilson      # the exact record Wilson would get
```

Wilson reads the shared file back:

```bash
node bin/supersuit-analytics.mjs summarize ~/Dropbox/shared/gary.jsonl
```

```
gary: 212 events on 19 days, 41 sessions, ~63.5h active, 96% of skill runs ok
    38  freedom:save-my-progress
    21  cw:ship-freedom
    ...
```

A file is enough to share usage. Anything that syncs a folder (a git repo, Dropbox, iCloud)
carries it, so there is no server to run. You can also send records to a webhook or to
Firestore.

## Privacy tiers

Each recipient gets exactly one tier.

| Tier | What they learn |
|---|---|
| `presence` | That you used it, and when. Nothing about what you did. |
| `usage` | The above, plus which skill ran, whether it worked, how long it took, the error *class*, and session counts. |
| `full` | The above, plus OS, timezone and a hashed workspace id. Snapshots too, but only if you also pass `--snapshots`. |

You can narrow any tier further:

- `--deny "personal:*,freedom:read-messages"` never mentions those skills. A trailing `*` covers a whole namespace.
- `--allow "cw:*"` limits the recipient to the listed skills and nothing else.
- `--drop errorClass` removes one field the tier would otherwise send.

The schema is an allowlist, and a field nobody declared never leaves. The full rules are in
[PRIVACY.md](PRIVACY.md).

## Commands

| Command | What it does |
|---|---|
| `status` | Lists each recipient, its tier and transport, and whether it is sending. |
| `add <id> --tier T (--file P \| --webhook URL [--token-env VAR])` | Starts sharing with someone. Accepts `--name`, `--deny`, `--allow`, `--drop` and `--snapshots`. |
| `remove <id>`, `pause <id>`, `resume <id>` | Stops sharing with one recipient for good, or for now. |
| `off`, `on` | Stops or restarts all sharing. Your local copies stay either way. |
| `from <label>` | Sets the name recipients see you as. |
| `preview <id> [--event JSON]` | Shows the exact record that recipient would receive. |
| `sent <id>` | Shows your copy of what already went to them. |
| `emit [--detach]` | Reads one JSON event on stdin and shares it. Always exits 0, for hooks. |
| `summarize <file.jsonl> [--days N]` | For the recipient: reads a shared file as a picture of how someone works. |

Every command takes `--app-dir` and `--json`. The config lives in
`~/.supersuit/analytics/recipients.json`, or in `$SUPERSUIT_ANALYTICS_DIR` if set. The config
never holds a secret: a webhook token is read from the env var named by `--token-env`.

Exit codes: 0 means ok, 1 means the command was refused, 2 means a usage error.
`SUPERSUIT_ANALYTICS=off` silences everything.

## Hook it into Claude Code

```json
{ "hooks": { "PostToolUse": [{ "matcher": "Skill", "hooks": [{ "type": "command",
  "command": "jq -c '{skill: .tool_input.skill, ok: true}' | supersuit-analytics emit --detach" }] }] } }
```

## As a library

```js
import { createAnalytics, defineSchema } from "@supersuit/analytics";

const analytics = createAnalytics({
  appDir: "~/.myapp",            // recipients.json, local copies, state
  killEnv: "MYAPP_ANALYTICS",    // MYAPP_ANALYTICS=off silences everything
  schema: defineSchema({          // extend the default event fields
    recAnswer: { type: "string", enum: ["now", "later", "declined"], tier: "usage" },
  }),
  transports: { mine: (spec) => ({ event: async (record) => ({ sent: true }) }) },
});

await analytics.share({ skill: "my:skill", ok: true, durationMs: 812 });  // never throws
await analytics.snapshot({ schema: 1, projects: 4 });  // only full-tier recipients with snapshots on
analytics.preview("wilson", { skill: "my:skill" });   // exactly what they would get
await analytics.announce();  // tells a recipient once when you pause or resume them
```

These exports are also available on their own: `recordThenSend`, `project`, `scrub`,
`closed`, `hashId`, `errorClass` and `summarize`.

## The rules it keeps

1. **It never throws or blocks your work.** Every public method resolves.
2. **It never sends a field nobody declared.**
3. **Your copy comes first.** A record that could not be written locally is not sent.
