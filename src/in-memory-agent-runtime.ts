import { canonicalize, contentRef, immutableCanonicalCopy } from "./canonical-v1.ts";
import { SemanticError } from "./errors.ts";
import {
  AxiomaticRuntimeV2,
  normalizeAxiomaticRootBody,
  normalizeAxiomaticSemanticItems,
  type AdoptionDecision,
  type AdoptionPolicyInput,
  type AdoptionResult,
  type AxiomaticArtifactRef,
  type AxiomaticNodeRef,
  type AxiomaticRevisionRef,
  type AxiomaticRootBody,
  type AxiomaticStateView,
  type EmissionView,
  type EvaluationOccurrenceRef,
  type EvaluationRunRef,
  type EvaluationView,
  type NodeView,
  type OutcomeView,
  type ProjectionPlanView,
  type ProjectionPolicyInput,
  type RootView,
  type SemanticBlock,
  type SemanticItem,
  type VersionedAdoptionPolicy,
  type VersionedProjectionPolicy,
} from "./axiomatic-v2.ts";
import type { CanonicalValue } from "./types.ts";

const PUBLIC_STATE_DOMAIN = "axiomatic-public-state/v1";
const OFFLINE_REQUEST_DOMAIN = "axiomatic-offline-request/v1";
const SNAPSHOT_FIELDS = ["version", "root", "runs", "stateRef"] as const;
const RUN_FIELDS = [
  "parent",
  "source",
  "position",
  "input",
  "environment",
  "evaluator",
  "evaluationOccurrence",
] as const;

export interface EnvironmentSnapshotV1 {
  readonly version: "environment-snapshot/v1";
  readonly values: CanonicalValue;
}

export type OfflineEvaluatorV1 =
  | {
      readonly version: "offline-evaluator/v1";
      readonly kind: "echo";
    }
  | {
      readonly version: "offline-evaluator/v1";
      readonly kind: "constant";
      readonly output: readonly SemanticItem[];
    }
  | {
      readonly version: "offline-evaluator/v1";
      readonly kind: "failure";
      readonly details: CanonicalValue;
    };

export interface EvaluationOccurrenceInput {
  readonly source: string;
  readonly position: CanonicalValue;
}

export interface RunInMemoryEvaluationInput {
  readonly parent: AxiomaticRevisionRef;
  readonly source: string;
  readonly position: CanonicalValue;
  readonly input: readonly SemanticItem[];
  readonly environment?: EnvironmentSnapshotV1;
  readonly evaluator: OfflineEvaluatorV1;
  readonly evaluationOccurrence?: EvaluationOccurrenceInput;
}

export interface InMemorySnapshotRunV1 {
  readonly parent: AxiomaticRevisionRef;
  readonly source: string;
  readonly position: CanonicalValue;
  readonly input: readonly SemanticItem[];
  readonly environment: EnvironmentSnapshotV1;
  readonly evaluator: OfflineEvaluatorV1;
  readonly evaluationOccurrence: EvaluationOccurrenceInput | null;
}

export interface OfflineModelInputV1 {
  readonly version: "offline-model-input/v1";
  readonly history: readonly SemanticBlock[];
  readonly candidateInput: readonly SemanticItem[];
  readonly environment: EnvironmentSnapshotV1;
}

export interface OfflineModelRequestV1 {
  readonly ref: string;
  readonly version: "offline-model-request/v1";
  readonly projection: string;
  readonly endpoint: AxiomaticArtifactRef;
  readonly evaluator: OfflineEvaluatorV1;
  readonly root: AxiomaticRootBody;
  readonly modelInput: OfflineModelInputV1;
}

export interface InMemoryEvaluationResult {
  readonly evaluation: EvaluationRunRef;
  readonly parent: AxiomaticRevisionRef;
  readonly head: AxiomaticRevisionRef;
  readonly status: "completed" | "failed";
  readonly projection: ProjectionPlanView;
  readonly request: OfflineModelRequestV1;
  readonly emissions: readonly EmissionView[];
  readonly outcome: OutcomeView;
  readonly adoption: AdoptionResult;
}

export interface InMemoryRuntimeStateV1 {
  readonly version: "in-memory-runtime-state/v1";
  readonly ledger: AxiomaticStateView;
  readonly requests: readonly OfflineModelRequestV1[];
  readonly runs: readonly InMemorySnapshotRunV1[];
}

