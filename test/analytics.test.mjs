import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createAnalytics, saveConfig, project, defineSchema, validateRecipient, skillVisible,
  recordThenSend, scrub, closed, hashId, errorClass, summarize, encodeFields } from "../src/index.mjs";

delete process.env.SUPERSUIT_ANALYTICS;
let dir, shared;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ssa-"));
  shared = mkdtempSync(join(tmpdir(), "ssa-shared-"));
});

const lines = (p) => existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const recipient = (id, tier, extra = {}) => ({ id, name: id, tier, transport: { type: "file", path: join(shared, `${id}.jsonl`) }, ...extra });
const EVENT = { skill: "desiet:add-photos", ok: true, durationMs: 900, errorClass: "TypeError", os: "darwin 25", tzOffset: -420, workspace: "0123456789abcdef", prompt: "text of my prompt", path: "/Users/me/secret" };

// ---- schema: the allowlist is the privacy posture -------------------------------------------

test("an undeclared field never leaves, whatever the tier", () => {
  const r = project(EVENT, { tier: "full" });
  assert.equal(r.prompt, undefined);
  assert.equal(r.path, undefined);
});

test("each tier gets exactly its fields and nothing above", () => {
  assert.deepEqual(Object.keys(project({ ...EVENT, kind: "x", ts: new Date() }, { tier: "presence" })).sort(), ["kind", "ts"]);
  const usage = project(EVENT, { tier: "usage" });
  assert.equal(usage.skill, "desiet:add-photos");
  assert.equal(usage.os, undefined, "os is full-tier");
  assert.equal(usage.workspace, undefined);
  assert.equal(project(EVENT, { tier: "full" }).os, "darwin 25");
});

test("drop removes a field the tier would otherwise send", () => {
  assert.equal(project(EVENT, { tier: "usage", drop: ["errorClass"] }).errorClass, undefined);
});

test("values are coerced or dropped, never passed raw", () => {
  const s = defineSchema({ mood: { type: "string", enum: ["good", "bad"], tier: "usage" } });
  const r = project({ skill: "x".repeat(500), durationMs: "12.6", ok: "yes", mood: "a whole sentence" }, { tier: "usage" }, s);
  assert.equal(r.skill.length, 64);
  assert.equal(r.durationMs, 13);
  assert.equal(r.ok, undefined, "a string is not a boolean");
  assert.equal(r.mood, undefined, "outside the enum");
});

test("a schema cannot declare an uncapped string", () => {
  assert.throws(() => defineSchema({ note: { type: "string", tier: "usage" } }), /max or an enum/);
  assert.throws(() => defineSchema({ n: { type: "int", tier: "secret" } }), /unknown tier/);
});

// ---- recipients ------------------------------------------------------------------------------

test("recipients.json refuses a secret and a snapshot below full", () => {
  assert.match(validateRecipient({ id: "w", tier: "usage", transport: { type: "webhook", url: "https://x", token: "abc" } }).join(), /env var/);
  assert.match(validateRecipient({ id: "w", tier: "usage", snapshots: true, transport: { type: "file", path: "x" } }).join(), /full/);
  assert.match(validateRecipient({ id: "Bad Id", tier: "usage", transport: { type: "file" } }).join(), /lowercase/);
});

test("skill filters: deny wins, allow is the whole world, namespaces glob", () => {
  const r = { skills: { allow: ["freedom:*", "cw:ship"], deny: ["freedom:read-messages"] } };
  assert.equal(skillVisible(r, "freedom:save-my-progress"), true);
  assert.equal(skillVisible(r, "freedom:read-messages"), false);
  assert.equal(skillVisible(r, "cw:ship"), true);
  assert.equal(skillVisible(r, "desiet:add-photos"), false);
  assert.equal(skillVisible(r, undefined), true, "a presence line has no skill to hide");
});

// ---- the pipeline ----------------------------------------------------------------------------

