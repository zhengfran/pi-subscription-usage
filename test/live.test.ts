import assert from "node:assert/strict";
import { test } from "node:test";
import { adapters } from "../src/adapters/index.ts";
import { createRuntime } from "../src/runtime.ts";

const enabled = process.env.PI_SUBSCRIPTION_USAGE_LIVE === "1";

for (const adapter of adapters) {
  test(
    `live ${adapter.label} adapter returns provider-reported windows`,
    { skip: !enabled },
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const snapshot = await adapter.fetch(
          createRuntime(),
          controller.signal,
        );
        assert.equal(snapshot.provider, adapter.id);
        assert.ok(snapshot.windows.length > 0);
        assert.ok(
          snapshot.windows.every(
            (window) =>
              window.usedPercent !== undefined ||
              window.used !== undefined ||
              window.unlimited,
          ),
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  );
}
