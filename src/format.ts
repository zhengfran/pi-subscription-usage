import type {
  AllowanceWindow,
  ProviderReport,
  SupplementalBalance,
} from "./types.ts";
import type { DoctorReport } from "./refresh.ts";

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "now";
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24)
    return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function formatAge(iso: string, now = Date.now()): string {
  const age = Math.max(0, now - Date.parse(iso));
  return age < 30_000 ? "just now" : `${formatDuration(age)} old`;
}

function count(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function usageText(window: AllowanceWindow | SupplementalBalance): string {
  if (window.unlimited) return "unlimited";
  const unit = window.unit ? ` ${window.unit}` : "";
  if (window.used !== undefined && window.limit !== undefined) {
    const percent =
      "usedPercent" in window && window.usedPercent !== undefined
        ? ` (${Math.round(window.usedPercent)}%)`
        : "";
    return `${count(window.used)}/${count(window.limit)}${unit}${percent}`;
  }
  if ("usedPercent" in window && window.usedPercent !== undefined) {
    return `${Math.round(window.usedPercent)}% used`;
  }
  if (window.remaining !== undefined)
    return `${count(window.remaining)}${unit} remaining`;
  if (window.used !== undefined) return `${count(window.used)}${unit} used`;
  return "available";
}

function resetText(
  resetsAt: string | undefined,
  now: number,
): string | undefined {
  if (!resetsAt) return undefined;
  const timestamp = Date.parse(resetsAt);
  if (!Number.isFinite(timestamp)) return undefined;
  const absolute = new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `resets in ${formatDuration(timestamp - now)} (${absolute} local)`;
}

export function dashboardLines(
  reports: ProviderReport[],
  options: { offline?: boolean; configErrors?: string[]; now?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const lines: string[] = [];
  if (options.offline) lines.push("Offline mode: refresh is disabled.", "");
  if (options.configErrors?.length) {
    lines.push("Configuration warnings:");
    for (const error of options.configErrors) lines.push(`  ! ${error}`);
    lines.push("");
  }

  for (const report of reports) {
    const plan = report.snapshot?.plan ? ` · ${report.snapshot.plan}` : "";
    const age = report.snapshot
      ? ` · ${formatAge(report.snapshot.observedAt, now)}`
      : "";
    lines.push(
      `${report.label}${plan} — ${report.state.replace(/_/g, " ")}${age}`,
    );
    if (report.snapshot) {
      for (const window of report.snapshot.windows) {
        const reset = resetText(window.resetsAt, now);
        lines.push(
          `  ${window.label}: ${usageText(window)}${reset ? ` · ${reset}` : ""}`,
        );
      }
      for (const balance of report.snapshot.supplemental ?? []) {
        const reset = resetText(balance.resetsAt, now);
        lines.push(
          `  ${balance.label} (supplemental): ${usageText(balance)}${reset ? ` · ${reset}` : ""}`,
        );
      }
    }
    if (report.error) lines.push(`  ${report.error}`);
    if (report.remediation) lines.push(`  ${report.remediation}`);
    lines.push("");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

export function doctorLines(doctor: DoctorReport): string[] {
  const lines = [
    `pi-subscription-usage ${doctor.packageVersion}`,
    `Config: ${doctor.configPath}`,
    `Environment config: ${doctor.environmentPath}`,
    `Environment: ${doctor.environment ?? "unconfigured (show all providers)"}`,
    `Environment-hidden: ${doctor.hiddenProviders.join(", ") || "none"}`,
    `Cache: ${doctor.cachePath}`,
    `Offline: ${doctor.offline ? "yes" : "no"}`,
    "",
  ];
  if (doctor.configErrors.length) {
    lines.push("Configuration/cache:");
    for (const error of doctor.configErrors) lines.push(`  ! ${error}`);
    lines.push("");
  }
  for (const diagnostic of doctor.diagnostics) {
    const report = doctor.reports.find(
      ({ provider }) => provider === diagnostic.provider,
    );
    lines.push(`${diagnostic.label}: ${report?.state ?? "unknown"}`);
    lines.push(
      `  CLI: ${diagnostic.commandPath ?? "not found"}${diagnostic.version ? ` (${diagnostic.version})` : ""}`,
    );
    lines.push(
      `  Credentials: ${diagnostic.credentialState} · ${diagnostic.credentialSource}`,
    );
    if (diagnostic.detail) lines.push(`  Detail: ${diagnostic.detail}`);
    if (report?.snapshot) {
      lines.push(`  Last snapshot: ${formatAge(report.snapshot.observedAt)}`);
    }
    if (report?.error) lines.push(`  Adapter: ${report.error}`);
    lines.push("");
  }
  while (lines.at(-1) === "") lines.pop();
  return lines;
}
