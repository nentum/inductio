import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  InMemoryAgentRuntime,
  SemanticError,
  createInMemoryAgentRuntime,
  inMemoryRuntimeStateRef,
  restoreInMemoryAgentRuntime,
  type AxiomaticRootBody,
  type CanonicalValue,
  type EnvironmentSnapshotV1,
  type InMemoryRuntimeSnapshotV1,
  type OfflineEvaluatorV1,
  type SemanticItem,
} from "../../src/index.ts";

const ROOT: AxiomaticRootBody = {
  rootPrompt: "You are deterministic.",
  toolDefinitions: [
    {
      name: "lookup",
      description: "Read local fixture data.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
  ],
};

function user(content: unknown): readonly SemanticItem[] {
  return [{ kind: "message", role: "user", content: content as never }];
}

function assistant(content: unknown): readonly SemanticItem[] {
  return [{ kind: "message", role: "assistant", content: content as never }];
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SemanticError);
    assert.equal(error.code, code);
    return true;
  });
}

test("frozen public vector reproduces every released content reference", () => {
  const vector = JSON.parse(
    readFileSync(new URL("../vectors/axiomatic-public-v1.json", import.meta.url), "utf8"),
  ) as {
    readonly root: AxiomaticRootBody;
    readonly command: {
      readonly parent: "$ROOT";
      readonly source: string;
      readonly position: CanonicalValue;
      readonly input: readonly SemanticItem[];
      readonly environment: EnvironmentSnapshotV1;
      readonly evaluator: OfflineEvaluatorV1;
    };
    readonly expected: Readonly<Record<string, string>>;
  };
  const runtime = createInMemoryAgentRuntime(vector.root);
  const root = runtime.root();
  const result = runtime.run({
    ...vector.command,
    parent: root.root,
  });
  assert.deepEqual(
    {
      agent: root.agent,
      root: root.root,
      projection: result.projection.ref,
      request: result.request.ref,
      evaluationOccurrence: runtime.evaluation(result.evaluation).evaluationOccurrence,
      evaluation: result.evaluation,
      attempt: runtime.evaluation(result.evaluation).attempt?.ref,
      emission: result.emissions[0]?.ref,
      outcome: result.outcome.ref,
      decision: result.adoption.decisionRef,
      node: result.head,
      stateRef: runtime.stateRef(),
    },
    vector.expected,
  );
});

test("public offline profile completes, adopts, chains, and forks without external effects", () => {
  const runtime = createInMemoryAgentRuntime(ROOT);
  const root = runtime.root();
  const first = runtime.run({
    parent: root.root,
    source: "example",
    position: 1,
    input: user({ text: "first" }),
    environment: {
      version: "environment-snapshot/v1",
      values: { fixtureRevision: 1 },
    },
    evaluator: {
      version: "offline-evaluator/v1",
      kind: "constant",
      output: assistant({ text: "answer" }),
    },
  });

  assert.equal(first.status, "completed");
  assert.equal(first.outcome.kind, "completed");
  assert.equal(first.adoption.decision.kind, "adopt");
  assert.equal(first.request.projection, first.projection.ref);
  assert.equal(first.request.endpoint, first.projection.endpoint);
  assert.deepEqual(first.request.evaluator, {
    version: "offline-evaluator/v1",
    kind: "constant",
    output: assistant({ text: "answer" }),
  });
  assert.deepEqual(first.request.root, root.body);
  assert.deepEqual(first.request.modelInput.history, []);
  assert.deepEqual(first.request.modelInput.candidateInput, user({ text: "first" }));
  assert.equal(first.emissions.length, 1);
  assert.notEqual(first.head, root.root);
  assert.deepEqual(runtime.path(first.head), [root.root, first.head]);
  assert.deepEqual(runtime.node(first.head).block, {
    version: "evaluation-frame/v2",
    input: user({ text: "first" }),
    output: assistant({ text: "answer" }),
  });

  const second = runtime.run({
    parent: first.head,
    source: "example",
    position: 2,
    input: user({ text: "second" }),
    evaluator: { version: "offline-evaluator/v1", kind: "echo" },
  });
  assert.deepEqual(second.projection.selectedNodes, [first.head]);
  assert.deepEqual(second.request.modelInput.history, [runtime.node(first.head).block]);
  assert.deepEqual(runtime.path(second.head), [root.root, first.head, second.head]);

  const fork = runtime.run({
    parent: root.root,
    source: "example",
    position: 3,
    input: user({ text: "fork" }),
    evaluator: {
      version: "offline-evaluator/v1",
      kind: "constant",
      output: assistant({ text: "fork-answer" }),
    },
  });
  assert.deepEqual(runtime.path(fork.head), [root.root, fork.head]);
  assert.notEqual(fork.head, first.head);
});

