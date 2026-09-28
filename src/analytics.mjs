/**
 * The whole pipeline, for any app: one event in, one projected record out to every
 * recipient the operator chose, each at the tier they chose, each copied locally first.
 *
 * Three rules carried over from the system this was extracted from, because it runs after
 * every action someone takes:
 *
 *   1. NEVER throw and NEVER block the work. Every public method resolves.
 *   2. NEVER send a field nobody declared. The schema is an allowlist; see schema.mjs.
 *   3. The operator's copy exists BEFORE anything leaves. See record.mjs.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EVENT_FIELDS, project } from "./schema.mjs";
import { loadConfig, skillVisible } from "./recipients.mjs";
import { resolveTransport } from "./transports/index.mjs";
import { appendCopy, recordThenSend, recentEvents, recent } from "./record.mjs";
import { defaultAppDir, expandHome } from "./paths.mjs";

const cls = (e) => String((e && e.name) || "Error").slice(0, 64);

export function createAnalytics({
  appDir = defaultAppDir(),
  killEnv = null,
  optOutFile = null,
  schema = DEFAULT_EVENT_FIELDS,
  transports = {},
  from = null,
} = {}) {
  appDir = expandHome(appDir);
  const optOut = expandHome(optOutFile || join(appDir, "no-analytics"));
  const sentDir = (id) => join(appDir, "sent", id);
  const stateFile = (id) => join(appDir, "state", `sharing-${id}.json`);

  /** Why nothing may leave, or null. The env switch exists so a test cannot write to a real recipient. */
  const globalOff = () => {
    if (process.env.SUPERSUIT_ANALYTICS === "off") return "SUPERSUIT_ANALYTICS=off";
    if (killEnv && process.env[killEnv] === "off") return `${killEnv}=off`;
    if (existsSync(optOut)) return `opted out (${optOut} exists)`;
    return null;
  };

  const config = () => loadConfig(appDir);
  const ctxFor = (cfg) => ({ from: cfg.from || from || undefined, schema });

  function status() {
    const cfg = config();
    const off = globalOff();
    return {
      on: !off && cfg.recipients.some((r) => !r.paused),
      reason: off || (cfg.recipients.length ? null : "no recipients"),
      appDir,
      from: ctxFor(cfg).from ?? null,
      errors: cfg.errors,
      recipients: cfg.recipients.map((r) => {
        let describe = r.transport.type;
        try { describe = resolveTransport(r.transport, transports).describe?.() || describe; } catch (e) { describe = `${describe} (${e.message})`; }
        return {
          id: r.id, name: r.name || r.id, tier: r.tier, transport: describe,
          snapshots: !!r.snapshots, skills: r.skills || null, drop: r.drop || [],
          sending: !off && !r.paused, reason: off || (r.paused ? "paused" : null),
        };
      }),
    };
  }

  /** Exactly what one recipient would receive for this event, or null and why not. */
  function preview(id, event) {
    const r = config().recipients.find((x) => x.id === id);
    if (!r) return { record: null, reason: `no recipient "${id}"` };
    if (!skillVisible(r, event?.skill)) return { record: null, reason: `skill "${event.skill}" is hidden from ${id}` };
    return { record: project({ ts: new Date(), ...event }, r, schema), reason: null };
  }

  async function share(event) {
    const results = [];
    try {
      if (globalOff() || !event) return results;
      const cfg = config();
      const ctx = ctxFor(cfg);
      const at = new Date();
      await Promise.all(cfg.recipients.map(async (r) => {
        if (r.paused) return;
        if (!skillVisible(r, event.skill)) { results.push({ id: r.id, sent: false, reason: "skill hidden" }); return; }
        const record = project({ ts: at, ...event }, r, schema);
        if (!Object.keys(record).length) return;
        if (!appendCopy(sentDir(r.id), record, at)) { results.push({ id: r.id, sent: false, reason: "local copy failed" }); return; }
        try {
          const res = await resolveTransport(r.transport, transports).event(record, ctx);
          results.push({ id: r.id, sent: !!res?.sent, reason: res?.sent ? null : (res?.reason || res?.status || "unknown") });
        } catch (e) { results.push({ id: r.id, sent: false, reason: `send threw (${cls(e)})` }); }
      }));
    } catch { /* rule 1 */ }
    return results;
  }

  /**
   * A snapshot goes only to recipients at tier "full" who ALSO set `snapshots: true`.
   * What the snapshot contains is the app's responsibility; this layer only guarantees who
   * gets it and that the operator has the copy first.
   */
  async function snapshot(payload) {
    const results = [];
    try {
      if (globalOff() || !payload) return results;
      const cfg = config();
      const ctx = ctxFor(cfg);
      for (const r of cfg.recipients) {
        if (r.paused || !r.snapshots || r.tier !== "full") continue;
        let t;
        try { t = resolveTransport(r.transport, transports); } catch (e) { results.push({ id: r.id, recorded: false, sent: false, reason: e.message }); continue; }
        if (!t.snapshot) { results.push({ id: r.id, recorded: false, sent: false, reason: "transport takes no snapshots" }); continue; }
        const res = await recordThenSend(payload, { dir: join(sentDir(r.id), "snapshots"), send: (p) => t.snapshot(p, ctx) });
        results.push({ id: r.id, ...res });
      }
    } catch { /* rule 1 */ }
    return results;
  }

  /**
   * One presence line per recipient whenever sharing with them turns off or back on, so a
   * paused operator and one who stopped using the tool do not look identical to the other
   * side. The first sighting reports only "off", since "on" is what every other line says.
   * The env kill switch silences this too; the opt-out file and a pause do not, because
   * saying "I stopped sharing" is the whole point of the line.
   */
  async function announce() {
    const results = [];
    try {
      if (process.env.SUPERSUIT_ANALYTICS === "off" || (killEnv && process.env[killEnv] === "off")) return results;
      const cfg = config();
      const ctx = ctxFor(cfg);
      const off = !!globalOff();
      for (const r of cfg.recipients) {
        const now = off || r.paused ? "off" : "on";
        let last = null;
        try { last = JSON.parse(readFileSync(stateFile(r.id), "utf8")).status; } catch { /* first sighting */ }
        if (last === now) continue;
        const remember = () => {
          try { mkdirSync(join(appDir, "state"), { recursive: true }); writeFileSync(stateFile(r.id), JSON.stringify({ status: now, at: new Date().toISOString() })); } catch {}
        };
        if (!last && now === "on") { remember(); continue; }
        const record = project({ ts: new Date(), kind: `sharing-${now}` }, { tier: "presence" }, schema);
        if (!appendCopy(sentDir(r.id), record)) continue;
        try {
          const res = await resolveTransport(r.transport, transports).event(record, ctx);
          if (res?.sent) remember();
          results.push({ id: r.id, kind: record.kind, sent: !!res?.sent });
        } catch (e) { results.push({ id: r.id, kind: record.kind, sent: false, reason: cls(e) }); }
      }
    } catch { /* rule 1 */ }
    return results;
  }

  /** The operator's copy of what went to one recipient. */
  const sent = (id, { limit = 20 } = {}) => ({
    events: recentEvents(sentDir(id), { limit }),
    snapshots: recent(join(sentDir(id), "snapshots"), { limit: 5 }),
  });

  return { appDir, optOutFile: optOut, status, preview, share, snapshot, announce, sent, config };
}
