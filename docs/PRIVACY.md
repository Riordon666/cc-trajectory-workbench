# Privacy and data boundaries

The workbench has no telemetry or account system. Runtime data stays under ignored local directories.

Never commit:

- `sessions/`
- `certs/`
- `local-private/`
- `local-data/`
- logs, API captures, Agent histories, tokens, or private keys

Session Bundles omit certificates and unredacted Agent History. Known credentials are redacted, but prompts and tool output can contain context-specific secrets that automated filters cannot recognize. Review before sharing.
