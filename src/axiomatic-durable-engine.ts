import {
  canonicalize,
  contentRef,
  immutableCanonicalCopy,
} from "./canonical-v1.ts";
import { SemanticError, STORAGE_CODES } from "./errors.ts";
import { AxiomaticSqliteConnection } from "./axiomatic-sqlite-connection.ts";
import {
  AXIOMATIC_V2_DOMAINS,
  AxiomaticRuntimeV2,
  normalizeAxiomaticRootBody,
  normalizeAxiomaticSemanticItems,
  type AdoptionDecision,
  type AdoptionResult,
  type AxiomaticRevisionRef,
  type AxiomaticRootBody,
  type AxiomaticStateView,
  type EvaluationRunRef,
  type EvaluationStatus,
  type EvaluationView,
  type PolicyIdentity,
  type ProjectionDraft,
  type ProjectionPlanView,
  type RootView,
  type SemanticBlock,
  type SemanticItem,
} from "./axiomatic-v2.ts";
import type {
  AxiomaticModelRequestV2,
  DurableProviderRequest,
  ModelAdapterId,
  ModelEndpointV2,
  ModelProviderId,
} from "./model-contract.ts";
import type { CanonicalObject, CanonicalValue } from "./types.ts";

const COMMAND_DOMAIN = "axiomatic-command/v1";
const DURABLE_STATE_DOMAIN = "axiomatic-durable-state/v1";
const LEGACY_PROVIDER_REQUEST_DOMAIN = "axiomatic-provider-request/v1";
const MODEL_REQUEST_DOMAIN = "axiomatic-model-request/v2";
const COMMAND_VERSION = "axiomatic-command/v1" as const;
const REF = /^sha256:[0-9a-f]{64}$/;

export type AxiomaticCommandKind =
  | "create-root"
  | "materialize-invocation"
  | "materialize-evaluation-occurrence"
  | "materialize-environment"
  | "materialize-endpoint"
  | "prepare-evaluation"
  | "record-request"
  | "claim-attempt"
  | "record-emission"
  | "complete-evaluation"
  | "mark-unknown"
  | "fail-local"
  | "adopt-evaluation";

interface CommandEnvelope {
  readonly version: typeof COMMAND_VERSION;
  readonly kind: AxiomaticCommandKind;
  readonly body: CanonicalValue;
}

interface CommandRow {
  readonly seq: bigint;
  readonly command_ref: string;
  readonly command_kind: AxiomaticCommandKind;
  readonly body_bytes: Uint8Array;
  readonly result_bytes: Uint8Array;
}

interface CommandHeadRow {
  readonly command_seq: bigint;
  readonly command_ref: string;
  readonly state_ref: string;
}

export interface AxiomaticProviderRequestV1 {
  readonly ref: string;
  readonly version: "axiomatic-provider-request/v1";
  readonly evaluation: EvaluationRunRef;
  readonly projection: string;
  readonly endpoint: string;
  readonly provider: "opencode-go";
  readonly baseUrl: string;
  readonly model: string;
  readonly root: AxiomaticRootBody;
  readonly modelInput: {
    readonly version: "axiomatic-model-input/v1";
    readonly history: readonly SemanticBlock[];
    readonly candidateInput: readonly SemanticItem[];
    readonly environment: CanonicalValue;
  };
}

export interface PreparedDurableEvaluation {
  readonly evaluation: EvaluationRunRef;
  readonly projection: ProjectionPlanView;
  readonly request: DurableProviderRequest;
}

export interface DurableStateView {
  readonly version: "axiomatic-durable-state/v1";
  readonly ledger: AxiomaticStateView;
  readonly materialRefs: readonly string[];
  readonly requests: readonly DurableProviderRequest[];
}

interface ReplayState {
  readonly runtime: AxiomaticRuntimeV2;
  readonly requests: Map<string, DurableProviderRequest>;
  readonly materials: Map<string, CanonicalValue>;
}

interface DurableCommandRecord {
  readonly ref: string;
  readonly envelope: CommandEnvelope;
  readonly result: CanonicalValue;
}

interface ProjectionRecord {
  readonly ref: string;
  readonly kind: string;
  readonly body: CanonicalValue;
}

const PROJECTION_POLICY: PolicyIdentity & { readonly kind: "projection" } = Object.freeze({
  kind: "projection",
  name: "builtin.complete-path",
  version: "v2",
});

const ADOPTION_POLICY: PolicyIdentity & { readonly kind: "adoption" } = Object.freeze({
  kind: "adoption",
  name: "builtin.complete-output",
  version: "v2",
});

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function copy<T extends CanonicalValue>(value: T): T {
  return immutableCanonicalCopy(value);
}

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(STORAGE_CODES.CORRUPT, `${label} must be an object`);
  }
}

function exact(value: object, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const expected = [...fields].toSorted();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(STORAGE_CODES.CORRUPT, `${label} has an invalid field set`);
  }
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail("AXIOMATIC_DURABLE_INVALID_INPUT", `${label} must be a non-empty string`);
  }
}

function ref(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !REF.test(value)) {
    fail(STORAGE_CODES.CORRUPT, `${label} is not a content reference`);
  }
}

function encode(value: CanonicalValue): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

