#!/usr/bin/env node
/**
 * supersuit-analytics: choose who sees how you use your supersuit, and how much.
 * Exit codes: 0 ok, 1 refused (bad config, unknown recipient), 2 usage error.
 * `emit` always exits 0, because it runs inside hooks and must never break the work.
 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAnalytics } from "../src/analytics.mjs";
import { loadConfig, saveConfig, validateRecipient } from "../src/recipients.mjs";
import { summarizeFile } from "../src/summarize.mjs";
import { TIERS } from "../src/schema.mjs";

const HELP = `supersuit-analytics <command> [--app-dir DIR] [--json]

Who you share with:
  status                         who gets what, and whether anything is sending
  add <id> --tier <${TIERS.join("|")}> (--file PATH | --webhook URL [--token-env VAR])
         [--name NAME] [--deny a,b:*] [--allow a,b] [--drop field,field] [--snapshots]
  remove <id>                    stop sharing with them and forget the recipient
  pause <id> | resume <id>       stop or restart one recipient, keeping the config
  off | on                       stop or restart ALL sharing (the local copy stays)
  from <label>                   the name recipients see you as

What they see:
  preview <id> [--event JSON]    the exact record that recipient would receive
  sent <id> [--limit N]          your copy of what already went to them

Sending (for hooks):
  emit [--detach]                read one JSON event on stdin and share it; always exits 0

Receiving:
  summarize <file.jsonl> [--days 30]   read a shared file back as a picture of how someone works

Tiers: presence (that you used it, when), usage (+ which skills, outcome, timing),
full (+ os, timezone, hashed workspace; snapshots if --snapshots).
App dir: --app-dir, else $SUPERSUIT_ANALYTICS_DIR, else ~/.supersuit/analytics.`;

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const out = (args, human, data) => { console.log(args.json ? JSON.stringify(data, null, 2) : human); };
const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };

async function main() {
  const args = parse(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  if (!cmd || args.help || cmd === "help") { console.log(HELP); return; }
  const appDir = typeof args["app-dir"] === "string" ? args["app-dir"] : undefined;
  const a = createAnalytics({ ...(appDir ? { appDir } : {}) });
  const cfg = () => loadConfig(a.appDir);

  switch (cmd) {
    case "status": {
      const s = a.status();
      const lines = [`sharing: ${s.on ? "on" : "off"}${s.reason ? ` (${s.reason})` : ""}`, `as: ${s.from || "(unnamed; set with \`from <label>\`)"}`, `config: ${a.appDir}/recipients.json`];
      for (const r of s.recipients) {
        const filt = r.skills ? ` skills:${JSON.stringify(r.skills)}` : "";
        lines.push(`  ${r.sending ? "●" : "○"} ${r.id} (${r.name}) tier:${r.tier}${r.snapshots ? "+snapshots" : ""} via ${r.transport}${filt}${r.drop.length ? ` drop:${r.drop.join(",")}` : ""}${r.reason ? ` [${r.reason}]` : ""}`);
      }
      if (!s.recipients.length) lines.push("  no recipients. Add one with `add`.");
      for (const e of s.errors) lines.push(`  ! ${e}`);
      return out(args, lines.join("\n"), s);
    }
    case "add": {
      const [id] = rest;
      if (!id) fail("add needs an id", 2);
      let transport;
      if (typeof args.file === "string") transport = { type: "file", path: args.file };
      else if (typeof args.webhook === "string") transport = { type: "webhook", url: args.webhook, ...(args["token-env"] ? { tokenEnv: args["token-env"] } : {}) };
      else fail("add needs --file PATH or --webhook URL", 2);
      const r = { id, name: typeof args.name === "string" ? args.name : id, tier: args.tier || "usage", transport };
      const skills = {};
      if (list(args.deny)) skills.deny = list(args.deny);
      if (list(args.allow)) skills.allow = list(args.allow);
      if (Object.keys(skills).length) r.skills = skills;
      if (list(args.drop)) r.drop = list(args.drop);
      if (args.snapshots) r.snapshots = true;
      const errs = validateRecipient(r);
      if (errs.length) fail(errs.join("\n"));
      const c = cfg();
      const recipients = c.recipients.filter((x) => x.id !== id).concat(r);
      saveConfig(a.appDir, { ...c, recipients });
      return out(args, `sharing with ${id} at tier "${r.tier}" via ${transport.type}. See exactly what they get: preview ${id}`, r);
    }
    case "remove": case "pause": case "resume": {
      const [id] = rest;
      const c = cfg();
      const r = c.recipients.find((x) => x.id === id);
      if (!r) fail(`no recipient "${id}"`);
      if (cmd === "remove") c.recipients = c.recipients.filter((x) => x.id !== id);
      else r.paused = cmd === "pause";
      saveConfig(a.appDir, c);
      if (cmd !== "remove") await a.announce();
      return out(args, `${id}: ${cmd === "remove" ? "removed" : cmd === "pause" ? "paused" : "resumed"}`, { id, action: cmd });
    }
    case "off": case "on": {
      const marker = `${a.appDir}/no-analytics`;
      if (cmd === "off") writeFileSync(marker, `sharing turned off ${new Date().toISOString()}\n`);
      else rmSync(marker, { force: true });
      await a.announce();
      return out(args, `sharing ${cmd}. Your local copies are kept either way.`, { on: cmd === "on" });
    }
    case "from": {
      const [label] = rest;
      if (!label) fail("from needs a label", 2);
      const c = cfg();
      saveConfig(a.appDir, { ...c, from: label });
      return out(args, `recipients will see you as "${label}"`, { from: label });
    }
    case "preview": {
      const [id] = rest;
      const event = typeof args.event === "string" ? JSON.parse(args.event)
        : { skill: "example:skill", ok: true, durationMs: 1234, errorClass: "TypeError", session: "abc123", os: "darwin 25.0", tzOffset: -420, workspace: "0f3a9c1d2e4b5a67" };
      const p = a.preview(id, event);
      if (!p.record) return out(args, p.reason, p);
      return out(args, JSON.stringify(p.record, null, 2), p);
    }
    case "sent": {
      const [id] = rest;
      const s = a.sent(id, { limit: Number(args.limit) || 20 });
      return out(args, s.events.map((e) => JSON.stringify(e)).join("\n") || `nothing sent to ${id} yet`, s);
    }
    case "emit": {
      try {
        const input = readFileSync(0, "utf8");
        if (args.detach) {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "emit", ...(appDir ? ["--app-dir", appDir] : [])], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
          child.stdin.end(input);
          child.unref();
          return;
        }
        const t = setTimeout(() => process.exit(0), 8000);
        t.unref();
        await a.announce();
        await a.share(JSON.parse(input));
      } catch { /* emit never fails the caller */ }
      process.exit(0);
    }
    case "summarize": {
      const [file] = rest;
      if (!file) fail("summarize needs a file", 2);
      const s = summarizeFile(file, { days: Number(args.days) || 30 });
      const lines = s.map((p) => [
        `${p.from}: ${p.events} events on ${p.activeDays} days, ${p.sessions} sessions${p.activeHours ? `, ~${p.activeHours}h active` : ""}${p.successRate !== null ? `, ${p.successRate}% of skill runs ok` : ""}${p.lastSharingStatus ? ` (last said ${p.lastSharingStatus})` : ""}`,
        ...p.topSkills.map((x) => `  ${String(x.n).padStart(4)}  ${x.skill}`),
      ].join("\n"));
      return out(args, lines.join("\n\n") || "no records in that window", s);
    }
    default:
      fail(`unknown command "${cmd}"\n\n${HELP}`, 2);
  }
}

main().catch((e) => fail(e.message));