export interface InMemoryRuntimeSnapshotV1 {
  readonly version: "in-memory-runtime-snapshot/v1";
  readonly root: AxiomaticRootBody;
  readonly runs: readonly InMemorySnapshotRunV1[];
  readonly stateRef: string;
}

const COMPLETE_PATH_PROJECTION: VersionedProjectionPolicy = Object.freeze({
  identity: Object.freeze({
    kind: "projection" as const,
    name: "builtin.complete-path",
    version: "v1",
  }),
  project(input: ProjectionPolicyInput) {
    const nodes = input.path.filter((entry) => entry.kind === "node");
    return {
      selectedNodes: nodes.map((entry) => entry.ref),
      appendContent: {
        version: "offline-model-input/v1",
        history: nodes.map((entry) => entry.block),
        candidateInput: input.candidateInput,
        environment: input.environment,
      } as unknown as CanonicalValue,
    };
  },
});

const COMPLETE_OUTPUT_ADOPTION: VersionedAdoptionPolicy = Object.freeze({
  identity: Object.freeze({
    kind: "adoption" as const,
    name: "builtin.complete-output",
    version: "v1",
  }),
  adopt(input: AdoptionPolicyInput): AdoptionDecision {
    if (input.evaluation.status !== "completed") {
      return {
        kind: "reject" as const,
        reason: { code: "EVALUATION_NOT_COMPLETED" },
      };
    }
    if (input.emissions.length !== 1) {
      return {
        kind: "reject" as const,
        reason: { code: "EXPECTED_ONE_EMISSION", actual: input.emissions.length },
      };
    }
    return {
      kind: "adopt" as const,
      block: {
        version: "evaluation-frame/v2" as const,
        input: normalizeInputItems(input.candidateInput),
        output: normalizeOutputItems(input.emissions[0]!.payload),
      },
    };
  },
});

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("AXIOMATIC_PUBLIC_INVALID_SHAPE", `${label} must be an object`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("AXIOMATIC_PUBLIC_INVALID_SHAPE", `${label} has an unexpected field set`);
  }
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail("AXIOMATIC_PUBLIC_INVALID_INPUT", `${label} must be a non-empty string`);
  }
}

function copy<T extends CanonicalValue>(value: T): T {
  return immutableCanonicalCopy(value);
}

function asCanonical(value: unknown): CanonicalValue {
  canonicalize(value);
  return value as CanonicalValue;
}

function normalizeEnvironment(value: EnvironmentSnapshotV1 | undefined): EnvironmentSnapshotV1 {
  const environment = value ?? { version: "environment-snapshot/v1", values: null };
  canonicalize(environment);
  assertObject(environment, "environment");
  assertExactKeys(environment, ["version", "values"], "environment");
  if (environment.version !== "environment-snapshot/v1") {
    fail("AXIOMATIC_PUBLIC_UNSUPPORTED_VERSION", "environment.version is not supported");
  }
  return copy(environment as unknown as CanonicalValue) as unknown as EnvironmentSnapshotV1;
}

function normalizeInputItems(value: unknown): readonly SemanticItem[] {
  const items = normalizeAxiomaticSemanticItems(
    value as readonly SemanticItem[],
    "evaluation input",
  );
  for (const item of items) {
    if (item.kind === "message" && item.role === "user") continue;
    if (item.kind === "tool-result") continue;
    fail(
      "AXIOMATIC_PUBLIC_INVALID_INPUT_ITEM",
      "evaluation input accepts only user messages and tool results",
    );
  }
  return items;
}

function normalizeOutputItems(value: unknown): readonly SemanticItem[] {
  const items = normalizeAxiomaticSemanticItems(
    value as readonly SemanticItem[],
    "evaluation output",
  );
  for (const item of items) {
    if (item.kind === "message" && item.role === "assistant") continue;
    if (item.kind === "thinking" || item.kind === "tool-call") continue;
    fail(
      "AXIOMATIC_PUBLIC_INVALID_OUTPUT_ITEM",
      "evaluation output accepts only assistant messages, thinking, and tool calls",
    );
  }
  return items;
}

