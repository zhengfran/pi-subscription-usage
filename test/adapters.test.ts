import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeClaudeUsage } from "../src/adapters/claude.ts";
import { normalizeCodexUsage } from "../src/adapters/codex.ts";
import {
  normalizeCopilotUsage,
  parseCurrentCopilotToken,
} from "../src/adapters/copilot.ts";
import { normalizeKiroUsage } from "../src/adapters/kiro.ts";

async function fixture(name: string): Promise<unknown> {
  const path = fileURLToPath(new URL(`fixtures/${name}.json`, import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const observedAt = "2026-07-29T05:00:00.000Z";

test("normalizes Claude 5-hour, weekly, model, and supplemental usage", async () => {
  const result = normalizeClaudeUsage(
    await fixture("claude"),
    "pro",
    observedAt,
  );
  assert.equal(result.provider, "claude");
  assert.equal(result.plan, "pro");
  assert.deepEqual(
    result.windows.map(({ kind, usedPercent }) => [kind, usedPercent]),
    [
      ["five_hour", 63],
      ["weekly", 28.5],
      ["model", 11],
    ],
  );
  assert.equal(result.supplemental?.[0]?.used, 1.25);
  assert.equal(result.supplemental?.[0]?.limit, 20);
});

test("normalizes Codex app-server windows and credits", async () => {
  const result = normalizeCodexUsage(await fixture("codex"), observedAt);
  assert.equal(result.plan, "plus");
  assert.deepEqual(
    result.windows.map(({ kind, usedPercent }) => [kind, usedPercent]),
    [
      ["five_hour", 42],
      ["weekly", 77],
    ],
  );
  assert.equal(result.supplemental?.[0]?.remaining, 17.5);
});

test("selects the active token from the current Copilot CLI config", () => {
  assert.equal(
    parseCurrentCopilotToken({
      copilotTokens: {
        "https://github.com:old-user": "old-token",
        "https://github.com:current-user": "current-token",
      },
      lastLoggedInUser: {
        host: "https://github.com",
        login: "current-user",
      },
    }),
    "current-token",
  );
});

test("normalizes Copilot native monthly request totals", async () => {
  const result = normalizeCopilotUsage(await fixture("copilot"), observedAt);
  assert.equal(result.plan, "individual_pro");
  assert.equal(result.windows[0]?.id, "premium_interactions");
  assert.equal(result.windows[0]?.used, 75);
  assert.equal(result.windows[0]?.limit, 300);
  assert.equal(result.windows[0]?.usedPercent, 25);
  assert.equal(result.windows[1]?.unlimited, true);
  assert.equal(result.windows[1]?.resetsAt, undefined);
});

test("normalizes Kiro monthly credits and bonus separately", async () => {
  const result = normalizeKiroUsage(await fixture("kiro"), observedAt);
  assert.equal(result.plan, "Kiro Pro");
  assert.equal(result.windows[0]?.used, 12.5);
  assert.equal(result.windows[0]?.limit, 50);
  assert.equal(result.windows[0]?.usedPercent, 25);
  assert.equal(result.supplemental?.[0]?.label, "Bonus credits");
  assert.equal(result.supplemental?.[0]?.remaining, 9);
});
