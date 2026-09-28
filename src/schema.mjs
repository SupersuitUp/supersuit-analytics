/**
 * What a recipient is allowed to learn, declared once.
 *
 * Every field that can ever leave the machine is named here with a type, a cap and a TIER.
 * A recipient is given a tier, and `project()` hands it exactly the fields at or below that
 * tier. Anything not declared is dropped, never passed through: an allowlist is the only
 * shape where forgetting to update it fails closed.
 *
 * The three tiers are the privacy configurations:
 *
 *   presence  that you are using it, and when. Nothing about what.
 *   usage     which skills ran, whether they worked, how long, how busy a session was.
 *   full      usage plus the machine context (os, timezone, hashed workspace id), and
 *             snapshots if the recipient also opted into them.
 */
export const TIERS = ["presence", "usage", "full"];

export const tierRank = (t) => {
  const i = TIERS.indexOf(t);
  if (i < 0) throw new Error(`unknown tier "${t}" (one of ${TIERS.join(", ")})`);
  return i;
};

/** The default event schema. An app extends it rather than replacing it. */
export const DEFAULT_EVENT_FIELDS = {
  ts: { type: "timestamp", tier: "presence" },
  kind: { type: "string", max: 32, tier: "presence" },
  skill: { type: "string", max: 64, tier: "usage" },
  ok: { type: "bool", tier: "usage" },
  durationMs: { type: "int", min: 0, tier: "usage" },
  // The CLASS of an error, never its message: a message quotes filenames and people.
  errorClass: { type: "string", max: 64, tier: "usage" },
  session: { type: "string", max: 40, tier: "usage" },
  seq: { type: "int", min: 0, tier: "usage" },
  turns: { type: "int", min: 0, tier: "usage" },
  activeMs: { type: "int", min: 0, tier: "usage" },
  version: { type: "string", max: 32, tier: "usage" },
  os: { type: "string", max: 64, tier: "full" },
  tzOffset: { type: "int", tier: "full" },
  workspace: { type: "string", max: 16, tier: "full" },
};

const TYPES = new Set(["string", "int", "bool", "timestamp"]);

/** Refuse a malformed schema at startup rather than dropping fields silently forever. */
export function defineSchema(fields = {}) {
  const out = { ...DEFAULT_EVENT_FIELDS };
  for (const [name, spec] of Object.entries(fields)) {
    if (!spec || !TYPES.has(spec.type)) throw new Error(`field "${name}": type must be one of ${[...TYPES].join(", ")}`);
    tierRank(spec.tier);
    if (spec.type === "string" && !(spec.max > 0) && !spec.enum)
      throw new Error(`field "${name}": a string needs a max or an enum, or it can carry a sentence`);
    out[name] = { ...spec };
  }
  return Object.freeze(out);
}

function coerce(value, spec) {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string" && typeof value !== "number") return undefined;
      const s = String(value);
      if (spec.enum) return spec.enum.includes(s) ? s : undefined;
      return s.slice(0, spec.max);
    }
    case "int": {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      const r = Math.round(n);
      return spec.min !== undefined ? Math.max(spec.min, r) : r;
    }
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "timestamp": {
      const d = value instanceof Date ? value : new Date(value);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
  }
  return undefined;
}

/**
 * The record one recipient receives. Unknown fields, fields above the tier, fields the
 * recipient dropped, and values that fail their type are all removed. Never throws.
 */
export function project(event, { tier = "usage", drop = [] } = {}, schema = DEFAULT_EVENT_FIELDS) {
  const max = tierRank(tier);
  const dropped = new Set(drop);
  const out = {};
  for (const [name, spec] of Object.entries(schema)) {
    if (dropped.has(name) || tierRank(spec.tier) > max) continue;
    if (event == null || event[name] === undefined || event[name] === null) continue;
    const v = coerce(event[name], spec);
    if (v !== undefined) out[name] = v;
  }
  return out;
}