function normalizeEvaluator(value: OfflineEvaluatorV1): OfflineEvaluatorV1 {
  canonicalize(value);
  assertObject(value, "evaluator");
  if (value.version !== "offline-evaluator/v1") {
    fail("AXIOMATIC_PUBLIC_UNSUPPORTED_VERSION", "evaluator.version is not supported");
  }
  switch (value.kind) {
    case "echo":
      assertExactKeys(value, ["version", "kind"], "echo evaluator");
      return Object.freeze({ version: value.version, kind: value.kind });
    case "constant":
      assertExactKeys(value, ["version", "kind", "output"], "constant evaluator");
      return Object.freeze({
        version: value.version,
        kind: value.kind,
        output: normalizeOutputItems(value.output),
      });
    case "failure":
      assertExactKeys(value, ["version", "kind", "details"], "failure evaluator");
      return Object.freeze({
        version: value.version,
        kind: value.kind,
        details: copy(value.details),
      });
    default:
      fail("AXIOMATIC_PUBLIC_INVALID_SHAPE", "evaluator.kind is not supported");
  }
}

function normalizeEvaluationOccurrence(
  value: EvaluationOccurrenceInput | undefined | null,
): EvaluationOccurrenceInput | null {
  if (value === undefined || value === null) return null;
  canonicalize(value);
  assertObject(value, "evaluationOccurrence");
  assertExactKeys(value, ["source", "position"], "evaluationOccurrence");
  nonEmpty(value.source, "evaluationOccurrence.source");
  return Object.freeze({ source: value.source, position: copy(value.position) });
}

function normalizeRun(input: RunInMemoryEvaluationInput): InMemorySnapshotRunV1 {
  canonicalize(input);
  assertObject(input, "evaluation input");
  assertExactKeys(
    input,
    [
      "parent",
      "source",
      "position",
      "input",
      "evaluator",
      ...(input.environment === undefined ? [] : ["environment"]),
      ...(input.evaluationOccurrence === undefined ? [] : ["evaluationOccurrence"]),
    ],
    "evaluation input",
  );
  nonEmpty(input.parent, "parent");
  nonEmpty(input.source, "source");
  return Object.freeze({
    parent: input.parent,
    source: input.source,
    position: copy(input.position),
    input: normalizeInputItems(input.input),
    environment: normalizeEnvironment(input.environment),
    evaluator: normalizeEvaluator(input.evaluator),
    evaluationOccurrence: normalizeEvaluationOccurrence(input.evaluationOccurrence),
  });
}

function normalizeStoredRun(value: InMemorySnapshotRunV1): InMemorySnapshotRunV1 {
  canonicalize(value);
  assertObject(value, "snapshot run");
  assertExactKeys(value, RUN_FIELDS, "snapshot run");
  return normalizeRun({
    parent: value.parent,
    source: value.source,
    position: value.position,
    input: value.input,
    environment: value.environment,
    evaluator: value.evaluator,
    ...(value.evaluationOccurrence === null
      ? {}
      : { evaluationOccurrence: value.evaluationOccurrence }),
  });
}

function executeEvaluator(
  evaluator: OfflineEvaluatorV1,
  request: OfflineModelRequestV1,
):
  | { readonly kind: "completed"; readonly output: readonly SemanticItem[] }
  | { readonly kind: "failed"; readonly details: CanonicalValue } {
  switch (evaluator.kind) {
    case "echo":
      return Object.freeze({
        kind: "completed" as const,
        output: normalizeOutputItems([
          {
            kind: "message",
            role: "assistant",
            content: { echo: request.modelInput.candidateInput },
          },
        ]),
      });
    case "constant":
      return Object.freeze({ kind: "completed" as const, output: evaluator.output });
    case "failure":
      return Object.freeze({ kind: "failed" as const, details: evaluator.details });
  }
}

function normalizeOfflineModelInput(value: CanonicalValue): OfflineModelInputV1 {
  assertObject(value, "offline model input");
  assertExactKeys(
    value,
    ["version", "history", "candidateInput", "environment"],
    "offline model input",
  );
  if (value.version !== "offline-model-input/v1" || !Array.isArray(value.history)) {
    fail("AXIOMATIC_CORRUPT_STATE", "built-in projection produced an invalid model input");
  }
  return copy(value) as unknown as OfflineModelInputV1;
}