test("failed offline evaluation records Outcome and rejection without advancing head", () => {
  const runtime = new InMemoryAgentRuntime(ROOT);
  const parent = runtime.root().root;
  const result = runtime.run({
    parent,
    source: "failure",
    position: { sequence: 1 },
    input: user({ text: "fail" }),
    evaluator: {
      version: "offline-evaluator/v1",
      kind: "failure",
      details: { code: "FIXTURE_FAILURE" },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.head, parent);
  assert.equal(result.emissions.length, 0);
  assert.equal(result.outcome.kind, "failed");
  assert.equal(result.adoption.decision.kind, "reject");
  assert.deepEqual(runtime.path(result.head), [parent]);
  assert.equal(runtime.state().ledger.nodes.length, 0);
  assert.equal(runtime.state().requests.length, 1);
});

test("public run replay is idempotent and stable occurrence conflicts fail closed", () => {
  const runtime = new InMemoryAgentRuntime(ROOT);
  const parent = runtime.root().root;
  const command = {
    parent,
    source: "idempotency",
    position: "same-position",
    input: user({ text: "same" }),
    evaluator: { version: "offline-evaluator/v1" as const, kind: "echo" as const },
  };
  const first = runtime.run(command);
  const replay = runtime.run(structuredClone(command));
  assert.equal(replay.evaluation, first.evaluation);
  assert.equal(replay.head, first.head);
  assert.equal(runtime.snapshot().runs.length, 1);

  const beforeInvocationConflict = runtime.stateRef();
  expectCode(
    () => runtime.run({ ...command, input: user({ text: "different" }) }),
    "AXIOMATIC_OCCURRENCE_CONFLICT",
  );
  assert.equal(runtime.stateRef(), beforeInvocationConflict);

  const fixedEvaluationOccurrence = {
    source: "retry-button",
    position: "one",
  };
  runtime.run({
    ...command,
    source: "other-input",
    position: 1,
    evaluationOccurrence: fixedEvaluationOccurrence,
  });
  const beforeEvaluationConflict = runtime.stateRef();
  expectCode(
    () => runtime.run({
      ...command,
      source: "other-input",
      position: 2,
      evaluationOccurrence: fixedEvaluationOccurrence,
    }),
    "AXIOMATIC_EVALUATION_OCCURRENCE_CONFLICT",
  );
  assert.equal(runtime.stateRef(), beforeEvaluationConflict);
});

test("snapshot replay reproduces all references and rejects tampering", () => {
  const runtime = new InMemoryAgentRuntime(ROOT);
  const root = runtime.root().root;
  const adopted = runtime.run({
    parent: root,
    source: "snapshot",
    position: 1,
    input: user({ text: "persisted" }),
    evaluator: {
      version: "offline-evaluator/v1",
      kind: "constant",
      output: assistant({ text: "stable" }),
    },
  });
  runtime.run({
    parent: adopted.head,
    source: "snapshot",
    position: 2,
    input: user({ text: "failed" }),
    evaluator: {
      version: "offline-evaluator/v1",
      kind: "failure",
      details: { code: "EXPECTED" },
    },
  });

  const snapshot = runtime.snapshot();
  const restored = restoreInMemoryAgentRuntime(structuredClone(snapshot));
  assert.equal(restored.stateRef(), runtime.stateRef());
  assert.equal(inMemoryRuntimeStateRef(restored.state()), runtime.stateRef());
  assert.deepEqual(restored.state(), runtime.state());
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.runs));

  const tampered = {
    ...structuredClone(snapshot),
    stateRef: `sha256:${"0".repeat(64)}`,
  } as InMemoryRuntimeSnapshotV1;
  expectCode(
    () => InMemoryAgentRuntime.fromSnapshot(tampered),
    "AXIOMATIC_PUBLIC_SNAPSHOT_MISMATCH",
  );

  const duplicateJournal: InMemoryRuntimeSnapshotV1 = {
    ...structuredClone(snapshot),
    runs: [...structuredClone(snapshot.runs), structuredClone(snapshot.runs[0]!)],
  };
  expectCode(
    () => InMemoryAgentRuntime.fromSnapshot(duplicateJournal),
    "AXIOMATIC_PUBLIC_SNAPSHOT_NON_CANONICAL",
  );

  const nonCanonicalRoot: InMemoryRuntimeSnapshotV1 = {
    ...structuredClone(snapshot),
    root: {
      ...structuredClone(snapshot.root),
      rootPrompt: `${snapshot.root.rootPrompt}\r\n`,
    },
  };
  expectCode(
    () => InMemoryAgentRuntime.fromSnapshot(nonCanonicalRoot),
    "AXIOMATIC_PUBLIC_SNAPSHOT_NON_CANONICAL",
  );
});

