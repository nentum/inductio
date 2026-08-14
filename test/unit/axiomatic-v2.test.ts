import test from "node:test";
import assert from "node:assert/strict";

import {
  AxiomaticRuntimeV2,
  type AdoptionDecision,
  type ProjectionPathEntry,
  type SemanticBlock,
  type VersionedAdoptionPolicy,
  type VersionedProjectionPolicy,
} from "../../src/axiomatic-v2.ts";
import { expectCode } from "../helpers/expect-code.ts";

const rootBody = {
  rootPrompt: "root prompt",
  toolDefinitions: {
    read_data: {
      description: "read deterministic data",
      parameters: { type: "object" },
    },
  },
} as const;

function projectionPolicy(
  appendContent: (input: {
    readonly candidate: unknown;
    readonly path: readonly ProjectionPathEntry[];
  }) => unknown,
): VersionedProjectionPolicy {
  return {
    identity: { kind: "projection", name: "minimal", version: "v1" },
    project(input) {
      return {
        selectedNodes: input.path
          .filter((entry) => entry.kind === "node")
          .map((entry) => entry.ref),
        appendContent: appendContent({
          candidate: input.candidateInput,
          path: input.path,
        }) as never,
      };
    },
  };
}

const adoptingPolicy: VersionedAdoptionPolicy = {
  identity: { kind: "adoption", name: "frame", version: "v1" },
  adopt(input): AdoptionDecision {
    if (input.evaluation.status !== "completed") {
      return { kind: "reject", reason: { code: "not-completed" } };
    }
    return {
      kind: "adopt",
      block: {
        version: "evaluation-frame/v2",
        input: input.candidateInput,
        output: { answer: "ok" },
      },
    };
  },
};

function prepare(
  runtime: AxiomaticRuntimeV2,
  parent: string,
  position: number,
  policy = projectionPolicy(({ candidate, path }) => ({ candidate, path })),
  inputText = "same input",
): string {
  const occurrence = runtime.materializeInvocationOccurrence("test-input", position, {
    text: inputText,
  });
  return runtime.prepareEvaluation({
    parent,
    occurrence: occurrence.ref,
    environment: runtime.materializeEnvironment({ version: 1, world: "stable" }),
    endpoint: runtime.materializeEndpoint({ model: "test-model", protocol: "test/v1" }),
    projectionPolicy: policy,
  });
}

function complete(runtime: AxiomaticRuntimeV2, evaluation: string, outputText = "same output"): void {
  runtime.claimEvaluationAttempt(evaluation);
  runtime.recordEmission({
    evaluation,
    ordinal: 0,
    producer: "test-model",
    protocol: "test/v1",
    payload: { text: outputText },
  });
  runtime.completeEvaluation(evaluation, "completed", { finish: "stop" });
}

function adoptFrame(
  runtime: AxiomaticRuntimeV2,
  parent: string,
  position: number,
  inputText: string,
  outputText: string,
): string {
  const evaluation = prepare(runtime, parent, position, undefined, inputText);
  complete(runtime, evaluation, outputText);
  const policy: VersionedAdoptionPolicy = {
    identity: {
      kind: "adoption",
      name: `frame-${inputText}-${outputText}`,
      version: "v1",
    },
    adopt(input): AdoptionDecision {
      return {
        kind: "adopt",
        block: {
          version: "evaluation-frame/v2",
          input: input.candidateInput,
          output: { text: outputText },
        },
      };
    },
  };
  const result = runtime.adoptEvaluation(evaluation, policy);
  assert.ok(result.node);
  return result.node.ref;
}

test("A1-A8：相同 Root 唯一，Node 单父成树，连续相同帧因 parent 不同而保留", () => {
  const runtime = new AxiomaticRuntimeV2();
  const firstRoot = runtime.createRoot(rootBody);
  const secondRoot = runtime.createRoot(structuredClone(rootBody));
  assert.equal(firstRoot.agent, secondRoot.agent);
  assert.equal(firstRoot.root, secondRoot.root);

  const firstRef = adoptFrame(runtime, firstRoot.root, 0, "same", "answer");
  const sameParentRef = adoptFrame(runtime, firstRoot.root, 1, "same", "answer");
  assert.equal(firstRef, sameParentRef);

  const secondRef = adoptFrame(runtime, firstRef, 2, "same", "answer");
  assert.notEqual(firstRef, secondRef);
  assert.deepEqual(runtime.path(secondRef), [firstRoot.root, firstRef, secondRef]);
  assert.equal(runtime.rootOf(secondRef).root, firstRoot.root);
});

