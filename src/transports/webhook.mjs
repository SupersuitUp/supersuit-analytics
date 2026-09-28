/**
 * POST `{ type, from, record }` (or `{ type: "snapshot", from, payload }`) to a URL.
 * The bearer token is read from the env var named by `tokenEnv`, so recipients.json never
 * holds it. A missing variable sends without auth rather than failing, because some
 * receivers authenticate by the URL itself.
 */
export function webhookTransport(spec) {
  if (!/^https:\/\//.test(spec.url || "") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(spec.url || ""))
    throw new Error("webhook transport needs an https url (http only for localhost)");
  const timeout = Number(spec.timeoutMs) || 4000;
  const post = async (body) => {
    const headers = { "Content-Type": "application/json" };
    const token = spec.tokenEnv && process.env[spec.tokenEnv];
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(spec.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    return { sent: r.ok, status: r.status };
  };
  return {
    describe: () => `webhook ${new URL(spec.url).host}`,
    event: (record, ctx) => post({ type: "event", from: ctx.from, record }),
    snapshot: (payload, ctx) => post({ type: "snapshot", from: ctx.from, payload }),
  };
}
