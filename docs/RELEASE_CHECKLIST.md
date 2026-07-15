# Release checklist

Use this checklist before publishing a release. Never commit the real data used for manual validation.

## Automated checks

- [ ] `npm ci`
- [ ] `npm run check`
- [ ] `npm audit --audit-level=high`
- [ ] `git diff --check`
- [ ] GitHub Actions passes on Windows and Linux with supported Node.js versions.

## Public boundary

- [ ] `git status --short` contains no `sessions/`, `certs/`, `local-private/`, `local-data/`, logs, real captures, or real Agent histories.
- [ ] Search the staged diff for API keys, bearer tokens, private keys, usernames, absolute private paths, prompts, and responses.
- [ ] Screenshots contain synthetic data only and reveal no username, credential, private path, terminal history, or customer material.
- [ ] Wallpaper inventory and third-party notices match the files being published.

## Local Agent validation

- [ ] Import one local Claude Code Session and verify messages, tools, complete model name, timestamps, and `reasoning: unavailable` when absent.
- [ ] Import one local Codex CLI rollout and verify version detection, tools, complete model name, reasoning-summary labeling, and unavailable encrypted reasoning.
- [ ] Run replay and Diagnostics for both Sessions.
- [ ] Delete or retain these Sessions only under an ignored local directory.

## Gateway validation

- [ ] With your own Anthropic credential configured only in the client environment, send one streaming Messages API request through `http://127.0.0.1:5177/gateway/anthropic`.
- [ ] With your own OpenAI credential configured only in the client environment, send one streaming Responses API request through `http://127.0.0.1:5177/gateway/openai`.
- [ ] Interrupt one stream and confirm the partial request remains visible without a false completion event.
- [ ] Confirm a non-2xx upstream response becomes a non-blocking error event.
- [ ] Export a Session Bundle, inspect every entry, and confirm known credential patterns are redacted and raw Agent History is absent.
- [ ] Review prompts, responses, paths, and tool data before sharing. Credential redaction is not a general-purpose privacy scrubber.

The two live Gateway checks can incur provider usage charges and require credentials. They must be run deliberately by the credential owner; CI uses synthetic upstreams instead.

## GitHub release

- [ ] Set `repository`, `homepage`, and `bugs` in `package.json` after the final GitHub URL exists.
- [ ] Enable private vulnerability reporting and update the security contact link.
- [ ] Confirm version and changelog.
- [ ] Tag and publish only after the staged-file review is complete.
