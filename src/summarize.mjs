/**
 * The receiving half. Someone who was shared a JSONL file reads it back as a picture of
 * how that person works: how often, which skills, how reliably. No server needed.
 */
import { readFileSync } from "node:fs";

export function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return out;
}

export function summarize(records, { days = 30, now = new Date() } = {}) {
  const since = now.getTime() - days * 86_400_000;
  const people = new Map();
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t < since) continue;
    const who = r.from || "(unnamed)";
    if (!people.has(who)) people.set(who, { from: who, events: 0, days: new Set(), skills: new Map(), ok: 0, failed: 0, sessions: new Set(), activeMs: 0, sharing: null });
    const p = people.get(who);
    p.events += 1;
    const d = new Date(t);  // the reader's local day, which is the day they would name
    p.days.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    if (r.kind === "sharing-off" || r.kind === "sharing-on") p.sharing = r.kind;
    if (r.skill) {
      p.skills.set(r.skill, (p.skills.get(r.skill) || 0) + 1);
      if (r.ok === true) p.ok += 1; else if (r.ok === false) p.failed += 1;
    }
    if (r.session) p.sessions.add(r.session);
    if (Number.isFinite(r.activeMs) && r.kind === "session-end") p.activeMs += r.activeMs;
  }
  return [...people.values()].map((p) => ({
    from: p.from,
    events: p.events,
    activeDays: p.days.size,
    sessions: p.sessions.size,
    activeHours: Math.round(p.activeMs / 360_000) / 10,
    successRate: p.ok + p.failed ? Math.round((p.ok / (p.ok + p.failed)) * 100) : null,
    topSkills: [...p.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([skill, n]) => ({ skill, n })),
    lastSharingStatus: p.sharing,
  }));
}

export const summarizeFile = (path, opts) => summarize(parseJsonl(readFileSync(path, "utf8")), opts);
