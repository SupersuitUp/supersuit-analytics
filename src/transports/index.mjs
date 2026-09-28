/**
 * Where a recipient's records go. A transport is `{ event(record, ctx), snapshot?(payload, ctx) }`,
 * each returning `{ sent, reason? }` and allowed to throw (the caller catches).
 *
 * Built in:
 *   file       append JSONL to a path. Shares through anything that syncs a folder (a git
 *              repo, Dropbox, iCloud) with no server at all.
 *   webhook    POST JSON to a URL, bearer token read from a named env var.
 *   firestore  Firestore REST with a Firebase refresh token read from a file.
 */
import { fileTransport } from "./file.mjs";
import { webhookTransport } from "./webhook.mjs";
import { firestoreTransport } from "./firestore.mjs";

export const BUILTIN = { file: fileTransport, webhook: webhookTransport, firestore: firestoreTransport };

export function resolveTransport(spec, custom = {}) {
  const make = custom[spec.type] || BUILTIN[spec.type];
  if (!make) throw new Error(`unknown transport "${spec.type}"`);
  return make(spec);
}