test("root/tool normalization is stable and public profile rejects unsupported shapes", () => {
  const first = new InMemoryAgentRuntime({
    rootPrompt: "line one\r\nline two",
    toolDefinitions: [
      { name: "zeta", description: "z\rdescription", inputSchema: { type: "null" } },
      { name: "alpha", description: "a", inputSchema: { type: "object" } },
    ],
  });
  const second = new InMemoryAgentRuntime({
    rootPrompt: "line one\nline two",
    toolDefinitions: [
      { name: "alpha", description: "a", inputSchema: { type: "object" } },
      { name: "zeta", description: "z\ndescription", inputSchema: { type: "null" } },
    ],
  });
  assert.equal(first.root().root, second.root().root);
  assert.deepEqual(first.root().body.toolDefinitions.map((tool) => tool.name), ["alpha", "zeta"]);

  expectCode(
    () => new InMemoryAgentRuntime({
      rootPrompt: "duplicate",
      toolDefinitions: [
        { name: "same", description: "one", inputSchema: {} },
        { name: "same", description: "two", inputSchema: {} },
      ],
    }),
    "DUPLICATE_CAPABILITY",
  );

  const runtime = new InMemoryAgentRuntime(ROOT);
  expectCode(
    () => runtime.run({
      parent: runtime.root().root,
      source: "invalid",
      position: 1,
      input: assistant({ text: "wrong direction" }),
      evaluator: { version: "offline-evaluator/v1", kind: "echo" },
    }),
    "AXIOMATIC_PUBLIC_INVALID_INPUT_ITEM",
  );
  expectCode(
    () => runtime.run({
      parent: runtime.root().root,
      source: "invalid",
      position: 2,
      input: user({ text: "ok" }),
      evaluator: {
        version: "offline-evaluator/v1",
        kind: "constant",
        output: user({ text: "wrong direction" }),
      },
    }),
    "AXIOMATIC_PUBLIC_INVALID_OUTPUT_ITEM",
  );
});

test("production entry exposes only the offline facade and inert value types", async () => {
  const exported = await import("../../src/index.ts");
  assert.deepEqual(Object.keys(exported).toSorted(), [
    "InMemoryAgentRuntime",
    "SemanticError",
    "createInMemoryAgentRuntime",
    "inMemoryRuntimeStateRef",
    "restoreInMemoryAgentRuntime",
  ]);
  for (const forbidden of [
    "AxiomaticRuntimeV2",
    "VersionedProjectionPolicy",
    "VersionedAdoptionPolicy",
    "InternalHost",
    "OwnerToken",
    "SqliteConnection",
    "TransportSecrets",
    "createProductRuntime",
  ]) {
    assert.equal(forbidden in exported, false, `${forbidden} must not be exported`);
  }
});