function compileOfflineRequest(
  runtime: AxiomaticRuntimeV2,
  projection: ProjectionPlanView,
  evaluatorsByEndpoint: ReadonlyMap<AxiomaticArtifactRef, OfflineEvaluatorV1>,
): OfflineModelRequestV1 {
  const root = runtime.rootOf(projection.parent);
  const evaluator = evaluatorsByEndpoint.get(projection.endpoint);
  if (!evaluator) fail("AXIOMATIC_CORRUPT_STATE", "projection endpoint is missing");
  const modelInput = normalizeOfflineModelInput(projection.appendContent);
  const expectedHistory = projection.selectedNodes.map((ref) => runtime.getNode(ref).block);
  if (canonicalize(modelInput.history) !== canonicalize(expectedHistory)) {
    fail(
      "AXIOMATIC_CORRUPT_STATE",
      "projection history does not match selectedNodes",
    );
  }
  normalizeInputItems(modelInput.candidateInput);
  normalizeEnvironment(modelInput.environment);
  const value = {
    version: "offline-model-request/v1" as const,
    projection: projection.ref,
    endpoint: projection.endpoint,
    evaluator,
    root: root.body,
    modelInput,
  };
  const ref = contentRef(OFFLINE_REQUEST_DOMAIN, value as unknown as CanonicalValue);
  return copy({ ref, ...value } as unknown as CanonicalValue) as unknown as OfflineModelRequestV1;
}

function normalizePublicState(state: InMemoryRuntimeStateV1): InMemoryRuntimeStateV1 {
  canonicalize(state);
  assertObject(state, "runtime state");
  assertExactKeys(state, ["version", "ledger", "requests", "runs"], "runtime state");
  if (state.version !== "in-memory-runtime-state/v1") {
    fail("AXIOMATIC_PUBLIC_UNSUPPORTED_VERSION", "runtime state.version is not supported");
  }
  if (!Array.isArray(state.requests) || !Array.isArray(state.runs)) {
    fail("AXIOMATIC_PUBLIC_INVALID_SHAPE", "runtime state lists must be arrays");
  }
  assertObject(state.ledger, "runtime state ledger");
  if (state.ledger.version !== "axiomatic-state/v2") {
    fail("AXIOMATIC_PUBLIC_UNSUPPORTED_VERSION", "runtime ledger.version is not supported");
  }
  return copy(state as unknown as CanonicalValue) as unknown as InMemoryRuntimeStateV1;
}

function stateRef(state: InMemoryRuntimeStateV1): string {
  return contentRef(
    PUBLIC_STATE_DOMAIN,
    normalizePublicState(state) as unknown as CanonicalValue,
  );
}

export class InMemoryAgentRuntime {
  readonly #runtime = new AxiomaticRuntimeV2();
  readonly #root: RootView;
  readonly #runs: InMemorySnapshotRunV1[] = [];
  readonly #requests = new Map<string, OfflineModelRequestV1>();
  readonly #evaluatorsByEndpoint = new Map<AxiomaticArtifactRef, OfflineEvaluatorV1>();
  readonly #invocationClaims = new Map<string, string>();
  readonly #evaluationOccurrenceClaims = new Map<string, string>();

  constructor(root: AxiomaticRootBody) {
    this.#root = this.#runtime.createRoot(normalizeAxiomaticRootBody(root));
  }

