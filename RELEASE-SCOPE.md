# Release Scope: inductio 0.4.0

## Supported Profile

The 0.4.0 artifact contains three bounded profiles:

1. The deterministic offline in-memory runtime preserved from 0.1.0.
2. The SHA-pinned child-process policy plugin runner preserved from 0.4.0, with a
   best-effort process/permission security boundary.
3. A durable SQLite runtime exposed only through `SqliteAgentRuntime`.

Common support metadata:

- Node.js `>=22.23.0`;
- npm `10.9.8` for release reproduction;
- Windows and Linux x64 only;
- zero npm runtime dependencies;
- browser, macOS, ARM, and other architectures unsupported.

The durable profile provides:

- a local absolute-path SQLite file using packaged `schema/003-axiomatic-v2.sql`;
- WAL, `synchronous=FULL`, foreign keys, `trusted_schema=OFF`, finite busy timeout,
  schema-manifest verification, integrity checks, and fail-closed corruption mapping;
- an append-only canonical command journal and mutable singleton command head;
- replay from zero with command/result hash checks and `stateRef` verification;
- content-addressed Root/Node semantic projections and separate execution/request/
  adoption projections;
- complete command-head `(sequence, commandRef, stateRef)` CAS for concurrent writers;
- request-before-attempt and Emission-before-Outcome ordering;
- restart conversion of attempted-without-outcome work to `unknown`, with no automatic
  retry and no second attempt;
- deterministic built-in complete-output Adoption recovery when a terminal Outcome was
  committed before process termination;
- three native, closed protocol adapters:
  `openai-chat-completions/v1`, `openai-responses/v1`, and `anthropic-messages/v1`;
- OpenCode Go represented as an OpenAI Chat Completions endpoint profile, with default
  endpoint `https://opencode.ai/zen/go/v1/` and model `deepseek-v4-flash`;
- provider-specific OpenAI and Anthropic endpoint defaults, bounded request/response bodies,
  finite timeout, AbortSignal cancellation, credential sanitization, and explicit
  definitive-failure versus unknown classification;
- adapter/provider/model/base URL/max-token identity persisted in the v2 model request.

Provider request construction derives only from the adopted ProjectionPlan, Root,
selected semantic history, candidate input, environment, and endpoint. Caller-provided
raw semantic bodies, arbitrary client callbacks, raw transport handles, credential
resolvers, and provider failover policies are not accepted by `SqliteAgentRuntime`.

## Public Authority Boundary

The package exports restricted runtime facades and inert DTO types. It does not export:

- `AxiomaticRuntimeV2`, `AxiomaticDurableEngine`, or `AxiomaticSqliteConnection`;
- raw SQLite connections or SQL execution;
- `InternalHost`, owner tokens, permits, core commit ports, or Artifact queries;
- model client/fetch callbacks through the durable facade;
- secrets or mutable credential-provider hooks;
- arbitrary in-process ProjectionPolicy/AdoptionPolicy callbacks;
- capability implementations or irreversible effect handles.

Provider tool calls are rejected with `MODEL_UNSUPPORTED_TOOL_CALL`; this profile does not
execute tools or capabilities.

## Credential Boundary

Credential environment variables are fixed by the selected built-in provider and are read
only at preflight/dispatch:

```text
opencode-go + openai-chat-completions/v1  OPENCODE_GO
openai + either OpenAI adapter            OPENAI_API_KEY
anthropic + anthropic-messages/v1         ANTHROPIC_API_KEY
```

The variables are not public options and their values never enter model requests, command
bodies, state references, snapshots, SQLite media, or errors.

## Failure And Recovery Boundary

The runtime does not claim local/external exactly-once atomicity. Instead:

- local configuration, credential, and request-bound failures occur before Attempt;
- HTTP/protocol/tool-call/response-limit failures produce a durable failed Outcome and Reject;
- network, timeout, caller abort, and uncertain transport failures become `unknown`;
- crash after request/Attempt but before Outcome recovers to `unknown`;
- crash after Emission but before Outcome retains Emission and recovers to `unknown`;
- crash after terminal Outcome but before Adoption deterministically resumes the built-in
  AdoptionPolicy;
- no path automatically dispatches a second provider request or performs provider failover.

SQLite consistency checks protect internal structure and hash bindings. They do not protect
against wholesale database rollback, host compromise, disk/controller lies, or external
tampering by an attacker with replacement access to all database media.

## Explicitly Unsupported

Version 0.4.0 does not provide or claim:

- capability execution, tool side effects, or irreversible external actions;
- automatic retry, exactly-once provider execution, or transparent multi-provider failover;
- streaming provider resume or streaming durable Emission fragments;
- general environment CAS/version validation at dispatch;
- independent InterpretationPolicy or capability-proposal schemas;
- arbitrary durable policy plugins in `SqliteAgentRuntime`;
- formal hostile-code isolation for the 0.4.0 plugin runner;
- distributed consensus, remote/shared filesystems, or multi-host ownership;
- v1 semantic-store migration into the new axiomatic v2 database format;
- browser, macOS, ARM, or architectures other than x64.

The plugin runner remains a best-effort Node process/permission boundary. Strongly
adversarial tenant code requires an independently reviewed OS/container/VM boundary,
syscall/network policy, and external resource controls.

## Release Decision

The 0.1.0 offline, 0.4.0 best-effort policy, and 0.3.0 OpenCode Go checkpoint decisions
remain historical. The 0.4.0 Windows x64 and Linux amd64 clean-candidate source/package
gates, native adapter conformance suites, and cross-OS artifact byte identity have passed.
The durable/provider artifact remains `CONDITIONAL` for public distribution until:

- owner-selected license, npm authentication, and explicit push/publish authorization
  are supplied;
- opt-in live probes, if required by the owner, are run separately from the offline gate.

The final artifact identity is recorded in the repository-level 0.4.0 multi-provider
release checkpoint; ARM remains `NOT RUN`.

`npm run release:check` is offline and does not consume provider quota. The opt-in
`npm run test:live:models` command is separate, sends at most one request per test, and
must not be added to the ordinary release gate.

The package is `MIT`. Build and release checks do not push, tag, publish, select a
license, or authenticate to npm.
