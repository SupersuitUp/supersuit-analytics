/**
 * Small primitives for turning something identifying into something countable.
 * Each one exists because a raw value leaked, or nearly did, in the system this came from.
 */
import { createHash } from "node:crypto";

/** A stable id that is not the thing. Counts workspaces without learning their names. */
export const hashId = (value, length = 16) =>
  value ? createHash("sha256").update(String(value)).digest("hex").slice(0, length) : undefined;

/** The class of an error, never its message. */
export const errorClass = (e) => String((e && (e.name || e.constructor?.name)) || "Error").slice(0, 64);

/**
 * Map a free value onto a closed set. Anything outside the set becomes `fallback`, so a
 * caller can never smuggle a sentence through a field meant to hold a label.
 */
export const closed = (value, allowed, fallback = "other") =>
  allowed.includes(value) ? value : fallback;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remove every listed name from a string, whole words, case-insensitive. A filter on the
 * names you know, NOT a guarantee about content: a name you did not list goes through.
 * Returns `{ text, removed }` so a caller can report how many were caught.
 */
export function scrub(text, names = [], replacement = "[name]") {
  if (typeof text !== "string" || !names.length) return { text, removed: 0 };
  const sorted = [...new Set(names.filter((n) => n && n.length > 1))].sort((a, b) => b.length - a.length);
  if (!sorted.length) return { text, removed: 0 };
  let removed = 0;
  const re = new RegExp(`\\b(?:${sorted.map(escape).join("|")})\\b`, "gi");
  const out = text.replace(re, () => { removed += 1; return replacement; });
  return { text: out, removed };
}
