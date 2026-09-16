import {
  acquireRefreshLock,
  cacheFile,
  readCache,
  waitForPeerRefresh,
  writeCache,
} from "./cache.ts";
import type { LoadedConfig, ProviderConfig, UsageConfig } from "./config.ts";
import { AdapterFailure } from "./adapters/shared.ts";
import type {
  AdapterDiagnostic,
  ProviderId,
  ProviderReport,
  Runtime,
  UsageAdapter,
  UsageSnapshot,
} from "./types.ts";

const ADAPTER_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 250;

const REMEDIATION: Record<ProviderId, Record<string, string>> = {
  claude: {
    not_installed: "Install Claude Code, then run `claude auth login`.",
    not_authenticated: "Run `claude auth login`.",
  },
  codex: {
    not_installed: "Install Codex CLI, then run `codex login`.",
    not_authenticated: "Run `codex login`.",
  },
  copilot: {
    not_installed: "Install `@github/copilot`, then run `copilot login`.",
    not_authenticated: "Run `copilot login`.",
  },
  kiro: {
    not_installed: "Install Kiro CLI, then run `kiro-cli login`.",
    not_authenticated: "Run `kiro-cli login`.",
  },
};

function ageMs(snapshot: UsageSnapshot): number {
  return Math.max(0, Date.now() - Date.parse(snapshot.observedAt));
}

function reportFromSnapshot(
  snapshot: UsageSnapshot,
  intervalMs: number,
): ProviderReport {
  const stale = ageMs(snapshot) > intervalMs;
  return {
    provider: snapshot.provider,
    label: snapshot.label,
    state: stale ? "stale" : "fresh",
    snapshot,
    error: stale ? "cached snapshot is awaiting refresh" : undefined,
  };
}

function failureReport(
  adapter: UsageAdapter,
  error: AdapterFailure,
  cached: UsageSnapshot | undefined,
): ProviderReport {
  if (cached && (error.kind === "transient" || error.kind === "unsupported")) {
    return {
      provider: adapter.id,
      label: adapter.label,
      state: "stale",
      snapshot: cached,
      error: error.message,
    };
  }
  const state = error.kind === "transient" ? "unsupported" : error.kind;
  return {
    provider: adapter.id,
    label: adapter.label,
    state,
    error: error.message,
    remediation: REMEDIATION[adapter.id][state],
  };
}

function safeFailure(error: unknown): AdapterFailure {
  if (error instanceof AdapterFailure) return error;
  return new AdapterFailure(
    "transient",
    "provider adapter failed unexpectedly",
    true,
  );
}

async function runAdapter(
  adapter: UsageAdapter,
  runtime: Runtime,
  options: ProviderConfig,
): Promise<UsageSnapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ADAPTER_TIMEOUT_MS);
    try {
      return await adapter.fetch(runtime, controller.signal, options);
    } catch (error) {
      const failure = controller.signal.aborted
        ? new AdapterFailure(
            "transient",
            `${adapter.label} refresh timed out`,
            true,
          )
        : safeFailure(error);
      if (attempt === 0 && failure.retryable) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new AdapterFailure("transient", `${adapter.label} refresh failed`);
}

export interface DoctorReport {
  packageVersion: string;
  configPath: string;
  cachePath: string;
  offline: boolean;
  configErrors: string[];
  diagnostics: AdapterDiagnostic[];
  reports: ProviderReport[];
}

export class UsageCoordinator {
  readonly config: UsageConfig;
  readonly configPath: string;
  readonly configErrors: string[];
  readonly offline: boolean;

  private readonly adapterById = new Map<ProviderId, UsageAdapter>();
  private reports = new Map<ProviderId, ProviderReport>();
  private snapshots: Partial<Record<ProviderId, UsageSnapshot>> = {};
  private inFlight?: Promise<ProviderReport[]>;
  private lastAttemptAt = 0;
  private cacheError?: string;

  private constructor(
    loaded: LoadedConfig,
    private readonly runtime: Runtime,
    adapterList: UsageAdapter[],
  ) {
    this.config = loaded.config;
    this.configPath = loaded.path;
    this.configErrors = loaded.errors;
    this.offline = /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
    for (const adapter of adapterList)
      this.adapterById.set(adapter.id, adapter);
  }

