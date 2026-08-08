import { homedir } from "node:os";
import { join } from "node:path";
import {
  asRecord,
  finiteNumber,
  inspectPrivateFile,
  safeString,
} from "../security.ts";
import type {
  AdapterDiagnostic,
  AllowanceWindow,
  Runtime,
  SupplementalBalance,
  UsageAdapter,
  UsageSnapshot,
} from "../types.ts";
import {
  AdapterFailure,
  clampPercent,
  commandVersion,
  isoDate,
  planName,
  rejectHttpFailure,
  requestJson,
} from "./shared.ts";

const TOKEN_KEYS = ["kirocli:odic:token", "kirocli:social:token"];

function databasePath(): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "kiro-cli",
      "data.sqlite3",
    );
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "kiro-cli",
      "data.sqlite3",
    );
  }
  return join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
}

function valueText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

async function queryDatabase(
  runtime: Runtime,
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const sql =
    "SELECT key, value FROM auth_kv WHERE key IN ('kirocli:odic:token','kirocli:social:token') " +
    "UNION ALL SELECT key, value FROM state WHERE key = 'api.codewhisperer.profile'";
  const sqlitePath = await runtime.resolveCommand("sqlite3");
  if (sqlitePath) {
    // JSON1 works on older sqlite3 CLIs that predate the newer `-json` flag.
    // Casting the BLOB column to text is safe here because Kiro stores JSON strings.
    const jsonSql =
      "SELECT json_group_array(json_object('key', key, 'value', CAST(value AS TEXT))) FROM (" +
      `${sql});`;
    const result = await runtime.exec(
      sqlitePath,
      ["-batch", "-noheader", path, jsonSql],
      {
        timeoutMs: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.code !== 0) {
      throw new AdapterFailure(
        "unsupported",
        "Kiro CLI credential database could not be read",
      );
    }
    try {
      const rows = JSON.parse(result.stdout || "[]") as unknown;
      if (Array.isArray(rows)) {
        return rows
          .map(asRecord)
          .filter((row): row is Record<string, unknown> => row !== undefined);
      }
    } catch {
      // Fall through to the format error below.
    }
    throw new AdapterFailure(
      "unsupported",
      "Kiro CLI credential database changed format",
    );
  }

  try {
    const sqlite = await import("node:sqlite");
    const database = new sqlite.DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare(sql).all() as Array<Record<string, unknown>>;
    } finally {
      database.close();
    }
  } catch {
    throw new AdapterFailure(
      "unsupported",
      "Reading Kiro credentials requires Node SQLite or the sqlite3 command",
    );
  }
}

interface KiroCredential {
  accessToken: string;
  expiresAt?: number;
  profileArn?: string;
  region: string;
}

function parseExpiry(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined)
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const text = safeString(value, 100);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function readCredential(
  runtime: Runtime,
): Promise<KiroCredential | undefined> {
  const rows = await queryDatabase(runtime, databasePath());
  let profileArn: string | undefined;
  const tokens = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = safeString(row.key, 100);
    const raw = valueText(row.value);
    if (!key || !raw) continue;
    try {
      const parsed = asRecord(JSON.parse(raw) as unknown);
      if (!parsed) continue;
      if (key === "api.codewhisperer.profile") {
        profileArn = safeString(parsed.arn ?? parsed.profileArn, 500);
      } else {
        tokens.set(key, parsed);
      }
    } catch {
      continue;
    }
  }
  for (const key of TOKEN_KEYS) {
    const token = tokens.get(key);
    const accessToken = safeString(
      token?.access_token ?? token?.accessToken,
      16_384,
    );
    if (!accessToken) continue;
    return {
      accessToken,
      expiresAt: parseExpiry(token?.expires_at ?? token?.expiresAt),
      profileArn:
        safeString(token?.profile_arn ?? token?.profileArn, 500) ?? profileArn,
      region: safeString(token?.region, 40) ?? "us-east-1",
    };
  }
  return undefined;
}

function apiRegion(region: string): string {
  if (region.startsWith("eu-")) return "eu-central-1";
  if (region === "us-east-1") return region;
  return "us-east-1";
}

async function resolveProfileArn(
  accessToken: string,
  region: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await requestJson(
    `https://management.${region}.kiro.dev/List-Available-Profiles`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    signal,
  );
  rejectHttpFailure(response, "Kiro");
  const profiles = asRecord(response.data)?.profiles;
  if (Array.isArray(profiles)) {
    for (const profile of profiles) {
      const arn = safeString(asRecord(profile)?.arn, 500);
      if (arn) return arn;
    }
  }
  throw new AdapterFailure(
    "unsupported",
    "Kiro returned no subscription profile",
  );
}

