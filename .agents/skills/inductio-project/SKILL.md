---
name: inductio-project
description: MUST USE for code, review, test, docs, API, durability, provider, security, or release work in C:\projects\inductio.
---

# Inductio project contract

Inductio is the compact, MIT-licensed inductive runtime: a content-addressed semantic tree,
a separate append-only execution ledger, and restricted public facades. It deliberately does
not include the larger deductive capability/owner/effect/migration system.

## Workflow

`inspect -> map -> edit -> focused tests -> release:check -> artifact audit`.

Always inspect `git status`, preserve user edits, and distinguish `PASS`, `NOT RUN`, and
unsupported claims. `README.md` is for people; keep it concise and in its present Chinese
voice. Technical detail belongs here, in `RELEASE-SCOPE.md`, tests, and the current checkpoint.

Authority is scoped:

```text
meaning/invariants -> semantic source + tests
release claims      -> RELEASE-SCOPE + current checkpoint
public behavior     -> src/index.ts + declaration/package smoke
navigation          -> this file
```

If these disagree, reconcile explicitly.

## Semantic invariants

```text
Root        = immutable content-addressed origin
Node        = (parent, SemanticBlock), exactly one existing parent
Agent(root) = Root plus all valid descendants
Session     = one head; Path(head) is the unique Root -> head path
Evaluation  = one complete model-evaluation occurrence
```

```text
InvocationOccurrence -> EvaluationOccurrence -> ProjectionPlan
-> durable request -> Attempt -> Emission* -> Outcome | Unknown | LocalFailure
-> AdoptionDecision -> optional Node
```

- model state is transient; identity, memory, and authority stay outside the model;
- Projection derives model-visible context but cannot write Nodes or gain external power;
- request is durable before Attempt;
- Emission is durable before Outcome/Adoption and is not itself a Node;
- Adoption is the only semantic Node write path;
- Unknown never restores automatic dispatch authority;
- execution ledger is not the Session semantic path;
- text from models/plugins/products has no capability authority;
- local commit and external call are not claimed to be exactly-once atomic.

## 0.4 model boundary

Persistent endpoint/request identity includes:

`provider + adapter + canonical baseUrl + model + maxTokens`.

Closed matrix:

```text
opencode-go -> openai-chat-completions/v1 -> POST /chat/completions
openai      -> openai-chat-completions/v1 -> POST /chat/completions
openai      -> openai-responses/v1        -> POST /responses
anthropic   -> anthropic-messages/v1      -> POST /messages
```

Fixed dispatch-time credential mapping:

```text
opencode-go=OPENCODE_GO | openai=OPENAI_API_KEY | anthropic=ANTHROPIC_API_KEY
```

Credential values and metadata must not enter public declarations, semantic data, durable
requests, journals, snapshots, state refs, SQLite/WAL/SHM, logs, or errors. No public `fetch`,
credential resolver, adapter object, transport handle, retry/failover hook, or capability.
HTTPS only; bounded request/response; finite timeout and AbortSignal; at most one dispatch per
Attempt. Provider tool calls fail with `MODEL_UNSUPPORTED_TOOL_CALL`.

Failure map:

```text
config/key/input/request-bound -> preflight or before-Attempt LocalFailure
HTTP/protocol/tool/response-limit -> failed Outcome + Reject
network/timeout/abort/uncertain -> Unknown; no retry
restart Attempt without Outcome -> Unknown
terminal Outcome without Adoption -> deterministic Adoption recovery
```

## Public authority

Public runtime values are limited to `InMemoryAgentRuntime`, `SqliteAgentRuntime`,
`MODEL_DEFAULTS`, `SemanticError`, offline helpers, and policy-plugin normalization/execution
facades. Do not expose the v2 core, durable engine, SQLite connection/SQL, secrets, callbacks,
transport/fetch injection, ownership tokens, permits, capability implementations, or effects.

The policy subprocess is best-effort isolation, not a hostile-code security boundary.

## Source map

```text
src/axiomatic-v2.ts             semantic core
src/in-memory-agent-runtime.ts  deterministic offline facade
src/policy-sandbox.ts           best-effort policy subprocess
src/axiomatic-durable-engine.ts journal/replay/CAS/recovery; internal
src/axiomatic-sqlite-*.ts       private SQLite boundary
src/model-contract.ts           endpoint/request/completion contracts
src/model-adapter.ts            shared wire/security boundary
src/model-adapters.ts           three closed native adapters
src/sqlite-agent-runtime.ts    public durable facade
src/index.ts                    package export boundary
scripts/frozen-check.ts         project contract/module graph
scripts/package-check.ts        tarball/declaration/install smoke
```

## Verification and release

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run release:check
npm run test:live:models   # opt-in only; never part of ordinary gate
```

Target: Node `>=22.23.0`, npm `10.9.8`, Windows/Linux x64. Browser/macOS/ARM are unsupported or
not run. Cross-OS release claims require byte-identical tarballs plus SHA-256/npm shasum.

MIT is owner-selected. Do not push, tag, publish, authenticate to npm, or rewrite historical
artifacts without explicit authorization. A local commit is allowed for the current task;
no push.
