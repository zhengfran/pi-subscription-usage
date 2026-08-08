import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adapters } from "./adapters/index.ts";
import { loadConfig } from "./config.ts";
import { UsageCoordinator } from "./refresh.ts";
import { createRuntime } from "./runtime.ts";
import { showDoctor, showUsageDashboard } from "./ui.ts";

export default async function subscriptionUsage(pi: ExtensionAPI) {
  const loaded = await loadConfig();
  const coordinator = await UsageCoordinator.create(
    loaded,
    createRuntime(),
    adapters,
  );
  let timer: NodeJS.Timeout | undefined;

  pi.registerCommand("usage", {
    description: "Show provider-reported subscription usage (refresh | doctor)",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "doctor") {
        await showDoctor(ctx, coordinator);
        return;
      }
      if (command && command !== "refresh") {
        ctx.ui.notify("Usage: /usage [refresh|doctor]", "warning");
        return;
      }
      await showUsageDashboard(ctx, coordinator, command === "refresh");
    },
  });

  pi.on("session_start", () => {
    if (!coordinator.offline) {
      clearInterval(timer);
      timer = setInterval(() => {
        void coordinator.refresh(true);
      }, coordinator.config.refreshIntervalMinutes * 60_000);
      timer.unref();
      if (coordinator.needsRefresh()) void coordinator.refresh();
    }
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
