# Security

## Supported use

Agent Trace Workbench is intended for a single user on a trusted local machine. It listens on `127.0.0.1` and must not be exposed through port forwarding or a public reverse proxy.

## Sensitive data

Captured prompts, tool inputs, tool outputs, source paths, and model responses may contain secrets. Request headers and known credential fields are redacted, and Session Bundles are redacted again before export. Users must still inspect exports before sharing them.

## Gateway

The gateway exposes fixed Anthropic Messages and OpenAI Responses routes. Upstream origins are configured by the local process environment and cannot be selected by an HTTP client. Do not configure an untrusted upstream.

## Terminal

The terminal is an explicitly user-operated local shell. WebSocket Host and Origin are checked, shells are selected from a small allowlist, CWD is restricted to configured roots, and concurrent PTYs are limited. `TERMINAL_ALLOWED_ROOTS` may add explicit local roots using the platform path separator.

## Reporting

Report vulnerabilities privately to the repository owner. After the GitHub repository is published, use GitHub private vulnerability reporting when enabled. Do not include real captured data in a report; provide a synthetic reproduction instead.
