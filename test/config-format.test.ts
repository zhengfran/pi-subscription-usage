import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { dashboardLines } from "../src/format.ts";
import type { UsageSnapshot } from "../src/types.ts";

const snapshot: UsageSnapshot = {
  provider: "claude",
  label: "Claude",
  observedAt: "2026-07-29T04:50:00.000Z",
  plan: "pro",
  windows: [
    {
      id: "five_hour",
      label: "5-hour",
      kind: "five_hour",
      usedPercent: 72,
      resetsAt: "2026-07-29T08:00:00.000Z",
    },
    {
      id: "seven_day",
      label: "weekly",
      kind: "weekly",
      usedPercent: 25,
      resetsAt: "2026-08-03T00:00:00.000Z",
    },
  ],
};

test("validates refresh interval and provider settings", () => {
  const { config, errors } = parseConfig({
    refreshIntervalMinutes: 10,
    providers: {
      copilot: { enabled: true, aiCreditsLimit: 20_000 },
      kiro: { enabled: false },
      mystery: {},
    },
  });
  assert.equal(config.refreshIntervalMinutes, 10);
  assert.equal(config.providers.copilot.aiCreditsLimit, 20_000);
  assert.equal(config.providers.kiro.enabled, false);
  assert.ok(errors.some((error) => error.includes("mystery")));
});

test("dashboard labels stale data and keeps it out of model messages", () => {
  const lines = dashboardLines(
    [{ provider: "claude", label: "Claude", state: "stale", snapshot }],
    { now: Date.parse("2026-07-29T05:00:00.000Z") },
  );
  assert.match(lines.join("\n"), /Claude · pro — stale · 10m old/);
  assert.match(lines.join("\n"), /5-hour: 72% used/);
});
