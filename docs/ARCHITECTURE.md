# Architecture

```text
Agent/API -> local Gateway or Legacy MITM -> raw capture
                                      \-> Protocol Adapter -> events.jsonl
Agent History -> Agent Adapter -------------------------^
events.jsonl -> Diagnostics -> Explorer / Replay / Bundle
```

## Common event schema

Every generated event contains exactly:

```text
schema_version, session_id, request_id, agent, provider, model,
event_type, timestamp, content, source
```

Generated event types are `session_start`, `session_end`, `request_start`, `user_message`, `reasoning`, `assistant_message`, `tool_call`, `tool_result`, `usage`, `error`, and `request_end`.

Readers preserve unknown future event types and Diagnostics reports them as informational. Writers only generate known types. Model identifiers are stored as observed and are not shortened or mapped through a whitelist.

## Adapter boundaries

Protocol Adapters implement `id`, `displayName`, `detect`, `parseSSE`, and `parseJSON`.

Agent Adapters implement `id`, `displayName`, `protocols`, `classifyRequest`, `discoverLocalSessions`, `parseHistory`, and `historyToEvents`.

Reasoning is emitted only when a source contains an actual reasoning field. A summary remains marked `kind: summary`; encrypted or absent content remains unavailable.