  static fromSnapshot(snapshot: InMemoryRuntimeSnapshotV1): InMemoryAgentRuntime {
    canonicalize(snapshot);
    assertObject(snapshot, "snapshot");
    assertExactKeys(snapshot, SNAPSHOT_FIELDS, "snapshot");
    if (snapshot.version !== "in-memory-runtime-snapshot/v1") {
      fail("AXIOMATIC_PUBLIC_UNSUPPORTED_VERSION", "snapshot.version is not supported");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.stateRef)) {
      fail("AXIOMATIC_PUBLIC_INVALID_SHAPE", "snapshot.stateRef is not a content reference");
    }
    const normalizedRoot = normalizeAxiomaticRootBody(snapshot.root);
    if (canonicalize(normalizedRoot) !== canonicalize(snapshot.root)) {
      fail("AXIOMATIC_PUBLIC_SNAPSHOT_NON_CANONICAL", "snapshot.root is not canonical");
    }
    if (!Array.isArray(snapshot.runs)) {
      fail("AXIOMATIC_PUBLIC_INVALID_SHAPE", "snapshot.runs must be an array");
    }
    const normalizedRuns = snapshot.runs.map((run) => normalizeStoredRun(run));
    if (canonicalize(normalizedRuns) !== canonicalize(snapshot.runs)) {
      fail("AXIOMATIC_PUBLIC_SNAPSHOT_NON_CANONICAL", "snapshot.runs are not canonical");
    }
    const restored = new InMemoryAgentRuntime(normalizedRoot);
    for (const run of normalizedRuns) restored.#runNormalized(run, true);
    if (restored.#runs.length !== normalizedRuns.length) {
      fail("AXIOMATIC_PUBLIC_SNAPSHOT_NON_CANONICAL", "snapshot contains a duplicate run");
    }
    if (restored.stateRef() !== snapshot.stateRef) {
      fail("AXIOMATIC_PUBLIC_SNAPSHOT_MISMATCH", "snapshot does not reproduce stateRef");
    }
    return restored;
  }

  root(): RootView {
    return this.#runtime.rootOf(this.#root.root);
  }

  run(input: RunInMemoryEvaluationInput): InMemoryEvaluationResult {
    return this.#runNormalized(normalizeRun(input), true);
  }

  path(head: AxiomaticRevisionRef): readonly AxiomaticRevisionRef[] {
    return this.#runtime.path(head);
  }

  node(ref: AxiomaticNodeRef): NodeView {
    return this.#runtime.getNode(ref);
  }

  evaluation(ref: EvaluationRunRef): EvaluationView {
    return this.#runtime.getEvaluation(ref);
  }

  state(): InMemoryRuntimeStateV1 {
    return Object.freeze({
      version: "in-memory-runtime-state/v1",
      ledger: this.#runtime.state(),
      requests: Object.freeze(
        [...this.#requests.values()].toSorted((left, right) =>
          Buffer.from(left.ref, "utf8").compare(Buffer.from(right.ref, "utf8")),
        ),
      ),
      runs: Object.freeze([...this.#runs]),
    });
  }

  stateRef(): string {
    return stateRef(this.state());
  }

  snapshot(): InMemoryRuntimeSnapshotV1 {
    return copy({
      version: "in-memory-runtime-snapshot/v1",
      root: this.#root.body,
      runs: this.#runs,
      stateRef: this.stateRef(),
    } as unknown as CanonicalValue) as unknown as InMemoryRuntimeSnapshotV1;
  }

  #runNormalized(
    input: InMemorySnapshotRunV1,
    record: boolean,
  ): InMemoryEvaluationResult {
    this.#runtime.rootOf(input.parent);
    const invocationKey = canonicalize({ source: input.source, position: input.position });
    const invocationValue = canonicalize(input.input);
    const existingInvocation = this.#invocationClaims.get(invocationKey);
    if (existingInvocation !== undefined && existingInvocation !== invocationValue) {
      fail(
        "AXIOMATIC_OCCURRENCE_CONFLICT",
        "the same invocation source position cannot contain different input",
      );
    }
    const evaluationIntentValue = {
      parent: input.parent,
      invocation: {
        source: input.source,
        position: input.position,
        input: input.input,
      },
      environment: input.environment,
      evaluator: input.evaluator,
    };
    const resolvedEvaluationOccurrence = input.evaluationOccurrence ?? {
      source: "builtin.default-evaluation/v1",
      position: evaluationIntentValue,
    };
    const evaluationClaimKey = canonicalize(resolvedEvaluationOccurrence);
    const evaluationIntent = canonicalize(evaluationIntentValue);
    const existingIntent = this.#evaluationOccurrenceClaims.get(evaluationClaimKey);
    if (existingIntent !== undefined && existingIntent !== evaluationIntent) {
      fail(
        "AXIOMATIC_EVALUATION_OCCURRENCE_CONFLICT",
        "the same evaluation occurrence cannot bind a different intent",
      );
    }

    const occurrence = this.#runtime.materializeInvocationOccurrence(
      input.source,
      input.position,
      input.input as unknown as CanonicalValue,
    );
    const evaluationOccurrence: EvaluationOccurrenceRef =
      this.#runtime.materializeEvaluationOccurrence(
        resolvedEvaluationOccurrence.source,
        resolvedEvaluationOccurrence.position as unknown as CanonicalValue,
      ).ref;
    const environment = this.#runtime.materializeEnvironment(
      input.environment as unknown as CanonicalValue,
    );
    const endpoint = this.#runtime.materializeEndpoint({
      version: "offline-endpoint/v1",
      evaluator: input.evaluator,
    });
    this.#evaluatorsByEndpoint.set(endpoint, input.evaluator);
    const evaluation = this.#runtime.prepareEvaluation({
      parent: input.parent,
      occurrence: occurrence.ref,
      evaluationOccurrence,
      environment,
      endpoint,
      projectionPolicy: COMPLETE_PATH_PROJECTION,
    });

    const existing = this.#resultFor(evaluation);
    if (existing) return existing;

    const projection = this.#runtime.getProjection(
      this.#runtime.getEvaluation(evaluation).projection,
    );
    const request = compileOfflineRequest(
      this.#runtime,
      projection,
      this.#evaluatorsByEndpoint,
    );
    this.#requests.set(request.ref, request);
    this.#runtime.claimEvaluationAttempt(evaluation);
    const evaluated = executeEvaluator(request.evaluator, request);
    if (evaluated.kind === "completed") {
      this.#runtime.recordEmission({
        evaluation,
        ordinal: 0,
        producer: "offline-evaluator/v1",
        protocol: input.evaluator.kind,
        payload: evaluated.output as unknown as CanonicalValue,
      });
      this.#runtime.completeEvaluation(evaluation, "completed", {
        version: "offline-outcome/v1",
        finish: "complete",
      });
    } else {
      this.#runtime.completeEvaluation(evaluation, "failed", evaluated.details);
    }
    const adoption = this.#runtime.adoptEvaluation(evaluation, COMPLETE_OUTPUT_ADOPTION);
    this.#invocationClaims.set(invocationKey, invocationValue);
    this.#evaluationOccurrenceClaims.set(evaluationClaimKey, evaluationIntent);
    if (record) this.#runs.push(input);
    return this.#resultFor(evaluation, adoption)!;
  }

  #resultFor(
    evaluationRef: EvaluationRunRef,
    knownAdoption?: AdoptionResult,
  ): InMemoryEvaluationResult | undefined {
    const evaluation = this.#runtime.getEvaluation(evaluationRef);
    if (evaluation.status !== "completed" && evaluation.status !== "failed") return undefined;
    const state = this.#runtime.state();
    const adoption = knownAdoption ?? state.adoptions.find((item) => item.evaluation === evaluationRef);
    if (!adoption || !evaluation.outcome) return undefined;
    const projection = state.projections.find((item) => item.ref === evaluation.projection);
    if (!projection) fail("AXIOMATIC_CORRUPT_STATE", "evaluation projection is missing");
    const expectedRequest = compileOfflineRequest(
      this.#runtime,
      projection,
      this.#evaluatorsByEndpoint,
    );
    const request = this.#requests.get(expectedRequest.ref);
    if (!request) fail("AXIOMATIC_CORRUPT_STATE", "evaluation request is missing");
    const emissions = state.emissions.filter((item) => item.evaluation === evaluationRef);
    return Object.freeze({
      evaluation: evaluationRef,
      parent: evaluation.parent,
      head: adoption.node?.ref ?? evaluation.parent,
      status: evaluation.status,
      projection,
      request,
      emissions: Object.freeze(emissions),
      outcome: evaluation.outcome,
      adoption,
    });
  }
}

export function createInMemoryAgentRuntime(root: AxiomaticRootBody): InMemoryAgentRuntime {
  return new InMemoryAgentRuntime(root);
}

export function restoreInMemoryAgentRuntime(
  snapshot: InMemoryRuntimeSnapshotV1,
): InMemoryAgentRuntime {
  return InMemoryAgentRuntime.fromSnapshot(snapshot);
}

export function inMemoryRuntimeStateRef(state: InMemoryRuntimeStateV1): string {
  return stateRef(copy(asCanonical(state)) as unknown as InMemoryRuntimeStateV1);
}