test("Root 强制存在；ProjectionPolicy 只选择非根 parent 路径并返回可审计追加内容", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const priorRef = adoptFrame(runtime, root.root, 0, "prior", "answer");
  const policy = projectionPolicy(({ candidate, path }) => ({
    candidate,
    path: path.map((entry) => entry.kind),
  }));
  const evaluation = prepare(runtime, priorRef, 1, policy);
  const projection = runtime.getProjection(runtime.getEvaluation(evaluation).projection);
  assert.deepEqual(projection.selectedNodes, [priorRef]);
  assert.deepEqual(projection.appendContent, {
    candidate: { text: "same input" },
    path: ["root", "node"],
  });

  const invalid: VersionedProjectionPolicy = {
    identity: { kind: "projection", name: "invalid", version: "v1" },
    project() {
      return {
        selectedNodes: [`sha256:${"0".repeat(64)}`],
        appendContent: null,
      };
    },
  };
  expectCode(() => prepare(runtime, priorRef, 2, invalid), "AXIOMATIC_INVALID_PROJECTION");
});

test("Emission 先于采纳存在；执行失败、unknown 不推进语义树", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const evaluation = prepare(runtime, root.root, 1);
  expectCode(
    () => runtime.recordEmission({
      evaluation,
      ordinal: 0,
      producer: "test",
      protocol: "test/v1",
      payload: { text: "too early" },
    }),
    "AXIOMATIC_EMISSION_NOT_CAPTURABLE",
  );
  runtime.claimEvaluationAttempt(evaluation);
  const emission = runtime.recordEmission({
    evaluation,
    ordinal: 0,
    producer: "test",
    protocol: "test/v1",
    payload: { text: "candidate" },
  });
  runtime.markUnknown(evaluation, { reason: "connection lost" });
  expectCode(
    () => runtime.adoptEvaluation(evaluation, adoptingPolicy),
    "AXIOMATIC_EVALUATION_NOT_ADOPTABLE",
  );
  const state = runtime.getEvaluation(evaluation);
  assert.equal(state.status, "unknown");
  assert.equal(state.emissions[0], emission);
});

test("attempt 前本地失败单独记录，不伪造 Outcome、不允许派发或采纳", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const evaluation = prepare(runtime, root.root, 30);
  const first = runtime.failEvaluationLocally(
    evaluation,
    "projection-compile",
    { code: "COMPILE_FAILED" },
  );
  const replay = runtime.failEvaluationLocally(
    evaluation,
    "projection-compile",
    { code: "COMPILE_FAILED" },
  );
  assert.equal(replay.ref, first.ref);
  const state = runtime.getEvaluation(evaluation);
  assert.equal(state.status, "failed-local");
  assert.equal(state.outcome, undefined);
  assert.equal(state.localFailure?.ref, first.ref);
  expectCode(
    () => runtime.claimEvaluationAttempt(evaluation),
    "AXIOMATIC_EVALUATION_NOT_DISPATCHABLE",
  );
  expectCode(
    () => runtime.adoptEvaluation(evaluation, adoptingPolicy),
    "AXIOMATIC_EVALUATION_NOT_ADOPTABLE",
  );
  expectCode(
    () => runtime.failEvaluationLocally(evaluation, "projection-compile", { code: "OTHER" }),
    "AXIOMATIC_LOCAL_FAILURE_CONFLICT",
  );
});

test("完成求值经 AdoptionPolicy 才追加一个 EvaluationFrame；同采纳重放幂等", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const evaluation = prepare(runtime, root.root, 1);
  complete(runtime, evaluation);
  const first = runtime.adoptEvaluation(evaluation, adoptingPolicy);
  assert.ok(first.node);
  assert.equal(first.evaluation, evaluation);
  assert.equal(first.parent, root.root);
  assert.equal(first.node.parent, root.root);
  assert.equal(first.decision.kind, "adopt");
  const replay = runtime.adoptEvaluation(evaluation, adoptingPolicy);
  assert.equal(replay.decisionRef, first.decisionRef);
  assert.equal(replay.node?.ref, first.node?.ref);
  assert.deepEqual(runtime.path(first.node.ref), [root.root, first.node.ref]);
});