function normalizeBucket(
  value: unknown,
  index: number,
): { window?: AllowanceWindow; supplemental: SupplementalBalance[] } {
  const bucket = asRecord(value);
  if (!bucket) return { supplemental: [] };
  const used = finiteNumber(
    bucket.currentUsageWithPrecision ?? bucket.currentUsage,
  );
  const limit = finiteNumber(
    bucket.usageLimitWithPrecision ?? bucket.usageLimit,
  );
  const resource = safeString(bucket.resourceType, 60) ?? `usage_${index}`;
  const unit = safeString(bucket.unit, 40) ?? resource.toLowerCase();
  const label =
    safeString(
      bucket.displayNamePlural ?? bucket.displayName ?? bucket.resourceType,
      80,
    ) ?? "credits";
  if (used === undefined && limit === undefined) return { supplemental: [] };
  const supplemental: SupplementalBalance[] = [];
  const overage = finiteNumber(
    bucket.currentOveragesWithPrecision ?? bucket.currentOverages,
  );
  if (overage !== undefined && overage > 0) {
    supplemental.push({
      id: `${resource}_overage`,
      label: `${label} overage`,
      used: overage,
      unit,
    });
  }
  const trial = asRecord(bucket.freeTrialInfo);
  const trialUsed = finiteNumber(
    trial?.currentUsageWithPrecision ?? trial?.currentUsage,
  );
  const trialLimit = finiteNumber(
    trial?.usageLimitWithPrecision ?? trial?.usageLimit,
  );
  if (trial && (trialUsed !== undefined || trialLimit !== undefined)) {
    supplemental.push({
      id: `${resource}_bonus`,
      label: "Bonus credits",
      used: trialUsed,
      limit: trialLimit,
      remaining:
        trialUsed !== undefined && trialLimit !== undefined
          ? Math.max(0, trialLimit - trialUsed)
          : undefined,
      unit,
      resetsAt: isoDate(trial.freeTrialExpiry),
    });
  }
  return {
    window: {
      id: resource,
      label,
      kind: "monthly",
      used,
      limit,
      remaining:
        used !== undefined && limit !== undefined
          ? Math.max(0, limit - used)
          : undefined,
      usedPercent:
        used !== undefined && limit !== undefined && limit > 0
          ? clampPercent((used / limit) * 100)
          : undefined,
      unit,
      resetsAt: isoDate(bucket.nextDateReset),
    },
    supplemental,
  };
}

export function normalizeKiroUsage(
  value: unknown,
  observedAt = new Date().toISOString(),
): UsageSnapshot {
  const root = asRecord(value);
  if (!root)
    throw new AdapterFailure(
      "unsupported",
      "Kiro usage response changed format",
    );
  const rawBuckets = Array.isArray(root.usageBreakdownList)
    ? root.usageBreakdownList
    : root.usageBreakdown
      ? [root.usageBreakdown]
      : [];
  const buckets = rawBuckets.map(normalizeBucket);
  const windows = buckets
    .map(({ window }) => window)
    .filter((window): window is AllowanceWindow => window !== undefined);
  if (windows.length === 0) {
    throw new AdapterFailure(
      "unsupported",
      "Kiro response contained no monthly allowance",
    );
  }
  const info = asRecord(root.subscriptionInfo);
  const supplemental = buckets.flatMap(({ supplemental: items }) => items);
  return {
    provider: "kiro",
    label: "Kiro",
    observedAt,
    plan: planName(info?.subscriptionTitle ?? info?.type),
    windows,
    supplemental: supplemental.length ? supplemental : undefined,
  };
}

export const kiroAdapter: UsageAdapter = {
  id: "kiro",
  label: "Kiro",

  async fetch(runtime: Runtime, signal: AbortSignal): Promise<UsageSnapshot> {
    const executable = await runtime.resolveCommand("kiro-cli");
    if (!executable)
      throw new AdapterFailure("not_installed", "Kiro CLI is not installed");
    const inspection = await inspectPrivateFile(databasePath());
    if (inspection.state === "missing") {
      throw new AdapterFailure(
        "not_authenticated",
        "Kiro CLI is not signed in",
      );
    }
    if (inspection.state === "insecure") {
      throw new AdapterFailure(
        "unsupported",
        `Kiro credential database ${inspection.detail}`,
      );
    }
    if (inspection.state !== "available") {
      throw new AdapterFailure(
        "not_authenticated",
        "Kiro CLI credentials are unavailable",
      );
    }

    let credential = await readCredential(runtime);
    if (!credential)
      throw new AdapterFailure(
        "not_authenticated",
        "Kiro CLI is not signed in",
      );
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt <= Date.now() + 60_000
    ) {
      await runtime.exec(executable, ["debug", "refresh-auth-token"], {
        signal,
        timeoutMs: 7000,
        maxBuffer: 64 * 1024,
      });
      credential = await readCredential(runtime);
      if (!credential || (credential.expiresAt ?? 0) <= Date.now()) {
        throw new AdapterFailure(
          "not_authenticated",
          "Kiro CLI credentials expired",
        );
      }
    }

    const region = apiRegion(credential.region);
    const profileArn =
      credential.profileArn ??
      (await resolveProfileArn(credential.accessToken, region, signal));
    const url = new URL(
      `https://management.${region}.kiro.dev/Get-Usage-Limits`,
    );
    url.searchParams.set("profileArn", profileArn);
    url.searchParams.set("origin", "KIRO_CLI");
    url.searchParams.set("resourceType", "CREDIT");
    url.searchParams.set("isEmailRequired", "false");
    const response = await requestJson(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          Accept: "application/json",
          "User-Agent": "kiro-cli",
        },
      },
      signal,
    );
    rejectHttpFailure(response, "Kiro");
    return normalizeKiroUsage(response.data);
  },

  async diagnose(runtime: Runtime): Promise<AdapterDiagnostic> {
    const commandPath = await runtime.resolveCommand("kiro-cli");
    const inspection = await inspectPrivateFile(databasePath());
    let credentialState: AdapterDiagnostic["credentialState"] =
      inspection.state;
    if (inspection.state === "available") {
      try {
        credentialState = (await readCredential(runtime))
          ? "available"
          : "missing";
      } catch {
        credentialState = "unknown";
      }
    }
    return {
      provider: "kiro",
      label: "Kiro",
      command: "kiro-cli",
      commandPath,
      version: await commandVersion(commandPath, runtime.exec),
      credentialSource: databasePath(),
      credentialState,
      detail:
        inspection.state === "insecure" || inspection.state === "invalid"
          ? inspection.detail
          : undefined,
    };
  },
};