function decode(bytes: Uint8Array, label: string): CanonicalValue {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(STORAGE_CODES.CORRUPT, `${label} is not UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(STORAGE_CODES.CORRUPT, `${label} is not JSON`);
  }
  try {
    const value = copy(parsed as CanonicalValue);
    if (canonicalize(value) !== text) fail(STORAGE_CODES.CORRUPT, `${label} is not canonical JSON`);
    return value;
  } catch (error) {
    if (error instanceof SemanticError) throw error;
    fail(STORAGE_CODES.CORRUPT, `${label} is not a canonical value`);
  }
}

function commandRef(envelope: CommandEnvelope): string {
  return contentRef(COMMAND_DOMAIN, envelope as unknown as CanonicalValue);
}

function sortedRequests(requests: ReadonlyMap<string, DurableProviderRequest>): readonly DurableProviderRequest[] {
  return Object.freeze(
    [...requests.values()].toSorted((left, right) =>
      Buffer.from(left.ref, "utf8").compare(Buffer.from(right.ref, "utf8")),
    ),
  );
}

function durableState(state: ReplayState): DurableStateView {
  return Object.freeze({
    version: "axiomatic-durable-state/v1",
    ledger: state.runtime.state(),
    materialRefs: Object.freeze(
      [...state.materials.keys()].toSorted((left, right) =>
        Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")),
      ),
    ),
    requests: sortedRequests(state.requests),
  });
}

function durableStateRef(state: ReplayState): string {
  return contentRef(DURABLE_STATE_DOMAIN, durableState(state) as unknown as CanonicalValue);
}

function normalizeInput(value: unknown): readonly SemanticItem[] {
  const items = normalizeAxiomaticSemanticItems(value as readonly SemanticItem[], "durable input");
  if (items.some((item) => !((item.kind === "message" && item.role === "user") || item.kind === "tool-result"))) {
    fail("AXIOMATIC_DURABLE_INVALID_INPUT", "model input accepts only user messages and tool results");
  }
  return items;
}

function normalizeOutput(value: unknown): readonly SemanticItem[] {
  const items = normalizeAxiomaticSemanticItems(value as readonly SemanticItem[], "durable output");
  if (items.some((item) => !((item.kind === "message" && item.role === "assistant") || item.kind === "thinking" || item.kind === "tool-call"))) {
    fail("AXIOMATIC_DURABLE_INVALID_OUTPUT", "model output contains an input-only item");
  }
  return items;
}

function projectionRecords(state: AxiomaticStateView): readonly ProjectionRecord[] {
  const records: ProjectionRecord[] = [];
  for (const item of state.invocationOccurrences) {
    records.push({ ref: item.ref, kind: "invocation-occurrence", body: item as unknown as CanonicalValue });
  }
  for (const item of state.evaluationOccurrences) {
    records.push({ ref: item.ref, kind: "evaluation-occurrence", body: item as unknown as CanonicalValue });
  }
  for (const item of state.projections) {
    records.push({ ref: item.ref, kind: "projection", body: item as unknown as CanonicalValue });
  }
  for (const item of state.evaluations) {
    records.push({
      ref: item.ref,
      kind: "evaluation",
      body: {
        ref: item.ref,
        root: item.root,
        parent: item.parent,
        occurrence: item.occurrence,
        evaluationOccurrence: item.evaluationOccurrence,
        projection: item.projection,
      },
    });
    if (item.attempt) records.push({ ref: item.attempt.ref, kind: "attempt", body: item.attempt as unknown as CanonicalValue });
    if (item.outcome) records.push({ ref: item.outcome.ref, kind: "outcome", body: item.outcome as unknown as CanonicalValue });
    if (item.unknown) records.push({ ref: item.unknown.ref, kind: "unknown", body: item.unknown as unknown as CanonicalValue });
    if (item.localFailure) records.push({ ref: item.localFailure.ref, kind: "local-failure", body: item.localFailure as unknown as CanonicalValue });
  }
  for (const item of state.emissions) {
    records.push({ ref: item.ref, kind: "emission", body: item as unknown as CanonicalValue });
  }
  return records;
}

function bodyObject(command: CommandEnvelope, fields: readonly string[]): Record<string, unknown> {
  object(command.body, `${command.kind}.body`);
  exact(command.body, fields, `${command.kind}.body`);
  return command.body;
}

function endpointValue(state: ReplayState, endpoint: string): CanonicalObject {
  const value = state.materials.get(endpoint);
  object(value, "endpoint material");
  if (contentRef(AXIOMATIC_V2_DOMAINS.endpoint, value) !== endpoint) {
    fail(STORAGE_CODES.CORRUPT, "endpoint material does not match its content reference");
  }
  return value as CanonicalObject;
}

function isProvider(value: unknown): value is ModelProviderId {
  return value === "opencode-go" || value === "openai" || value === "anthropic";
}

function isAdapter(value: unknown): value is ModelAdapterId {
  return value === "openai-chat-completions/v1" ||
    value === "openai-responses/v1" ||
    value === "anthropic-messages/v1";
}

function validProviderAdapter(provider: ModelProviderId, adapter: ModelAdapterId): boolean {
  return (provider === "opencode-go" && adapter === "openai-chat-completions/v1") ||
    (provider === "openai" && (
      adapter === "openai-chat-completions/v1" || adapter === "openai-responses/v1"
    )) ||
    (provider === "anthropic" && adapter === "anthropic-messages/v1");
}

function validateModelEndpoint(value: CanonicalObject): asserts value is CanonicalObject & ModelEndpointV2 {
  const fields = value.maxTokens === undefined
    ? ["version", "provider", "adapter", "baseUrl", "model"]
    : ["version", "provider", "adapter", "baseUrl", "model", "maxTokens"];
  exact(value, fields, "model endpoint");
  const maxTokens = value.maxTokens;
  if (
    value.version !== "model-endpoint/v2" ||
    !isProvider(value.provider) ||
    !isAdapter(value.adapter) ||
    !validProviderAdapter(value.provider, value.adapter) ||
    typeof value.baseUrl !== "string" ||
    value.baseUrl.length === 0 ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    (maxTokens !== undefined && (
      typeof maxTokens !== "number" ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < 1 ||
      maxTokens > 1_000_000
    ))
  ) {
    fail("AXIOMATIC_DURABLE_INVALID_ENDPOINT", "endpoint is not a supported model endpoint/v2");
  }
  let url: URL;
  try {
    url = new URL(value.baseUrl);
  } catch {
    fail("AXIOMATIC_DURABLE_INVALID_ENDPOINT", "model endpoint baseUrl is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !value.baseUrl.endsWith("/") ||
    url.toString() !== value.baseUrl
  ) {
    fail("AXIOMATIC_DURABLE_INVALID_ENDPOINT", "model endpoint baseUrl is not canonical HTTPS");
  }
}

function compileProviderRequest(
  state: ReplayState,
  evaluationRef: EvaluationRunRef,
): DurableProviderRequest {
  const evaluation = state.runtime.getEvaluation(evaluationRef);
  const projection = state.runtime.getProjection(evaluation.projection);
  const root = state.runtime.rootOf(evaluation.parent);
  const endpoint = endpointValue(state, projection.endpoint);
  object(projection.appendContent, "ProjectionPlan.appendContent");
  exact(
    projection.appendContent,
    ["version", "history", "candidateInput", "environment"],
    "ProjectionPlan.appendContent",
  );
  if (
    projection.appendContent.version !== "axiomatic-model-input/v1" ||
    !Array.isArray(projection.appendContent.history) ||
    !Array.isArray(projection.appendContent.candidateInput)
  ) {
    fail(STORAGE_CODES.CORRUPT, "ProjectionPlan append content is not model input/v1");
  }
  const history = projection.selectedNodes.map((node) => state.runtime.getNode(node).block);
  if (canonicalize(history) !== canonicalize(projection.appendContent.history)) {
    fail(STORAGE_CODES.CORRUPT, "ProjectionPlan history does not match selectedNodes");
  }
  const candidateInput = normalizeInput(projection.appendContent.candidateInput);
  const modelInput = {
    version: "axiomatic-model-input/v1" as const,
    history,
    candidateInput,
    environment: copy(projection.appendContent.environment as CanonicalValue),
  };
  if (endpoint.version === "opencode-go-endpoint/v1") {
    exact(endpoint, ["version", "provider", "baseUrl", "model"], "legacy endpoint");
    if (
      endpoint.provider !== "opencode-go" ||
      typeof endpoint.baseUrl !== "string" ||
      endpoint.baseUrl.length === 0 ||
      typeof endpoint.model !== "string" ||
      endpoint.model.length === 0
    ) {
      fail("AXIOMATIC_DURABLE_INVALID_ENDPOINT", "endpoint is not an OpenCode Go endpoint/v1");
    }
    const value = {
      version: "axiomatic-provider-request/v1" as const,
      evaluation: evaluationRef,
      projection: projection.ref,
      endpoint: projection.endpoint,
      provider: "opencode-go" as const,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      root: root.body,
      modelInput,
    };
    return Object.freeze(copy({
      ref: contentRef(LEGACY_PROVIDER_REQUEST_DOMAIN, value as unknown as CanonicalValue),
      ...value,
    } as unknown as CanonicalValue) as unknown as AxiomaticProviderRequestV1);
  }
  validateModelEndpoint(endpoint);
  const value = {
    version: "axiomatic-model-request/v2" as const,
    evaluation: evaluationRef,
    projection: projection.ref,
    endpoint: projection.endpoint,
    provider: endpoint.provider,
    adapter: endpoint.adapter,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    ...(endpoint.maxTokens === undefined ? {} : { maxTokens: endpoint.maxTokens }),
    root: root.body,
    modelInput,
  };
  return Object.freeze(copy({
    ref: contentRef(MODEL_REQUEST_DOMAIN, value as unknown as CanonicalValue),
    ...value,
  } as unknown as CanonicalValue) as unknown as AxiomaticModelRequestV2);
}

function resultValue(value: unknown): CanonicalValue {
  canonicalize(value);
  return copy(value as CanonicalValue);
}

function applyCommand(state: ReplayState, command: CommandEnvelope): CanonicalValue {
  switch (command.kind) {
    case "create-root": {
      const body = bodyObject(command, ["root"]);
      return resultValue(state.runtime.createRoot(body.root as AxiomaticRootBody));
    }
    case "materialize-invocation": {
      const body = bodyObject(command, ["source", "position", "payload"]);
      nonEmpty(body.source, "source");
      return resultValue(state.runtime.materializeInvocationOccurrence(
        body.source,
        body.position as CanonicalValue,
        body.payload as CanonicalValue,
      ));
    }
    case "materialize-evaluation-occurrence": {
      const body = bodyObject(command, ["source", "position"]);
      nonEmpty(body.source, "source");
      return resultValue(state.runtime.materializeEvaluationOccurrence(
        body.source,
        body.position as CanonicalValue,
      ));
    }
    case "materialize-environment": {
      const body = bodyObject(command, ["value"]);
      const value = copy(body.value as CanonicalValue);
      const artifact = state.runtime.materializeEnvironment(value);
      state.materials.set(artifact, value);
      return artifact;
    }
    case "materialize-endpoint": {
      const body = bodyObject(command, ["value"]);
      const value = copy(body.value as CanonicalValue);
      const artifact = state.runtime.materializeEndpoint(value);
      state.materials.set(artifact, value);
      return artifact;
    }
    case "prepare-evaluation": {
      const body = bodyObject(command, [
        "parent",
        "occurrence",
        "evaluationOccurrence",
        "environment",
        "endpoint",
        "projectionPolicyIdentity",
        "explicitInputs",
        "draft",
      ]);
      return state.runtime.prepareEvaluationFromDraft({
        parent: body.parent as string,
        occurrence: body.occurrence as string,
        evaluationOccurrence: body.evaluationOccurrence as string,
        environment: body.environment as string,
        endpoint: body.endpoint as string,
        projectionPolicyIdentity: body.projectionPolicyIdentity as PolicyIdentity & { kind: "projection" },
        explicitInputs: body.explicitInputs as CanonicalValue,
        draft: body.draft as ProjectionDraft,
      });
    }
    case "record-request": {
      const body = bodyObject(command, ["evaluation"]);
      ref(body.evaluation, "evaluation");
      const request = compileProviderRequest(state, body.evaluation);
      const existing = state.requests.get(request.ref);
      if (existing && canonicalize(existing) !== canonicalize(request)) {
        fail(STORAGE_CODES.CORRUPT, "provider request content reference collision");
      }
      state.requests.set(request.ref, request);
      return resultValue(request as unknown as CanonicalValue);
    }
    case "claim-attempt": {
      const body = bodyObject(command, ["evaluation"]);
      ref(body.evaluation, "evaluation");
      return resultValue(state.runtime.claimEvaluationAttempt(body.evaluation));
    }
    case "record-emission": {
      const body = bodyObject(command, ["evaluation", "ordinal", "producer", "protocol", "payload"]);
      return state.runtime.recordEmission({
        evaluation: body.evaluation as string,
        ordinal: body.ordinal as number,
        producer: body.producer as string,
        protocol: body.protocol as string,
        payload: body.payload as CanonicalValue,
      });
    }
    case "complete-evaluation": {
      const body = bodyObject(command, ["evaluation", "kind", "details"]);
      return state.runtime.completeEvaluation(
        body.evaluation as string,
        body.kind as "completed" | "failed",
        body.details as CanonicalValue,
      );
    }
    case "mark-unknown": {
      const body = bodyObject(command, ["evaluation", "reason"]);
      state.runtime.markUnknown(body.evaluation as string, body.reason as CanonicalValue);
      return resultValue(state.runtime.getEvaluation(body.evaluation as string));
    }
    case "fail-local": {
      const body = bodyObject(command, ["evaluation", "phase", "reason"]);
      return resultValue(state.runtime.failEvaluationLocally(
        body.evaluation as string,
        body.phase as string,
        body.reason as CanonicalValue,
      ));
    }
    case "adopt-evaluation": {
      const body = bodyObject(command, ["evaluation", "policyIdentity", "decision", "explicitInputs"]);
      return resultValue(state.runtime.adoptEvaluationDecision(
        body.evaluation as string,
        body.policyIdentity as PolicyIdentity & { kind: "adoption" },
        body.decision as AdoptionDecision,
        body.explicitInputs as CanonicalValue,
      ));
    }
  }
}

function replay(records: readonly DurableCommandRecord[]): ReplayState {
  const state: ReplayState = {
    runtime: new AxiomaticRuntimeV2(),
    requests: new Map(),
    materials: new Map(),
  };
  for (const record of records) {
    const expectedRef = commandRef(record.envelope);
    if (record.ref !== expectedRef) fail(STORAGE_CODES.CORRUPT, `command ${record.ref} hash mismatch`);
    const result = applyCommand(state, record.envelope);
    if (canonicalize(result) !== canonicalize(record.result)) {
      fail(STORAGE_CODES.CORRUPT, `command ${record.ref} replay result mismatch`);
    }
  }
  return state;
}

function commandEnvelope(kind: AxiomaticCommandKind, body: CanonicalValue): CommandEnvelope {
  const envelope = {
    version: COMMAND_VERSION,
    kind,
    body: copy(body),
  };
  return copy(envelope as unknown as CanonicalValue) as unknown as CommandEnvelope;
}

function parseCommandRow(row: CommandRow): DurableCommandRecord {
  const body = decode(row.body_bytes, `command ${row.command_ref} body`);
  const result = decode(row.result_bytes, `command ${row.command_ref} result`);
  object(body, `command ${row.command_ref}`);
  exact(body, ["version", "kind", "body"], `command ${row.command_ref}`);
  if (body.version !== COMMAND_VERSION || body.kind !== row.command_kind) {
    fail(STORAGE_CODES.CORRUPT, `command ${row.command_ref} envelope mismatch`);
  }
  return {
    ref: row.command_ref,
    envelope: body as unknown as CommandEnvelope,
    result,
  };
}

export class AxiomaticDurableEngine {
  readonly #connection: AxiomaticSqliteConnection;
  #records: DurableCommandRecord[];
  #state: ReplayState;
  #headRef: string | undefined;
  #headStateRef: string | undefined;
  #headSeq = 0n;

  private constructor(
    connection: AxiomaticSqliteConnection,
    records: DurableCommandRecord[],
    state: ReplayState,
    head?: CommandHeadRow,
  ) {
    this.#connection = connection;
    this.#records = records;
    this.#state = state;
    this.#headRef = head?.command_ref;
    this.#headStateRef = head?.state_ref;
    this.#headSeq = head?.command_seq ?? 0n;
  }

  static open(
    connection: AxiomaticSqliteConnection,
    root?: AxiomaticRootBody,
  ): AxiomaticDurableEngine {
    const engine = connection.withReadTransaction(() => {
      const rows = connection.allBigInt<CommandRow>(
        "SELECT seq, command_ref, command_kind, body_bytes, result_bytes FROM axiomatic_commands ORDER BY seq",
      );
      for (const [index, row] of rows.entries()) {
        if (row.seq !== BigInt(index + 1)) fail(STORAGE_CODES.CORRUPT, "axiomatic command seq has a gap");
      }
      const records = rows.map(parseCommandRow);
      const state = replay(records);
      const head = connection.getBigInt<CommandHeadRow>(
        "SELECT command_seq, command_ref, state_ref FROM axiomatic_command_head WHERE singleton = 1",
      );
      if (records.length === 0) {
        if (head) fail(STORAGE_CODES.CORRUPT, "empty command journal has a head");
        return new AxiomaticDurableEngine(connection, records, state);
      }
      const last = records.at(-1)!;
      if (
        !head ||
        head.command_seq !== BigInt(records.length) ||
        head.command_ref !== last.ref ||
        head.state_ref !== durableStateRef(state)
      ) {
        fail(STORAGE_CODES.CORRUPT, "axiomatic command head does not match replayed state");
      }
      const loaded = new AxiomaticDurableEngine(connection, records, state, head);
      loaded.#auditProjections();
      return loaded;
    });
    if (engine.#records.length === 0) {
      if (root === undefined) fail("AXIOMATIC_DURABLE_ROOT_REQUIRED", "new durable runtime requires Root");
      engine.#execute("create-root", {
        root: normalizeAxiomaticRootBody(root),
      } as unknown as CanonicalValue);
      return engine;
    }
    if (root !== undefined && canonicalize(engine.root().body) !== canonicalize(normalizeAxiomaticRootBody(root))) {
      fail("AXIOMATIC_DURABLE_ROOT_MISMATCH", "durable Root does not match the requested Root");
    }
    engine.#recoverUnadoptedTerminalEvaluations();
    engine.#recoverAttemptedEvaluations();
    return engine;
  }

  root(): RootView {
    const roots = this.#state.runtime.state().roots;
    if (roots.length !== 1) fail(STORAGE_CODES.CORRUPT, "durable runtime must contain exactly one Root");
    return roots[0]!;
  }

  state(): DurableStateView {
    return durableState(this.#state);
  }

  stateRef(): string {
    return durableStateRef(this.#state);
  }

  request(refValue: string): DurableProviderRequest {
    const request = this.#state.requests.get(refValue);
    if (!request) fail("AXIOMATIC_DURABLE_UNKNOWN_REQUEST", `unknown provider request ${refValue}`);
    return copy(request as unknown as CanonicalValue) as unknown as DurableProviderRequest;
  }

  /** Returns the latest persisted endpoint binding for restart configuration. */
  modelEndpoint(): ModelEndpointV2 | undefined {
    for (const record of [...this.#records].toReversed()) {
      if (record.envelope.kind !== "record-request") continue;
      const request = record.result as unknown as DurableProviderRequest;
      if (request.version === "axiomatic-model-request/v2") {
        return Object.freeze({
          version: "model-endpoint/v2",
          provider: request.provider,
          adapter: request.adapter,
          baseUrl: request.baseUrl,
          model: request.model,
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        });
      }
      return Object.freeze({
        version: "model-endpoint/v2",
        provider: "opencode-go",
        adapter: "openai-chat-completions/v1",
        baseUrl: request.baseUrl,
        model: request.model,
      });
    }
    return undefined;
  }

  evaluation(refValue: EvaluationRunRef): EvaluationView {
    return this.#state.runtime.getEvaluation(refValue);
  }

  path(head: AxiomaticRevisionRef): readonly AxiomaticRevisionRef[] {
    return this.#state.runtime.path(head);
  }

  prepareEvaluation(input: {
    readonly parent: AxiomaticRevisionRef;
    readonly source: string;
    readonly position: CanonicalValue;
    readonly input: readonly SemanticItem[];
    readonly environment: CanonicalValue;
    readonly endpoint: CanonicalObject;
    readonly evaluationOccurrence?: {
      readonly source: string;
      readonly position: CanonicalValue;
    };
  }): PreparedDurableEvaluation {
    const candidateInput = normalizeInput(input.input);
    this.#state.runtime.rootOf(input.parent);
    object(input.endpoint, "endpoint");
    if (input.endpoint.version === "opencode-go-endpoint/v1") {
      exact(input.endpoint, ["version", "provider", "baseUrl", "model"], "legacy endpoint");
      if (
        input.endpoint.provider !== "opencode-go" ||
        typeof input.endpoint.baseUrl !== "string" ||
        typeof input.endpoint.model !== "string"
      ) {
        fail("AXIOMATIC_DURABLE_INVALID_ENDPOINT", "endpoint is not an OpenCode Go endpoint/v1");
      }
    } else {
      validateModelEndpoint(input.endpoint);
    }
    const occurrence = this.#execute("materialize-invocation", {
      source: input.source,
      position: input.position,
      payload: candidateInput,
    }) as unknown as { readonly ref: string };
    const environment = this.#execute("materialize-environment", {
      value: input.environment,
    }) as string;
    const endpoint = this.#execute("materialize-endpoint", {
      value: input.endpoint,
    }) as string;
    const evaluationPosition = input.evaluationOccurrence ?? {
      source: input.endpoint.version === "opencode-go-endpoint/v1"
        ? "opencode-go/default-evaluation/v1"
        : "model/default-evaluation/v2",
      position: {
        parent: input.parent,
        invocation: occurrence.ref,
        environment,
        endpoint,
        projectionPolicyIdentity: PROJECTION_POLICY,
      } as unknown as CanonicalValue,
    };
    const evaluationOccurrence = this.#execute("materialize-evaluation-occurrence", {
      source: evaluationPosition.source,
      position: evaluationPosition.position,
    }) as unknown as { readonly ref: string };
    const path = this.#state.runtime.path(input.parent);
    const selectedNodes = path.slice(1);
    const history = selectedNodes.map((node) => this.#state.runtime.getNode(node).block);
    const draft: ProjectionDraft = {
      selectedNodes,
      appendContent: {
        version: "axiomatic-model-input/v1",
        history,
        candidateInput,
        environment: input.environment,
      } as unknown as CanonicalValue,
    };
    const evaluation = this.#execute("prepare-evaluation", {
      parent: input.parent,
      occurrence: occurrence.ref,
      evaluationOccurrence: evaluationOccurrence.ref,
      environment,
      endpoint,
      projectionPolicyIdentity: PROJECTION_POLICY,
      explicitInputs: null,
      draft,
    } as unknown as CanonicalValue) as string;
    const request = this.#execute("record-request", { evaluation }) as unknown as DurableProviderRequest;
    return Object.freeze({
      evaluation,
      projection: this.#state.runtime.getProjection(
        this.#state.runtime.getEvaluation(evaluation).projection,
      ),
      request,
    });
  }

  /** Historical v1 compatibility alias; new callers use prepareEvaluation. */
  prepareOpenCodeEvaluation(input: {
    readonly parent: AxiomaticRevisionRef;
    readonly source: string;
    readonly position: CanonicalValue;
    readonly input: readonly SemanticItem[];
    readonly environment: CanonicalValue;
    readonly endpoint: CanonicalObject;
    readonly evaluationOccurrence?: {
      readonly source: string;
      readonly position: CanonicalValue;
    };
  }): PreparedDurableEvaluation {
    return this.prepareEvaluation(input);
  }

  claimAttempt(evaluation: EvaluationRunRef): EvaluationView {
    const current = this.#state.runtime.getEvaluation(evaluation);
    if (current.status !== "prepared") {
      fail(
        "AXIOMATIC_EVALUATION_NOT_DISPATCHABLE",
        "durable Evaluation 没有新的外部 attempt 资格",
      );
    }
    if (![...this.#state.requests.values()].some((request) => request.evaluation === evaluation)) {
      fail(
        "AXIOMATIC_REQUEST_NOT_DURABLE",
        "provider request 必须在 attempt 之前持久化",
      );
    }
    return this.#execute("claim-attempt", { evaluation }) as unknown as EvaluationView;
  }

  recordEmission(input: {
    readonly evaluation: EvaluationRunRef;
    readonly ordinal: number;
    readonly producer: string;
    readonly protocol: string;
    readonly payload: readonly SemanticItem[];
  }): string {
    return this.#execute("record-emission", {
      ...input,
      payload: normalizeOutput(input.payload),
    }) as string;
  }

  complete(
    evaluation: EvaluationRunRef,
    kind: "completed" | "failed",
    details: CanonicalValue,
  ): string {
    return this.#execute("complete-evaluation", { evaluation, kind, details }) as string;
  }

  markUnknown(evaluation: EvaluationRunRef, reason: CanonicalValue): EvaluationView {
    return this.#execute("mark-unknown", { evaluation, reason }) as unknown as EvaluationView;
  }

  failLocal(
    evaluation: EvaluationRunRef,
    phase: string,
    reason: CanonicalValue,
  ): CanonicalValue {
    return this.#execute("fail-local", { evaluation, phase, reason });
  }

  adoptCompleted(
    evaluation: EvaluationRunRef,
    candidateInput: readonly SemanticItem[],
    output: readonly SemanticItem[],
  ): AdoptionResult {
    const decision: AdoptionDecision = {
      kind: "adopt",
      block: {
        version: "evaluation-frame/v2",
        input: normalizeInput(candidateInput),
        output: normalizeOutput(output),
      },
    };
    return this.#execute("adopt-evaluation", {
      evaluation,
      policyIdentity: ADOPTION_POLICY,
      decision,
      explicitInputs: null,
    } as unknown as CanonicalValue) as unknown as AdoptionResult;
  }

  reject(
    evaluation: EvaluationRunRef,
    reason: CanonicalValue,
  ): AdoptionResult {
    return this.#execute("adopt-evaluation", {
      evaluation,
      policyIdentity: ADOPTION_POLICY,
      decision: { kind: "reject", reason },
      explicitInputs: null,
    } as unknown as CanonicalValue) as unknown as AdoptionResult;
  }

  close(): void {
    this.#connection.close();
  }

  #execute(kind: AxiomaticCommandKind, body: CanonicalValue): CanonicalValue {
    const envelope = commandEnvelope(kind, body);
    const reference = commandRef(envelope);
    const existing = this.#records.find((record) => record.ref === reference);
    if (existing) return copy(existing.result);

    const candidateRecords = [...this.#records];
    const candidateState = replay(candidateRecords);
    const result = applyCommand(candidateState, envelope);
    const resultStateRef = durableStateRef(candidateState);
    const baseHeadRef = this.#headRef;
    const baseHeadStateRef = this.#headStateRef;
    const baseHeadSeq = this.#headSeq;
    let sequence = 0n;
    this.#connection.withImmediateTransaction(() => {
      const durableHead = this.#connection.getBigInt<CommandHeadRow>(
        "SELECT command_seq, command_ref, state_ref FROM axiomatic_command_head WHERE singleton = 1",
      );
      if (
        (baseHeadStateRef === undefined && durableHead !== undefined) ||
        (baseHeadStateRef !== undefined && (
          !durableHead ||
          durableHead.command_seq !== baseHeadSeq ||
          durableHead.command_ref !== baseHeadRef ||
          durableHead.state_ref !== baseHeadStateRef
        ))
      ) {
        fail(
          "AXIOMATIC_SQLITE_CONFLICT",
          "durable command head advanced concurrently; reopen before retry",
        );
      }
      this.#connection.run(
        "INSERT INTO axiomatic_commands(command_ref, command_kind, body_bytes, result_bytes) VALUES (?, ?, ?, ?)",
        reference,
        kind,
        encode(envelope as unknown as CanonicalValue),
        encode(result),
      );
      const seqRow = this.#connection.getBigInt<{ seq: bigint }>(
        "SELECT seq FROM axiomatic_commands WHERE command_ref = ?",
        reference,
      );
      if (!seqRow) fail(STORAGE_CODES.CORRUPT, "inserted command has no sequence");
      sequence = seqRow.seq;
      this.#persistProjections(candidateState);
      this.#auditProjections(candidateState);
      if (durableHead) {
        this.#connection.run(
          "UPDATE axiomatic_command_head SET command_seq = ?, command_ref = ?, state_ref = ? WHERE singleton = 1",
          sequence,
          reference,
          resultStateRef,
        );
      } else {
        this.#connection.run(
          "INSERT INTO axiomatic_command_head(singleton, command_seq, command_ref, state_ref) VALUES (1, ?, ?, ?)",
          sequence,
          reference,
          resultStateRef,
        );
      }
    });
    const record: DurableCommandRecord = { ref: reference, envelope, result: copy(result) };
    candidateRecords.push(record);
    this.#records = candidateRecords;
    this.#state = candidateState;
    this.#headRef = reference;
    this.#headStateRef = resultStateRef;
    this.#headSeq = sequence;
    return copy(result);
  }

  #persistProjections(state: ReplayState): void {
    const ledger = state.runtime.state();
    for (const root of ledger.roots) {
      this.#insertExact(
        "axiomatic_roots",
        "root_ref",
        root.root,
        "INSERT OR IGNORE INTO axiomatic_roots(root_ref, agent_ref, body_bytes) VALUES (?, ?, ?)",
        [root.root, root.agent, encode(root.body as unknown as CanonicalValue)],
        root.body as unknown as CanonicalValue,
        "body_bytes",
      );
      this.#connection.run(
        "INSERT OR IGNORE INTO axiomatic_revisions(revision_ref, root_ref, agent_ref, revision_kind) VALUES (?, ?, ?, 'root')",
        root.root,
        root.root,
        root.agent,
      );
    }
    for (const node of ledger.nodes) {
      this.#connection.run(
        "INSERT OR IGNORE INTO axiomatic_revisions(revision_ref, root_ref, agent_ref, revision_kind) VALUES (?, ?, ?, 'node')",
        node.ref,
        node.root,
        node.agent,
      );
    }
    for (const node of ledger.nodes) {
      this.#connection.run(
        "INSERT OR IGNORE INTO axiomatic_nodes(node_ref, root_ref, agent_ref, parent_ref, block_bytes) VALUES (?, ?, ?, ?, ?)",
        node.ref,
        node.root,
        node.agent,
        node.parent,
        encode(node.block as unknown as CanonicalValue),
      );
    }
    for (const record of projectionRecords(ledger)) {
      this.#connection.run(
        "INSERT OR IGNORE INTO axiomatic_execution_records(record_ref, record_kind, body_bytes) VALUES (?, ?, ?)",
        record.ref,
        record.kind,
        encode(record.body),
      );
    }
    for (const request of state.requests.values()) {
      this.#connection.run(
        "INSERT OR IGNORE INTO axiomatic_requests(request_ref, body_bytes) VALUES (?, ?)",
        request.ref,
        encode(request as unknown as CanonicalValue),
      );
    }
    for (const adoption of ledger.adoptions) {
      this.#connection.run(
        "INSERT OR IGNORE INTO axiomatic_adoptions(adoption_key, decision_ref, body_bytes) VALUES (?, ?, ?)",
        adoption.key,
        adoption.decisionRef,
        encode(adoption as unknown as CanonicalValue),
      );
    }
  }

  #insertExact(
    table: string,
    keyColumn: string,
    key: string,
    insertSql: string,
    params: readonly unknown[],
    expectedBody: CanonicalValue,
    bodyColumn: string,
  ): void {
    this.#connection.run(insertSql, ...params);
    const row = this.#connection.get<{ body: Uint8Array }>(
      `SELECT ${bodyColumn} AS body FROM ${table} WHERE ${keyColumn} = ?`,
      key,
    );
    if (!row || canonicalize(decode(row.body, `${table}.${key}`)) !== canonicalize(expectedBody)) {
      fail(STORAGE_CODES.CORRUPT, `${table} projection mismatch for ${key}`);
    }
  }

  #auditProjections(state: ReplayState = this.#state): void {
    const expected = state.runtime.state();
    const rootRows = this.#connection.all<{ root_ref: string; agent_ref: string; body_bytes: Uint8Array }>(
      "SELECT root_ref, agent_ref, body_bytes FROM axiomatic_roots ORDER BY root_ref",
    );
    if (rootRows.length !== expected.roots.length) fail(STORAGE_CODES.CORRUPT, "root projection count mismatch");
    for (const row of rootRows) {
      const root = expected.roots.find((item) => item.root === row.root_ref);
      if (!root || root.agent !== row.agent_ref || canonicalize(decode(row.body_bytes, `root ${row.root_ref}`)) !== canonicalize(root.body as unknown as CanonicalValue)) {
        fail(STORAGE_CODES.CORRUPT, `root projection mismatch ${row.root_ref}`);
      }
    }
    const revisionRows = this.#connection.all<{ revision_ref: string; root_ref: string; agent_ref: string; revision_kind: string }>(
      "SELECT revision_ref, root_ref, agent_ref, revision_kind FROM axiomatic_revisions ORDER BY revision_ref",
    );
    if (revisionRows.length !== expected.roots.length + expected.nodes.length) fail(STORAGE_CODES.CORRUPT, "revision projection count mismatch");
    for (const row of revisionRows) {
      const root = expected.roots.find((item) => item.root === row.revision_ref);
      const node = expected.nodes.find((item) => item.ref === row.revision_ref);
      const expectedRoot = root?.root ?? node?.root;
      const expectedAgent = root?.agent ?? node?.agent;
      const expectedKind = root ? "root" : node ? "node" : undefined;
      if (!expectedRoot || !expectedAgent || !expectedKind || row.root_ref !== expectedRoot || row.agent_ref !== expectedAgent || row.revision_kind !== expectedKind) {
        fail(STORAGE_CODES.CORRUPT, `revision projection mismatch ${row.revision_ref}`);
      }
    }
    const nodeRows = this.#connection.all<{ node_ref: string; root_ref: string; agent_ref: string; parent_ref: string; block_bytes: Uint8Array }>(
      "SELECT node_ref, root_ref, agent_ref, parent_ref, block_bytes FROM axiomatic_nodes ORDER BY node_ref",
    );
    if (nodeRows.length !== expected.nodes.length) fail(STORAGE_CODES.CORRUPT, "node projection count mismatch");
    for (const row of nodeRows) {
      const node = expected.nodes.find((item) => item.ref === row.node_ref);
      if (!node || node.root !== row.root_ref || node.agent !== row.agent_ref || node.parent !== row.parent_ref || canonicalize(decode(row.block_bytes, `node ${row.node_ref}`)) !== canonicalize(node.block as unknown as CanonicalValue)) {
        fail(STORAGE_CODES.CORRUPT, `node projection mismatch ${row.node_ref}`);
      }
    }
    const records = projectionRecords(expected);
    const recordRows = this.#connection.all<{ record_ref: string; record_kind: string; body_bytes: Uint8Array }>(
      "SELECT record_ref, record_kind, body_bytes FROM axiomatic_execution_records ORDER BY record_ref",
    );
    if (recordRows.length !== records.length) fail(STORAGE_CODES.CORRUPT, "execution projection count mismatch");
    for (const row of recordRows) {
      const record = records.find((item) => item.ref === row.record_ref && item.kind === row.record_kind);
      if (!record || canonicalize(decode(row.body_bytes, `record ${row.record_ref}`)) !== canonicalize(record.body)) {
        fail(STORAGE_CODES.CORRUPT, `execution projection mismatch ${row.record_ref}`);
      }
    }
    const requestRows = this.#connection.all<{ request_ref: string; body_bytes: Uint8Array }>(
      "SELECT request_ref, body_bytes FROM axiomatic_requests ORDER BY request_ref",
    );
    if (requestRows.length !== state.requests.size) fail(STORAGE_CODES.CORRUPT, "request projection count mismatch");
    for (const row of requestRows) {
      const request = state.requests.get(row.request_ref);
      if (!request || canonicalize(decode(row.body_bytes, `request ${row.request_ref}`)) !== canonicalize(request as unknown as CanonicalValue)) {
        fail(STORAGE_CODES.CORRUPT, `request projection mismatch ${row.request_ref}`);
      }
    }
    const adoptionRows = this.#connection.all<{ adoption_key: string; decision_ref: string; body_bytes: Uint8Array }>(
      "SELECT adoption_key, decision_ref, body_bytes FROM axiomatic_adoptions ORDER BY adoption_key",
    );
    if (adoptionRows.length !== expected.adoptions.length) fail(STORAGE_CODES.CORRUPT, "adoption projection count mismatch");
    for (const row of adoptionRows) {
      const adoption = expected.adoptions.find((item) => item.key === row.adoption_key);
      if (!adoption || adoption.decisionRef !== row.decision_ref || canonicalize(decode(row.body_bytes, `adoption ${row.adoption_key}`)) !== canonicalize(adoption as unknown as CanonicalValue)) {
        fail(STORAGE_CODES.CORRUPT, `adoption projection mismatch ${row.adoption_key}`);
      }
    }
  }

  #recoverUnadoptedTerminalEvaluations(): void {
    const state = this.#state.runtime.state();
    for (const evaluation of state.evaluations) {
      if (evaluation.status === "completed" && evaluation.outcome && !state.adoptions.some((adoption) => adoption.evaluation === evaluation.ref)) {
        const request = [...this.#state.requests.values()].find((item) => item.evaluation === evaluation.ref);
        if (!request) fail(STORAGE_CODES.CORRUPT, `completed evaluation ${evaluation.ref} has no provider request`);
        const emissions = state.emissions.filter((emission) => emission.evaluation === evaluation.ref).toSorted((left, right) => left.ordinal - right.ordinal);
        if (emissions.length !== 1) fail(STORAGE_CODES.CORRUPT, `completed evaluation ${evaluation.ref} must have one emission`);
        this.adoptCompleted(evaluation.ref, request.modelInput.candidateInput, emissions[0]!.payload as readonly SemanticItem[]);
      } else if (evaluation.status === "failed" && evaluation.outcome && !state.adoptions.some((adoption) => adoption.evaluation === evaluation.ref)) {
        object(evaluation.outcome.details, `failed outcome ${evaluation.outcome.ref}`);
        const code = evaluation.outcome.details.code;
        if (typeof code !== "string" || code.length === 0) fail(STORAGE_CODES.CORRUPT, `failed outcome ${evaluation.outcome.ref} has no error code`);
        this.reject(evaluation.ref, { code });
      }
    }
  }

  #recoverAttemptedEvaluations(): void {
    const attempted = this.#state.runtime.state().evaluations.filter(
      (evaluation) => evaluation.status === "attempted",
    );
    for (const evaluation of attempted) {
      this.markUnknown(evaluation.ref, {
        version: "axiomatic-recovery/v1",
        reason: "attempt-without-outcome-on-restart",
      });
    }
  }
}

export const AXIOMATIC_DURABLE_POLICIES = Object.freeze({
  projection: PROJECTION_POLICY,
  adoption: ADOPTION_POLICY,
});
