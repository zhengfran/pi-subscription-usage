import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCache, writeCache } from "../src/cache.ts";
import type { UsageSnapshot } from "../src/types.ts";

const snapshot: UsageSnapshot = {
  provider: "codex",
  label: "Codex",
  observedAt: "2026-07-29T05:00:00.000Z",
  windows: [
    { id: "five_hour", label: "5-hour", kind: "five_hour", usedPercent: 12 },
  ],
};

test("writes normalized snapshots atomically with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subscription-usage-"));
  const path = join(directory, "cache", "snapshots.json");
  await writeCache({ codex: snapshot }, path);
  const result = await readCache(path);
  assert.deepEqual(result.snapshots.codex, snapshot);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "cache"))).mode & 0o777, 0o700);
  const raw = await readFile(path, "utf8");
  assert.doesNotMatch(raw, /access_token|refresh_token|Authorization/i);
});
