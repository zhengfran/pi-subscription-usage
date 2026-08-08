# Subscription Usage

The domain for observing account-level AI subscription allowances across providers and presenting comparable, trustworthy availability information in pi.

## Language

**Subscription Usage**:
The provider-reported portion of an account's subscription allowance consumed across all clients. It excludes usage inferred from local sessions, token counts, or monetary cost.
_Avoid_: local usage, session usage, token usage

**Provider**:
An AI service that owns an account subscription and reports its usage, such as Claude, Codex, GitHub Copilot, or Kiro.
_Avoid_: model, client

**Allowance Window**:
A provider-defined interval during which a subscription allowance is consumed and after which availability resets or renews. A Provider may report multiple concurrent Allowance Windows.
_Avoid_: billing period, context window

**Native Usage Unit**:
The unit in which a Provider grants and reports an allowance, such as requests or credits. Native Usage Units from different Providers are not interchangeable and must not be combined into an aggregate score.
_Avoid_: normalized unit, universal credit

**Supplemental Balance**:
A provider-reported paid overage or add-on balance available after or alongside the base subscription allowance. It is displayed separately and is never merged into Subscription Usage.
_Avoid_: subscription allowance, combined usage

**Usage Snapshot**:
A timestamped, provider-reported view of Subscription Usage for one or more Allowance Windows, expressed in the Provider's Native Usage Unit when available. It may also include a distinct Supplemental Balance. A prior successful Usage Snapshot remains valid but becomes stale when a newer observation cannot be obtained.
_Avoid_: estimate, local count

**Provider State**:
The availability of a Provider's Subscription Usage: Fresh, Stale, Not Installed, Not Authenticated, No Subscription, Disabled, or Unsupported. Each Provider has an independent state, so one Provider's failure does not invalidate other Providers' Usage Snapshots.
_Avoid_: global status, refresh result
