import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "supersuit-analytics.mjs");
const env = { ...process.env, SUPERSUIT_ANALYTICS: "" };
const run = (dir, ...args) => execFileSync(process.execPath, [BIN, ...args, "--app-dir", dir], { encoding: "utf8", env });

test("add, status, preview, emit, sent, summarize: the operator's whole loop", () => {
  const dir = mkdtempSync(join(tmpdir(), "ssa-cli-"));
  const file = join(mkdtempSync(join(tmpdir(), "ssa-cli-shared-")), "gary.jsonl");
  run(dir, "from", "gary");
  run(dir, "add", "wilson", "--tier", "usage", "--file", file, "--deny", "desiet:*", "--drop", "errorClass");
  assert.match(run(dir, "status"), /wilson \(wilson\) tier:usage via file/);

  const preview = JSON.parse(run(dir, "preview", "wilson", "--event", '{"skill":"cw:ship","ok":true,"errorClass":"E","os":"darwin"}'));
  assert.deepEqual(Object.keys(preview).sort(), ["ok", "skill", "ts"]);

  execFileSync(process.execPath, [BIN, "emit", "--app-dir", dir], { input: '{"skill":"cw:ship","ok":true}', env });
  execFileSync(process.execPath, [BIN, "emit", "--app-dir", dir], { input: '{"skill":"desiet:add-photos"}', env });
  const got = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(got.length, 1);
  assert.equal(got[0].from, "gary");

  assert.match(run(dir, "sent", "wilson"), /cw:ship/);
  assert.match(execFileSync(process.execPath, [BIN, "summarize", file], { encoding: "utf8" }), /gary: 1 events on 1 days/);
});

test("emit exits 0 on garbage, because it runs inside hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ssa-cli-"));
  const r = spawnSync(process.execPath, [BIN, "emit", "--app-dir", dir], { input: "not json", env });
  assert.equal(r.status, 0);
});

test("a secret in the config is refused with exit 1; a bad command is exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "ssa-cli-"));
  const bad = spawnSync(process.execPath, [BIN, "add", "x", "--tier", "secret", "--file", "/tmp/x", "--app-dir", dir], { env });
  assert.equal(bad.status, 1);
  assert.equal(spawnSync(process.execPath, [BIN, "nope"], { env }).status, 2);
});