test("share: each recipient gets its own projection, with the local copy first", async () => {
  saveConfig(dir, { from: "gary", recipients: [recipient("wilson", "usage", { skills: { deny: ["desiet:*"] } }), recipient("company", "presence"), recipient("me", "full")] });
  const a = createAnalytics({ appDir: dir });
  await a.share(EVENT);
  await a.share({ skill: "cw:ship", ok: false, errorClass: "Error" });

  const w = lines(join(shared, "wilson.jsonl"));
  assert.equal(w.length, 1, "the desiet skill is hidden from wilson");
  assert.equal(w[0].skill, "cw:ship");
  assert.equal(w[0].from, "gary");
  assert.equal(w[0].os, undefined);

  const c = lines(join(shared, "company.jsonl"));
  assert.equal(c.length, 2);
  for (const r of c) assert.deepEqual(Object.keys(r).sort(), ["from", "ts"], "presence says when, never what");

  const me = lines(join(shared, "me.jsonl"));
  assert.equal(me[0].workspace, "0123456789abcdef");
  assert.equal(me[0].prompt, undefined);

  const copies = readdirSync(join(dir, "sent", "wilson"));
  assert.equal(copies.length, 1);
  assert.equal(a.sent("wilson").events.length, 1);
});

test("nothing leaves when the env switch, the opt-out file, or a pause says so", async () => {
  saveConfig(dir, { recipients: [recipient("wilson", "usage"), recipient("paused", "usage", { paused: true })] });
  const a = createAnalytics({ appDir: dir, killEnv: "MYAPP_ANALYTICS" });
  process.env.MYAPP_ANALYTICS = "off";
  await a.share(EVENT);
  delete process.env.MYAPP_ANALYTICS;
  writeFileSync(join(dir, "no-analytics"), "");
  await a.share(EVENT);
  assert.equal(lines(join(shared, "wilson.jsonl")).length, 0);
  assert.equal(a.status().on, false);
  assert.match(a.status().reason, /opted out/);
  assert.equal(existsSync(join(dir, "sent")), false, "not even a local copy of what did not go");
});

test("a transport that throws never throws out of share", async () => {
  saveConfig(dir, { recipients: [{ id: "boom", tier: "usage", transport: { type: "boom" } }] });
  const a = createAnalytics({ appDir: dir, transports: { boom: () => ({ event: async () => { throw new TypeError("x"); } }) } });
  const res = await a.share(EVENT);
  assert.deepEqual(res, [{ id: "boom", sent: false, reason: "send threw (TypeError)" }]);
  assert.equal(a.sent("boom").events.length, 1, "the copy was written before the send");
});

test("preview shows the exact record, and says when a skill is hidden", () => {
  saveConfig(dir, { recipients: [recipient("wilson", "usage", { skills: { deny: ["desiet:*"] } })] });
  const a = createAnalytics({ appDir: dir });
  assert.match(a.preview("wilson", EVENT).reason, /hidden/);
  assert.equal(a.preview("wilson", { skill: "cw:ship" }).record.skill, "cw:ship");
});

test("snapshots go only to full-tier recipients who opted in", async () => {
  saveConfig(dir, { recipients: [recipient("wilson", "usage"), recipient("me", "full", { snapshots: true }), recipient("full-no", "full")] });
  const res = await createAnalytics({ appDir: dir }).snapshot({ schema: 1, projects: 3 });
  assert.deepEqual(res.map((r) => r.id), ["me"]);
  assert.equal(res[0].sent, true);
  assert.equal(JSON.parse(readFileSync(join(shared, "me.snapshot.json"), "utf8")).payload.projects, 3);
  assert.equal(existsSync(join(shared, "wilson.snapshot.json")), false);
});

