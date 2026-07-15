# Changelog

All notable changes to Agent Trace Workbench are documented here.

## [0.1.0] - 2026-07-15

### Added

- Local-first Gateway capture for Anthropic Messages API and OpenAI Responses API.
- Common event model for messages, reasoning, tools, usage, errors, and request lifecycle events.
- Claude Code and Codex CLI local History adapters.
- Session Explorer, replay timeline, non-blocking Diagnostics, hashing, crash recovery, and redacted Session Bundles.
- Local terminal with Host, Origin, shell, working-directory, and concurrency boundaries.
- Offline terminal assets, anime wallpapers, custom wallpaper controls, and four themed workspaces.
- Synthetic fixtures and cross-platform automated tests.

### Changed

- Repositioned the former single-client QC workbench as a general coding-agent observability and replay debugger.
- Replaced blocking verification with informational Diagnostics.

### Privacy

- Removed runtime dependency on customer SOP, QC, delivery identifiers, model allowlists, and delivery ZIP gates.
- Kept real Sessions, captures, certificates, logs, and private migration material outside the public repository boundary.
