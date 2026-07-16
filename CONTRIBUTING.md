# Contributing

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

1. Keep the application local-first and bound to `127.0.0.1` by default.
2. Do not add telemetry, accounts, remote storage, or open-proxy behavior.
3. Never commit real Agent histories, API captures, credentials, certificates, logs, or custom wallpapers.
4. Use synthetic fixtures with obviously fake model names and content.
5. Do not infer or generate missing reasoning.
6. Protocol adapters normalize wire formats; Agent adapters normalize local histories.
7. Add tests and run `node --check`, `npm test`, and `git diff --check` before proposing a change.

The project code is MIT-licensed. Do not replace its license or add new third-party artwork without documenting the applicable permission, license, source, and attribution in `THIRD_PARTY_NOTICES.md` and `workbench/public/pic/wallpapers.json`.
