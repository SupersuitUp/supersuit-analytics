import { appendFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "../paths.mjs";

/**
 * Append each record as one JSON line. Snapshots overwrite `<path minus .jsonl>.snapshot.json`,
 * because a snapshot is "what is true now", not a history.
 */
export function fileTransport(spec) {
  if (!spec.path) throw new Error("file transport needs a path");
  const path = expandHome(spec.path);
  const snapPath = path.replace(/\.jsonl$/, "") + ".snapshot.json";
  return {
    describe: () => `file ${spec.path}`,
    async event(record, ctx) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ from: ctx.from, ...record }) + "\n");
      return { sent: true };
    },
    async snapshot(payload, ctx) {
      mkdirSync(dirname(snapPath), { recursive: true });
      const tmp = `${snapPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ from: ctx.from, at: new Date().toISOString(), payload }, null, 2) + "\n");
      renameSync(tmp, snapPath);
      return { sent: true };
    },
  };
}
