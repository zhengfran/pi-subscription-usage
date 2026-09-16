import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseConfig,
  parseRoutingEnvironment,
  type LoadedConfig,
} from "../src/config.ts";
import { UsageCoordinator } from "../src/refresh.ts";
import type {
  AdapterDiagnostic,
  ProviderId,
  Runtime,
  UsageAdapter,
  UsageSnapshot,
} from "../src/types.ts";

const runtime: Runtime = {
  async resolveCommand() {
    return undefined;
  },
  async exec() {
    return { stdout: "", stderr: "", code: 0 };
  },
};

function adapter(
  provider: ProviderId,
  calls: Map<ProviderId, number>,
): UsageAdapter {
  return {
    id: provider,
    label: provider,
    async fetch(): Promise<UsageSnapshot> {
      calls.set(provider, (calls.get(provider) ?? 0) + 1);
      return {
        provider,
        label: provider,
        observedAt: new Date().toISOString(),
        windows: [
          {
            id: "monthly",
            label: "monthly",
            kind: "monthly",
            usedPercent: 1,
          },
        ],
      };
    },
    async diagnose(): Promise<AdapterDiagnostic> {
      return {
        provider,
        label: provider,
        command: provider,
        credentialSource: "test",
        credentialState: "available",
      };
    },
  };
}

test("parses the shared subagent routing environment conservatively", () => {
  assert.deepEqual(
    parseRoutingEnvironment({ version: 1, environment: "personal" }),
    {
      environment: "personal",
    },
  );
  assert.deepEqual(
    parseRoutingEnvironment({ version: 1, environment: "corporate" }),
    {
      environment: "corporate",
    },
  );
  assert.match(
    parseRoutingEnvironment({ version: 2, environment: "personal" }).error ??
      "",
    /version 1/,
  );
});

test("personal mode hides and does not refresh corporate-only providers", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "subscription-environment-"));
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome;
  const calls = new Map<ProviderId, number>();
  const { config } = parseConfig({});
  const loaded: LoadedConfig = {
    config,
    path: "/test/subscription-usage.json",
    errors: [],
    environment: "personal",
    environmentPath: "/test/subagent-routing.json",
  };
  const adapters = (["claude", "codex", "copilot", "kiro"] as const).map(
    (provider) => adapter(provider, calls),
  );

  try {
    const coordinator = await UsageCoordinator.create(
      loaded,
      runtime,
      adapters,
    );
    assert.deepEqual(
      coordinator.list().map(({ provider }) => provider),
      ["claude", "codex"],
    );

    await coordinator.refresh(true);
    assert.equal(calls.get("claude"), 1);
    assert.equal(calls.get("codex"), 1);
    assert.equal(calls.get("copilot"), undefined);
    assert.equal(calls.get("kiro"), undefined);

    const doctor = await coordinator.doctor();
    assert.deepEqual(doctor.hiddenProviders, ["copilot", "kiro"]);
    assert.equal(
      doctor.reports.find(({ provider }) => provider === "copilot")?.state,
      "disabled",
    );
  } finally {
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCacheHome;
    await rm(cacheHome, { recursive: true, force: true });
  }
});
