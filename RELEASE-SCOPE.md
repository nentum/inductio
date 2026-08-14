# Release Scope: axiomatic-agent-runtime 0.1.0

## Supported profile

This package releases one deliberately narrow profile:

- Node.js 22.23.0 or newer;
- pure in-memory operation in one JavaScript process;
- content-addressed Root and single-parent semantic Nodes;
- `Session = head`, including natural forks;
- complete-path built-in projection;
- declarative deterministic offline evaluators: `echo`, `constant`, and `failure`;
- Emission-before-Adoption and explicit Outcome recording;
- provider-neutral request compilation from the adopted ProjectionPlan before attempt;
- completed-output built-in adoption;
- immutable, replay-verified canonical run-journal snapshots;
- no runtime dependencies;
- verified on Windows x64 and Linux amd64.

The package exports only `InMemoryAgentRuntime`, its three construction/state helpers,
`SemanticError`, and inert TypeScript data types. It does not export the lower-level
ledger state machine or arbitrary policy callbacks.

## Explicitly unsupported

Version 0.1.0 does not provide or claim:

- SQLite or other durable concurrent storage;
- crash-atomic persistence;
- model-provider HTTP clients or SDK adapters;
- network, filesystem, subprocess, or capability execution;
- secrets, credentials, transport handles, owner leases, or permits;
- arbitrary JavaScript policy plugins or a policy sandbox;
- automatic retry of unknown external outcomes;
- browser support;
- ARM verification.

A snapshot is a deterministic replay journal for the supported synchronous offline
profile. It is not a substitute for the unfinished v2 SQLite refinement.

## Release decision

`GO` applies only to the supported offline in-memory profile above after
`npm run release:check` passes from a clean checkout.

SQLite v2 refinement, real model endpoints, real capabilities, irreversible effects,
and arbitrary policy plugins remain `NO-GO`. ARM is `NOT RUN` and unsupported.

The package is currently `UNLICENSED`. Public registry publication requires the owner
to choose a license and authenticate to npm; neither is performed by the build or
release checks.