test("同 parent + 同 SemanticBlock 收敛，但不同 EvaluationRun 保留不同执行发生", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const firstEvaluation = prepare(runtime, root.root, 1);
  const retryOccurrence = runtime.materializeEvaluationOccurrence("user", "retry-1");
  const inputOccurrence = runtime.materializeInvocationOccurrence("test-input", 1, {
    text: "same input",
  });
  const secondEvaluation = runtime.prepareEvaluation({
    parent: root.root,
    occurrence: inputOccurrence.ref,
    evaluationOccurrence: retryOccurrence.ref,
    environment: runtime.materializeEnvironment({ version: 1, world: "stable" }),
    endpoint: runtime.materializeEndpoint({ model: "test-model", protocol: "test/v1" }),
    projectionPolicy: projectionPolicy(({ candidate, path }) => ({ candidate, path })),
  });
  complete(runtime, firstEvaluation);
  complete(runtime, secondEvaluation);
  const first = runtime.adoptEvaluation(firstEvaluation, adoptingPolicy);
  const second = runtime.adoptEvaluation(secondEvaluation, adoptingPolicy);
  assert.equal(first.node?.ref, second.node?.ref);
  assert.notEqual(firstEvaluation, secondEvaluation);
  assert.notEqual(
    runtime.getEvaluation(firstEvaluation).evaluationOccurrence,
    runtime.getEvaluation(secondEvaluation).evaluationOccurrence,
  );
});

test("固定 ProjectionPolicy 输入异值重放拒绝，失败政策不提前占用 EvaluationOccurrence", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const occurrence = runtime.materializeInvocationOccurrence("input", 20, { text: "x" });
  const evaluationOccurrence = runtime.materializeEvaluationOccurrence("evaluation", 20);
  const environment = runtime.materializeEnvironment({ version: 1 });
  const endpoint = runtime.materializeEndpoint({ protocol: "test/v1" });
  const invalid: VersionedProjectionPolicy = {
    identity: { kind: "projection", name: "invalid-first", version: "v1" },
    project() {
      return {
        selectedNodes: [`sha256:${"0".repeat(64)}`],
        appendContent: null,
      };
    },
  };
  expectCode(
    () => runtime.prepareEvaluation({
      parent: root.root,
      occurrence: occurrence.ref,
      evaluationOccurrence: evaluationOccurrence.ref,
      environment,
      endpoint,
      projectionPolicy: invalid,
    }),
    "AXIOMATIC_INVALID_PROJECTION",
  );
  runtime.prepareEvaluation({
    parent: root.root,
    occurrence: occurrence.ref,
    evaluationOccurrence: evaluationOccurrence.ref,
    environment,
    endpoint,
    projectionPolicy: projectionPolicy(({ candidate }) => candidate),
  });

  let generation = 0;
  const nondeterministic: VersionedProjectionPolicy = {
    identity: { kind: "projection", name: "nondeterministic", version: "v1" },
    project(input) {
      generation += 1;
      return {
        selectedNodes: [],
        appendContent: { generation, candidate: input.candidateInput },
      };
    },
  };
  const otherOccurrence = runtime.materializeInvocationOccurrence("input", 21, { text: "y" });
  const common = {
    parent: root.root,
    occurrence: otherOccurrence.ref,
    environment,
    endpoint,
    projectionPolicy: nondeterministic,
  };
  runtime.prepareEvaluation(common);
  expectCode(
    () => runtime.prepareEvaluation(common),
    "AXIOMATIC_POLICY_NONDETERMINISM",
  );
});

test("固定 AdoptionPolicy 输入异值重放拒绝；attempt 只能认领一次", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const evaluation = prepare(runtime, root.root, 22);
  runtime.claimEvaluationAttempt(evaluation);
  expectCode(
    () => runtime.claimEvaluationAttempt(evaluation),
    "AXIOMATIC_EVALUATION_NOT_DISPATCHABLE",
  );
  runtime.recordEmission({
    evaluation,
    ordinal: 0,
    producer: "test",
    protocol: "test/v1",
    payload: { text: "result" },
  });
  runtime.completeEvaluation(evaluation, "completed", { finish: "stop" });
  let generation = 0;
  const policy: VersionedAdoptionPolicy = {
    identity: { kind: "adoption", name: "nondeterministic", version: "v1" },
    adopt(input) {
      generation += 1;
      return {
        kind: "adopt",
        block: {
          version: "evaluation-frame/v2",
          input: input.candidateInput,
          output: { generation },
        },
      };
    },
  };
  runtime.adoptEvaluation(evaluation, policy);
  expectCode(
    () => runtime.adoptEvaluation(evaluation, policy),
    "AXIOMATIC_POLICY_NONDETERMINISM",
  );
});

