# Use a global cache with daemon-free coordinated refresh

Usage is account-wide rather than project- or session-specific, so all pi processes will share a user-level snapshot cache. Instances will coordinate refreshes with a short-lived cross-process lock and atomic cache replacement instead of a persistent daemon, trading instant push updates for simpler installation, lifecycle, and failure recovery.
