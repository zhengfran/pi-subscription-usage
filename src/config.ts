import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { asRecord, finiteNumber } from "./security.ts";
import { PROVIDER_IDS, type ProviderId } from "./types.ts";

export interface ProviderConfig {
  enabled: boolean;
}

export interface UsageConfig {
  refreshIntervalMinutes: number;
  providers: Record<ProviderId, ProviderConfig>;
}

export interface LoadedConfig {
  config: UsageConfig;
  path: string;
  errors: string[];
}

const DEFAULT_CONFIG: UsageConfig = {
  refreshIntervalMinutes: 5,
  providers: {
    claude: { enabled: true },
    codex: { enabled: true },
    copilot: { enabled: true },
    kiro: { enabled: true },
  },
};

const ROOT_KEYS = new Set(["refreshIntervalMinutes", "providers"]);
const PROVIDER_KEYS = new Set(["enabled"]);

export function parseConfig(value: unknown): {
  config: UsageConfig;
  errors: string[];
} {
  const config = structuredClone(DEFAULT_CONFIG);
  const errors: string[] = [];
  const root = asRecord(value);
  if (!root)
    return { config, errors: ["configuration root must be a JSON object"] };

  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) errors.push(`unknown configuration key: ${key}`);
  }

  if ("refreshIntervalMinutes" in root) {
    const interval = finiteNumber(root.refreshIntervalMinutes);
    if (interval === undefined || interval < 1 || interval > 1440) {
      errors.push("refreshIntervalMinutes must be from 1 through 1440");
    } else {
      config.refreshIntervalMinutes = interval;
    }
  }

  if ("providers" in root) {
    const providers = asRecord(root.providers);
    if (!providers) {
      errors.push("providers must be a JSON object");
    } else {
      for (const key of Object.keys(providers)) {
        if (!PROVIDER_IDS.includes(key as ProviderId)) {
          errors.push(`unknown provider: providers.${key}`);
          continue;
        }
        const provider = key as ProviderId;
        const entry = asRecord(providers[key]);
        if (!entry) {
          errors.push(`providers.${provider} must be a JSON object`);
          continue;
        }
        for (const entryKey of Object.keys(entry)) {
          if (!PROVIDER_KEYS.has(entryKey)) {
            errors.push(
              `unknown configuration key: providers.${provider}.${entryKey}`,
            );
          }
        }
        if ("enabled" in entry) {
          if (typeof entry.enabled !== "boolean") {
            errors.push(`providers.${provider}.enabled must be true or false`);
          } else {
            config.providers[provider].enabled = entry.enabled;
          }
        }
      }
    }
  }

  return { config, errors };
}

export async function loadConfig(): Promise<LoadedConfig> {
  const path = join(getAgentDir(), "subscription-usage.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = parseConfig(JSON.parse(raw) as unknown);
    return { ...parsed, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: structuredClone(DEFAULT_CONFIG), path, errors: [] };
    }
    if (error instanceof SyntaxError) {
      return {
        config: structuredClone(DEFAULT_CONFIG),
        path,
        errors: ["configuration file is not valid JSON"],
      };
    }
    return {
      config: structuredClone(DEFAULT_CONFIG),
      path,
      errors: ["configuration file could not be read"],
    };
  }
}