test("政策不得异步或同步重入运行时", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const asyncPolicy = {
    identity: { kind: "projection" as const, name: "async", version: "v1" },
    project() {
      return Promise.resolve({ selectedNodes: [], appendContent: null });
    },
  } as never;
  expectCode(
    () => prepare(runtime, root.root, 3, asyncPolicy),
    "AXIOMATIC_ASYNC_POLICY",
  );

  let captured: AxiomaticRuntimeV2 | undefined;
  const reentrant = {
    identity: { kind: "projection" as const, name: "reentrant", version: "v1" },
    project() {
      captured!.createRoot(rootBody);
      return { selectedNodes: [], appendContent: null };
    },
  };
  captured = runtime;
  expectCode(
    () => prepare(runtime, root.root, 4, reentrant),
    "AXIOMATIC_POLICY_HAS_POWER",
  );
});

test("同一 EvaluationOccurrence 不能绑定不同求值意图", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const evaluationOccurrence = runtime.materializeEvaluationOccurrence("user", "retry-1");
  const firstInput = runtime.materializeInvocationOccurrence("input", 1, { text: "a" });
  const secondInput = runtime.materializeInvocationOccurrence("input", 2, { text: "b" });
  const environment = runtime.materializeEnvironment({ version: 1 });
  const endpoint = runtime.materializeEndpoint({ protocol: "test/v1" });
  const policy = projectionPolicy(({ candidate, path }) => ({ candidate, path }));
  runtime.prepareEvaluation({
    parent: root.root,
    occurrence: firstInput.ref,
    evaluationOccurrence: evaluationOccurrence.ref,
    environment,
    endpoint,
    projectionPolicy: policy,
  });
  expectCode(
    () => runtime.prepareEvaluation({
      parent: root.root,
      occurrence: secondInput.ref,
      evaluationOccurrence: evaluationOccurrence.ref,
      environment,
      endpoint,
      projectionPolicy: policy,
    }),
    "AXIOMATIC_EVALUATION_OCCURRENCE_CONFLICT",
  );
});

test("同一来源位置不能把相同输入伪装成不同输入", () => {
  const runtime = new AxiomaticRuntimeV2();
  expectCode(
    () => {
      runtime.materializeInvocationOccurrence("source", { offset: 1 }, { text: "a" });
      runtime.materializeInvocationOccurrence("source", { offset: 1 }, { text: "b" });
    },
    "AXIOMATIC_OCCURRENCE_CONFLICT",
  );
});

test("late Outcome 可解除 unknown 并采纳，但不恢复第二次派发资格", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const evaluation = prepare(runtime, root.root, 5);
  runtime.claimEvaluationAttempt(evaluation);
  runtime.markUnknown(evaluation, { reason: "connection-lost" });
  runtime.recordEmission({
    evaluation,
    ordinal: 0,
    producer: "late-model",
    protocol: "test/v1",
    payload: { text: "late" },
  });
  runtime.completeEvaluation(evaluation, "completed", { finish: "late" });
  assert.equal(runtime.getEvaluation(evaluation).status, "completed");
  expectCode(
    () => runtime.claimEvaluationAttempt(evaluation),
    "AXIOMATIC_EVALUATION_NOT_DISPATCHABLE",
  );
  assert.ok(runtime.adoptEvaluation(evaluation, adoptingPolicy).node);
});

test("哈希形字符串仍是普通语义文本；执行 provenance 只存在于采纳账本", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const evaluation = prepare(runtime, root.root, 6);
  complete(runtime, evaluation);
  const policy: VersionedAdoptionPolicy = {
    identity: { kind: "adoption", name: "hash-shaped-text", version: "v1" },
    adopt(input) {
      return {
        kind: "adopt",
        block: {
          version: "evaluation-frame/v2",
          input: input.candidateInput,
          output: { quotedText: input.evaluation.ref },
        },
      };
    },
  };
  const adopted = runtime.adoptEvaluation(evaluation, policy);
  assert.ok(adopted.node);
  assert.deepEqual(adopted.node.block.output, { quotedText: evaluation });
  assert.equal(adopted.node.parent, root.root);
});

test("AdoptionPolicy 不能提交 schema 外字段", () => {
  const runtime = new AxiomaticRuntimeV2();
  const root = runtime.createRoot(rootBody);
  const evaluation = prepare(runtime, root.root, 7);
  complete(runtime, evaluation);
  const policy: VersionedAdoptionPolicy = {
    identity: { kind: "adoption", name: "invalid-frame", version: "v1" },
    adopt() {
      return {
        kind: "adopt",
        block: {
          version: "evaluation-frame/v2",
          input: { text: "input" },
          output: { output: "output" },
          extra: "not allowed",
        } as unknown as SemanticBlock,
      };
    },
  };
  expectCode(
    () => runtime.adoptEvaluation(evaluation, policy),
    "AXIOMATIC_INVALID_SHAPE",
  );
});