test("announce: a pause tells the recipient once, and a first sighting of 'on' says nothing", async () => {
  saveConfig(dir, { recipients: [recipient("wilson", "usage")] });
  const a = createAnalytics({ appDir: dir });
  assert.deepEqual(await a.announce(), []);
  saveConfig(dir, { recipients: [recipient("wilson", "usage", { paused: true })] });
  assert.equal((await a.announce())[0].kind, "sharing-off");
  assert.deepEqual(await a.announce(), [], "once per change");
  const w = lines(join(shared, "wilson.jsonl"));
  assert.deepEqual(Object.keys(w[0]).sort(), ["kind", "ts"], "the pause line says nothing but that");
});

test("webhook: posts the projected record with a bearer from the named env var", async () => {
  let got;
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { got = { auth: req.headers.authorization, body: JSON.parse(body) }; res.end("ok"); });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.TEST_HOOK_TOKEN = "t0k";
  saveConfig(dir, { recipients: [{ id: "hook", tier: "usage", transport: { type: "webhook", url: `http://127.0.0.1:${server.address().port}/in`, tokenEnv: "TEST_HOOK_TOKEN" } }] });
  const res = await createAnalytics({ appDir: dir }).share(EVENT);
  server.close();
  assert.equal(res[0].sent, true);
  assert.equal(got.auth, "Bearer t0k");
  assert.equal(got.body.type, "event");
  assert.equal(got.body.record.os, undefined);
});

// ---- record-then-send ------------------------------------------------------------------------

test("recordThenSend: a copy that reads back different is never sent", async () => {
  let called = false;
  const r = await recordThenSend({ a: 1 }, { dir, send: async () => { called = true; return { sent: true }; }, readBack: () => ({ payload: { a: 2 } }) });
  assert.equal(called, false);
  assert.equal(r.recorded, true);
  assert.equal(r.sent, false);
});

test("recordThenSend: sends the bytes on disk and stamps the outcome", async () => {
  const r = await recordThenSend({ a: 1 }, { dir, send: async (p) => ({ sent: p.a === 1 }) });
  assert.equal(r.sent, true);
  assert.equal(JSON.parse(readFileSync(r.path, "utf8")).sent, true);
});

// ---- primitives and the receiving half -------------------------------------------------------

test("privacy primitives", () => {
  assert.deepEqual(scrub("Met Wilson Fong and wilson fong today", ["Wilson Fong"]), { text: "Met [name] and [name] today", removed: 2 });
  assert.equal(closed("a sentence", ["deal", "other"]), "other");
  assert.equal(hashId("/Users/me/work").length, 16);
  assert.equal(hashId(""), undefined);
  assert.equal(errorClass(new RangeError("/Users/me/file")), "RangeError");
});

test("firestore encoding follows the schema types", () => {
  const f = encodeFields({ ts: "2026-09-28T00:00:00.000Z", durationMs: 5, ok: true, skill: "x" }, { ts: { type: "timestamp" }, durationMs: { type: "int" } });
  assert.deepEqual(f.ts, { timestampValue: "2026-09-28T00:00:00.000Z" });
  assert.deepEqual(f.durationMs, { integerValue: "5" });
  assert.deepEqual(f.ok, { booleanValue: true });
});

test("summarize reads a shared file back as a picture of how someone works", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const recs = [
    { from: "gary", ts: "2026-09-27T10:00:00Z", skill: "cw:ship", ok: true, session: "s1" },
    { from: "gary", ts: "2026-09-28T10:00:00Z", skill: "cw:ship", ok: false, session: "s2" },
    { from: "gary", ts: "2026-09-28T11:00:00Z", kind: "session-end", activeMs: 3_600_000, session: "s2" },
    { from: "gary", ts: "2025-01-01T00:00:00Z", skill: "old" },
  ];
  const [g] = summarize(recs, { now, days: 30 });
  assert.equal(g.events, 3);
  assert.equal(g.activeDays, 2);
  assert.equal(g.sessions, 2);
  assert.equal(g.successRate, 50);
  assert.equal(g.activeHours, 1);
  assert.deepEqual(g.topSkills, [{ skill: "cw:ship", n: 2 }]);
});
