/**
 * Who you share with, and how much each of them gets.
 *
 * One JSON file the operator owns (`<appDir>/recipients.json`). It holds NO secrets: a
 * transport that needs a credential names an environment variable or a file that holds it,
 * so the config can be shown, diffed and pasted into a chat without leaking anything.
 *
 *   {
 *     "version": 1,
 *     "from": "gary",
 *     "recipients": [
 *       { "id": "wilson", "name": "Wilson", "tier": "usage",
 *         "transport": { "type": "file", "path": "~/Dropbox/shared/gary.jsonl" },
 *         "skills": { "deny": ["personal:*"] },
 *         "drop": ["errorClass"],
 *         "snapshots": false,
 *         "paused": false }
 *     ]
 *   }
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tierRank } from "./schema.mjs";

export const CONFIG_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const configPath = (appDir) => join(appDir, "recipients.json");

export function validateRecipient(r) {
  const errs = [];
  if (!r || typeof r !== "object") return ["recipient must be an object"];
  if (!ID.test(r.id || "")) errs.push(`id "${r.id}" must be lowercase letters, digits and dashes`);
  try { tierRank(r.tier); } catch (e) { errs.push(e.message); }
  if (!r.transport || typeof r.transport.type !== "string") errs.push(`${r.id}: transport.type is required`);
  for (const key of ["allow", "deny"]) {
    const list = r.skills?.[key];
    if (list !== undefined && !Array.isArray(list)) errs.push(`${r.id}: skills.${key} must be a list`);
  }
  if (r.snapshots && r.tier !== "full") errs.push(`${r.id}: snapshots need tier "full"`);
  if (r.transport && JSON.stringify(r.transport).match(/"(token|secret|password|apiKey|refreshToken)"\s*:/i))
    errs.push(`${r.id}: put secrets in an env var (tokenEnv) or a file (authFile), never in recipients.json`);
  return errs;
}

export function loadConfig(appDir) {
  let raw;
  try { raw = JSON.parse(readFileSync(configPath(appDir), "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return { version: CONFIG_VERSION, recipients: [], errors: [] };
    return { version: CONFIG_VERSION, recipients: [], errors: [`recipients.json unreadable (${e.name})`] };
  }
  const recipients = Array.isArray(raw.recipients) ? raw.recipients : [];
  const errors = [];
  const valid = [];
  const seen = new Set();
  for (const r of recipients) {
    const e = validateRecipient(r);
    if (!e.length && seen.has(r.id)) e.push(`duplicate id "${r.id}"`);
    if (e.length) errors.push(...e); else { valid.push(r); seen.add(r.id); }
  }
  return { version: raw.version ?? CONFIG_VERSION, from: raw.from, recipients: valid, errors };
}

export function saveConfig(appDir, config) {
  for (const r of config.recipients) {
    const e = validateRecipient(r);
    if (e.length) throw new Error(e.join("; "));
  }
  const path = configPath(appDir);
  mkdirSync(dirname(path), { recursive: true });
  const out = { version: CONFIG_VERSION, ...(config.from ? { from: config.from } : {}), recipients: config.recipients };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** `personal:*` matches every skill in that namespace; anything else is exact. */
const matches = (skill, pattern) =>
  pattern.endsWith("*") ? skill.startsWith(pattern.slice(0, -1)) : skill === pattern;

/**
 * Whether this recipient may hear about this skill at all. A deny wins over an allow, and
 * an allow list, when present, is the whole world. An event with no skill (a presence
 * line) is always allowed through the filter; the tier decides what it carries.
 */
export function skillVisible(recipient, skill) {
  if (!skill) return true;
  const { allow, deny } = recipient.skills || {};
  if (deny?.some((p) => matches(skill, p))) return false;
  if (allow?.length) return allow.some((p) => matches(skill, p));
  return true;
}
