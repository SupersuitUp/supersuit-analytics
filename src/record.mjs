/**
 * The operator's copy of everything that leaves the machine, written BEFORE it leaves.
 *
 * The local write is not a log of the send, it is a PRECONDITION of it. A payload with no
 * local copy does not go. `send` is injected rather than imported so that this module owns
 * the ordering and no caller can reach the network without going through the write.
 *
 * Extracted from Freedom's freedom-sent-log.mjs, where it closed a gap between "your copy of
 * everything we could ever receive" as promised and a snapshot that went out unrecorded.
 *
 * Never throws.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const KEEP = 200;
const SNAPSHOT = /^\d{4}-\d{2}-\d{2}-\d{6}\.json$/;

/** `2026-09-15-164415`, sortable as a string, which is what makes the prune a sort. */
export function stamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

const cls = (e) => (e && e.name) || "Error";

/**
 * Record the payload in `dir`, prove the copy reads back intact, then send what the FILE
 * holds. Returns `{ recorded, sent, path, reason }`; recorded and sent are separate facts.
 */
export async function recordThenSend(payload, { dir, send, now = new Date(), onWrite = null, readBack = null, keep = KEEP } = {}) {
  const path = join(dir, `${stamp(now)}.json`);
  let record;
  try {
    mkdirSync(dir, { recursive: true });
    record = { at: now.toISOString(), sent: false, reason: null, payload };
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    if (onWrite) onWrite(path);
  } catch (e) {
    return { recorded: false, sent: false, path: null, reason: `local copy failed (${cls(e)})` };
  }

  let fromDisk;
  try {
    fromDisk = readBack ? readBack(path) : JSON.parse(readFileSync(path, "utf8"));
    if (JSON.stringify(fromDisk.payload) !== JSON.stringify(payload))
      return { recorded: true, sent: false, path, reason: "local copy read back different from what was written" };
  } catch (e) {
    return { recorded: true, sent: false, path, reason: `local copy unreadable (${cls(e)})` };
  }

  let result;
  try { result = await send(fromDisk.payload); }
  catch (e) { result = { sent: false, reason: `send threw (${cls(e)})` }; }

  const sent = !!(result && result.sent);
  const reason = sent ? null : ((result && (result.reason || result.errorClass || result.status)) || "unknown");
  try { writeFileSync(path, JSON.stringify({ ...record, sent, reason }, null, 2) + "\n", { mode: 0o600 }); }
  catch { /* the copy exists; failing to stamp the outcome is not worth losing it */ }
  try { prune(dir, { keep }); } catch { /* never at the cost of the result */ }
  return { recorded: true, sent, path, reason };
}

/** Keep the newest `keep` snapshots. Never touches a file this module did not write. */
export function prune(dir, { keep = KEEP } = {}) {
  let names;
  try { names = readdirSync(dir).filter((n) => SNAPSHOT.test(n)).sort(); } catch { return 0; }
  let n = 0;
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try { unlinkSync(join(dir, name)); n += 1; } catch { /* already gone is fine */ }
  }
  return n;
}

/** The snapshots on disk, newest first. */
export function recent(dir, { limit = 10 } = {}) {
  let names;
  try { names = readdirSync(dir).filter((n) => SNAPSHOT.test(n)).sort().reverse(); } catch { return []; }
  return names.slice(0, limit).map((name) => {
    try { return { name, ...JSON.parse(readFileSync(join(dir, name), "utf8")) }; }
    catch { return { name, unreadable: true }; }
  });
}

/**
 * The event-stream version of the same inversion: append the exact record to a monthly
 * JSONL before it is handed to the transport. Returns false when the copy could not be
 * written, and the caller must then not send.
 */
export function appendCopy(dir, record, now = new Date()) {
  try {
    mkdirSync(dir, { recursive: true });
    // The operator's local month, not UTC's: a line written late on the 31st belongs to the
    // month they were living in when they wrote it.
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    appendFileSync(join(dir, `${month}.jsonl`), JSON.stringify(record) + "\n", { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** The event copies, newest last, across months. */
export function recentEvents(dir, { limit = 20 } = {}) {
  let files;
  try { files = readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const f of files.reverse()) {
    let lines;
    try { lines = readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean); } catch { continue; }
    for (const l of lines.reverse()) {
      try { out.push(JSON.parse(l)); } catch { /* a torn line is skipped */ }
      if (out.length >= limit) return out.reverse();
    }
  }
  return out.reverse();
}
