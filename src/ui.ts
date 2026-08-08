import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { dashboardLines, doctorLines } from "./format.ts";
import type { UsageCoordinator } from "./refresh.ts";

const MAX_BODY_LINES = 18;

class TextDashboard {
  private offset = 0;
  private refreshing = false;
  private cachedLines: string[] = [];

  constructor(
    private readonly title: string,
    private readonly theme: Theme,
    private readonly lines: () => string[],
    private readonly done: () => void,
    private readonly requestRender: () => void,
    private readonly refresh?: () => Promise<void>,
  ) {}

  startRefresh(): void {
    if (!this.refresh || this.refreshing) return;
    this.refreshing = true;
    this.requestRender();
    void this.refresh()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = false;
        this.invalidate();
        this.requestRender();
      });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done();
      return;
    }
    if ((data === "r" || data === "R") && this.refresh) {
      this.startRefresh();
      return;
    }
    const maxOffset = Math.max(0, this.cachedLines.length - MAX_BODY_LINES);
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, Key.down))
      this.offset = Math.min(maxOffset, this.offset + 1);
    if (matchesKey(data, Key.home)) this.offset = 0;
    if (matchesKey(data, Key.end)) this.offset = maxOffset;
    this.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    this.cachedLines = this.lines();
    const maxOffset = Math.max(0, this.cachedLines.length - MAX_BODY_LINES);
    this.offset = Math.min(this.offset, maxOffset);
    const body = this.cachedLines.slice(
      this.offset,
      this.offset + MAX_BODY_LINES,
    );
    const pad = (value: string) => {
      const truncated = truncateToWidth(
        value,
        innerWidth,
        this.theme.fg("dim", "…"),
      );
      return (
        truncated +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))
      );
    };
    const row = (value: string) =>
      `${this.theme.fg("border", "│")}${pad(value)}${this.theme.fg("border", "│")}`;
    const output = [
      this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold(this.title))}`),
      row(""),
      ...body.map((line) => row(` ${line}`)),
    ];
    if (body.length === 0) output.push(row(" No usage data."));
    output.push(row(""));
    const position =
      this.cachedLines.length > MAX_BODY_LINES
        ? ` · ${this.offset + 1}-${Math.min(this.cachedLines.length, this.offset + MAX_BODY_LINES)}/${this.cachedLines.length}`
        : "";
    const refreshHint = this.refresh
      ? this.refreshing
        ? "refreshing…"
        : "r refresh"
      : "";
    output.push(
      row(
        ` ${this.theme.fg(
          "dim",
          [refreshHint, "↑↓ scroll", "esc close"].filter(Boolean).join(" · ") +
            position,
        )}`,
      ),
    );
    output.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return output;
  }

  invalidate(): void {
    this.cachedLines = [];
  }
}

export async function showUsageDashboard(
  ctx: ExtensionCommandContext,
  coordinator: UsageCoordinator,
  refreshImmediately = false,
): Promise<void> {
  if (ctx.mode !== "tui") {
    if (refreshImmediately) await coordinator.refresh(true);
    const text = dashboardLines(coordinator.list(), {
      offline: coordinator.offline,
      configErrors: coordinator.configErrors,
    }).join("\n");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else console.error(text);
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const dashboard = new TextDashboard(
        "Subscription Usage",
        theme,
        () =>
          dashboardLines(coordinator.list(), {
            offline: coordinator.offline,
            configErrors: coordinator.configErrors,
          }),
        () => done(undefined),
        () => tui.requestRender(),
        async () => {
          await coordinator.refresh(true);
        },
      );
      if (refreshImmediately) queueMicrotask(() => dashboard.startRefresh());
      return dashboard;
    },
    {
      overlay: true,
      overlayOptions: {
        width: "85%",
        minWidth: 58,
        maxHeight: "90%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

export async function showDoctor(
  ctx: ExtensionCommandContext,
  coordinator: UsageCoordinator,
): Promise<void> {
  const buildLines = async () => doctorLines(await coordinator.doctor());
  if (ctx.mode !== "tui") {
    const text = (await buildLines()).join("\n");
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else console.error(text);
    return;
  }

  let lines = await buildLines();
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new TextDashboard(
        "Subscription Usage Doctor",
        theme,
        () => lines,
        () => done(undefined),
        () => tui.requestRender(),
        async () => {
          lines = await buildLines();
        },
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "85%",
        minWidth: 58,
        maxHeight: "90%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}
