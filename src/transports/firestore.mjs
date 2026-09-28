/**
 * Firestore over REST, authenticated as a Firebase user by a refresh token.
 *
 * The credential lives in `authFile` (mode 0600, written by whatever login flow the app
 * has): `{ account, refreshToken, apiKey, project }`. `project` and `apiKey` may also sit on
 * the spec. Events append to `collection`; snapshots upsert `snapshotCollection/{account}`.
 * Each record carries `account`, which is what server rules match against the caller.
 *
 * The ID token is cached next to the auth file for its hour, so the common path is one
 * network call: the write.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { expandHome } from "../paths.mjs";

const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

async function idToken(auth, cachePath) {
  const cached = read(cachePath);
  if (cached?.token && cached.exp > Date.now() + 60_000 && cached.account === auth.account) return cached.token;
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${auth.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.id_token) return null;
  try {
    writeFileSync(cachePath, JSON.stringify({ token: d.id_token, account: auth.account, exp: Date.now() + Number(d.expires_in || 3600) * 1000 }), { mode: 0o600 });
  } catch { /* an optimisation, never a requirement */ }
  return d.id_token;
}

/** Typed Firestore values, driven by the schema so a count never arrives as a string. */
export function encodeFields(record, schema = {}) {
  const f = {};
  for (const [k, v] of Object.entries(record)) {
    const type = schema[k]?.type;
    if (type === "timestamp") f[k] = { timestampValue: v };
    else if (type === "int" || (type === undefined && Number.isInteger(v))) f[k] = { integerValue: String(v) };
    else if (type === "bool" || typeof v === "boolean") f[k] = { booleanValue: !!v };
    else f[k] = { stringValue: String(v) };
  }
  return f;
}

export function firestoreTransport(spec) {
  if (!spec.authFile) throw new Error("firestore transport needs an authFile holding the refresh token");
  const authFile = expandHome(spec.authFile);
  const cachePath = expandHome(spec.tokenCache || authFile.replace(/\.json$/, "") + ".token-cache.json");
  const collection = spec.collection || "events";
  const snapCollection = spec.snapshotCollection || "signals";

  const session = async () => {
    const a = read(authFile);
    if (!(a && a.account && a.refreshToken)) return { reason: "not linked" };
    const auth = { ...a, apiKey: a.apiKey || spec.apiKey, project: a.project || spec.project };
    if (!auth.apiKey || !auth.project) return { reason: "no project or apiKey" };
    const token = await idToken(auth, cachePath);
    return token ? { auth, token } : { reason: "no token" };
  };
  const base = (project) => `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

  return {
    describe: () => `firestore ${spec.project || "(project from auth)"}/${collection}`,
    async event(record, ctx) {
      const s = await session();
      if (!s.token) return { sent: false, reason: s.reason };
      const r = await fetch(`${base(s.auth.project)}/${collection}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: encodeFields({ account: s.auth.account, ...record }, ctx.schema) }),
        signal: AbortSignal.timeout(4000),
      });
      return { sent: r.ok, status: r.status };
    },
    async snapshot(payload) {
      const s = await session();
      if (!s.token) return { sent: false, reason: s.reason };
      const fields = {
        account: { stringValue: String(s.auth.account) },
        schema: { integerValue: String(payload.schema ?? 1) },
        collectedAt: { timestampValue: payload.collectedAt || new Date().toISOString() },
        payload: { stringValue: JSON.stringify(payload).slice(0, 900_000) },
      };
      const r = await fetch(`${base(s.auth.project)}/${snapCollection}/${encodeURIComponent(s.auth.account)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
        signal: AbortSignal.timeout(8000),
      });
      return { sent: r.ok, status: r.status };
    },
  };
}