  static async create(
    loaded: LoadedConfig,
    runtime: Runtime,
    adapterList: UsageAdapter[],
  ): Promise<UsageCoordinator> {
    const coordinator = new UsageCoordinator(loaded, runtime, adapterList);
    await coordinator.reloadCache();
    return coordinator;
  }

  private intervalMs(): number {
    return this.config.refreshIntervalMinutes * 60_000;
  }

  private async reloadCache(): Promise<void> {
    const cache = await readCache();
    this.snapshots = cache.snapshots;
    this.cacheError = cache.error;
    for (const adapter of this.adapterById.values()) {
      if (!this.config.providers[adapter.id].enabled) {
        this.reports.set(adapter.id, {
          provider: adapter.id,
          label: adapter.label,
          state: "disabled",
        });
        continue;
      }
      const snapshot = this.snapshots[adapter.id];
      this.reports.set(
        adapter.id,
        snapshot
          ? reportFromSnapshot(snapshot, this.intervalMs())
          : {
              provider: adapter.id,
              label: adapter.label,
              state: "unsupported",
              error: "usage has not been refreshed yet",
            },
      );
    }
  }

  list(): ProviderReport[] {
    return [...this.adapterById.keys()]
      .map((id) => this.reports.get(id))
      .filter((report): report is ProviderReport => report !== undefined);
  }

  get(provider: ProviderId): ProviderReport | undefined {
    return this.reports.get(provider);
  }

  needsRefresh(): boolean {
    if (this.offline) return false;
    if (Date.now() - this.lastAttemptAt < this.intervalMs()) return false;
    return [...this.adapterById.keys()].some((id) => {
      if (!this.config.providers[id].enabled) return false;
      const snapshot = this.snapshots[id];
      return !snapshot || ageMs(snapshot) > this.intervalMs();
    });
  }

  refresh(force = false): Promise<ProviderReport[]> {
    if (this.inFlight) return this.inFlight;
    if (this.offline || (!force && !this.needsRefresh()))
      return Promise.resolve(this.list());
    this.inFlight = this.performRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async performRefresh(): Promise<ProviderReport[]> {
    this.lastAttemptAt = Date.now();
    const lock = await acquireRefreshLock();
    if (!lock) {
      await waitForPeerRefresh();
      await this.reloadCache();
      return this.list();
    }

    try {
      const nextReports = await Promise.all(
        [...this.adapterById.values()].map(async (adapter) => {
          if (!this.config.providers[adapter.id].enabled) {
            return {
              provider: adapter.id,
              label: adapter.label,
              state: "disabled" as const,
            };
          }
          try {
            const snapshot = await runAdapter(
              adapter,
              this.runtime,
              this.config.providers[adapter.id],
            );
            this.snapshots[adapter.id] = snapshot;
            return {
              provider: adapter.id,
              label: adapter.label,
              state: "fresh" as const,
              snapshot,
            };
          } catch (error) {
            return failureReport(
              adapter,
              safeFailure(error),
              this.snapshots[adapter.id],
            );
          }
        }),
      );
      for (const report of nextReports)
        this.reports.set(report.provider, report);
      try {
        await writeCache(this.snapshots);
        this.cacheError = undefined;
      } catch {
        this.cacheError = "cache could not be written";
      }
      return this.list();
    } finally {
      await lock.release();
    }
  }

  async doctor(): Promise<DoctorReport> {
    const diagnostics = await Promise.all(
      [...this.adapterById.values()].map(async (adapter) => {
        try {
          return await adapter.diagnose(this.runtime);
        } catch {
          return {
            provider: adapter.id,
            label: adapter.label,
            command: adapter.id,
            credentialSource: "unknown",
            credentialState: "unknown" as const,
            detail: "diagnostic failed safely",
          };
        }
      }),
    );
    const configErrors = [...this.configErrors];
    if (this.cacheError) configErrors.push(this.cacheError);
    return {
      packageVersion: "0.1.0",
      configPath: this.configPath,
      cachePath: cacheFile(),
      offline: this.offline,
      configErrors,
      diagnostics,
      reports: this.list(),
    };
  }
}
