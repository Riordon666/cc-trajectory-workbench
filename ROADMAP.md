# Roadmap

Agent Trace Workbench stays local-first: no required account, hosted backend, analytics, or telemetry.

## 0.1 — Open-source MVP

- Anthropic Messages API and OpenAI Responses API protocol adapters.
- Claude Code and Codex CLI Agent adapters.
- Gateway capture with Advanced/Legacy MITM compatibility.
- Common events, Session replay, Diagnostics, redacted bundles, hashing, and recovery.
- Anime-styled four-workspace UI and secured local terminal.

## Near term

- Validate additional observed Codex rollout versions without hard-coding assumptions.
- Add adapter conformance fixtures and clearer compatibility reporting.
- Improve large-Session virtualization, search, and timeline navigation.
- Add optional capture-size limits and retention controls.
- Document extension points for third-party Agent and protocol adapters.

## Later candidates

- Gemini CLI, Aider, and other coding-agent adapters based on verifiable local formats.
- Side-by-side Session comparison and deterministic regression views.
- Plugin-style adapter discovery with explicit trust boundaries.

Items are candidates, not promises. New adapters must use synthetic fixtures and must never fabricate unavailable reasoning.
