export const PROVIDER_IDS = ["claude", "codex", "copilot", "kiro"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderState =
  | "fresh"
  | "stale"
  | "not_installed"
  | "not_authenticated"
  | "no_subscription"
  | "disabled"
  | "unsupported";

export type WindowKind = "five_hour" | "weekly" | "monthly" | "model" | "other";

export interface AllowanceWindow {
  id: string;
  label: string;
  kind: WindowKind;
  usedPercent?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: string;
  resetsAt?: string;
  unlimited?: boolean;
}

export interface SupplementalBalance {
  id: string;
  label: string;
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: string;
  resetsAt?: string;
  unlimited?: boolean;
}

export interface UsageSnapshot {
  provider: ProviderId;
  label: string;
  observedAt: string;
  plan?: string;
  windows: AllowanceWindow[];
  supplemental?: SupplementalBalance[];
}

export interface ProviderReport {
  provider: ProviderId;
  label: string;
  state: ProviderState;
  snapshot?: UsageSnapshot;
  error?: string;
  remediation?: string;
}

export type AdapterFailureKind =
  Exclude<ProviderState, "fresh" | "stale" | "disabled"> | "transient";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Runtime {
  resolveCommand(command: string): Promise<string | undefined>;
  exec(
    command: string,
    args: string[],
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      maxBuffer?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<CommandResult>;
}

export interface AdapterDiagnostic {
  provider: ProviderId;
  label: string;
  command: string;
  commandPath?: string;
  version?: string;
  credentialSource: string;
  credentialState: "available" | "missing" | "invalid" | "insecure" | "unknown";
  detail?: string;
}

export interface UsageAdapter {
  readonly id: ProviderId;
  readonly label: string;
  fetch(runtime: Runtime, signal: AbortSignal): Promise<UsageSnapshot>;
  diagnose(runtime: Runtime): Promise<AdapterDiagnostic>;
}
