import type { UsageAdapter } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { copilotAdapter } from "./copilot.ts";
import { kiroAdapter } from "./kiro.ts";

export const adapters: UsageAdapter[] = [
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  kiroAdapter,
];

export { claudeAdapter, codexAdapter, copilotAdapter, kiroAdapter };
