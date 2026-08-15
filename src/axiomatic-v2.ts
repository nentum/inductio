/**
 * 公理化语义的纯内存可执行核心。
 *
 * 它复用已经验证的 canonical/hash 机械实现，但不会从 package 入口直接
 * 导出。公开入口只暴露不接受任意政策 callback 的受限 facade。
 * 本模块不替代冻结 v1 参考机，也不声明 SQLite 精化已经完成。
 */
import {
  canonicalize,
  contentRef,
  immutableCanonicalCopy,
  normalizeBuild,
} from "./canonical-v1.ts";
import { SemanticError } from "./errors.ts";
import type { CanonicalObject, CanonicalValue } from "./types.ts";

export type AxiomaticAgentRef = string;
export type AxiomaticRootRef = string;
export type AxiomaticNodeRef = string;
export type AxiomaticRevisionRef = AxiomaticRootRef | AxiomaticNodeRef;
export type AxiomaticArtifactRef = string;
export type InvocationOccurrenceRef = string;
export type EvaluationOccurrenceRef = string;
export type EvaluationAttemptRef = string;
export type ProjectionPlanRef = string;
export type EvaluationRunRef = string;
export type EmissionRef = string;
export type OutcomeRef = string;
export type EvaluationUnknownRef = string;
export type EvaluationLocalFailureRef = string;
export type AdoptionDecisionRef = string;
export type PolicyRef = string;

const DOMAINS = {
  agent: "axiomatic-agent/v2",
  root: "axiomatic-root/v2",
  node: "axiomatic-node/v2",
  payload: "axiomatic-payload/v2",
  environment: "axiomatic-environment/v2",
  endpoint: "axiomatic-endpoint/v2",
  occurrence: "axiomatic-occurrence/v2",
  evaluationOccurrence: "axiomatic-evaluation-occurrence/v2",
  evaluationAttempt: "axiomatic-evaluation-attempt/v2",
  policy: "axiomatic-policy/v2",
  projection: "axiomatic-projection/v2",
  evaluation: "axiomatic-evaluation/v2",
  emission: "axiomatic-emission/v2",
  outcome: "axiomatic-outcome/v2",
  unknown: "axiomatic-evaluation-unknown/v2",
  localFailure: "axiomatic-evaluation-local-failure/v2",
  decision: "axiomatic-adoption-decision/v2",
} as const;

const ROOT_FIELDS = ["rootPrompt", "toolDefinitions"] as const;
const TOOL_FIELDS = ["name", "description", "inputSchema"] as const;
const FRAME_FIELDS = ["version", "input", "output", "environment", "metadata"] as const;

export interface AxiomaticToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: CanonicalObject;
}

export interface AxiomaticRootBody {
  readonly rootPrompt: string;
  readonly toolDefinitions: readonly AxiomaticToolDefinition[];
}

export interface RootView {
  readonly agent: AxiomaticAgentRef;
  readonly root: AxiomaticRootRef;
  readonly body: AxiomaticRootBody;
}

export type SemanticItem =
  | {
      readonly kind: "message";
      readonly role: "user" | "assistant";
      readonly content: CanonicalValue;
    }
  | {
      readonly kind: "thinking";
      readonly content: CanonicalValue;
    }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly arguments: CanonicalValue;
    }
  | {
      readonly kind: "tool-result";
      readonly callId: string;
      readonly name: string;
      readonly result: CanonicalValue;
      readonly isError: boolean;
    };

export interface SemanticBlock {
  readonly version: "evaluation-frame/v2";
  readonly input: readonly SemanticItem[];
  readonly output: readonly SemanticItem[];
  readonly environment?: CanonicalValue;
  readonly metadata?: CanonicalValue;
}

export interface NodeView {
  readonly ref: AxiomaticNodeRef;
  readonly root: AxiomaticRootRef;
  readonly agent: AxiomaticAgentRef;
  readonly parent: AxiomaticRevisionRef;
  readonly block: SemanticBlock;
}

export interface InvocationOccurrenceView {
  readonly ref: InvocationOccurrenceRef;
  readonly source: string;
  readonly position: CanonicalValue;
  readonly payloadRef: AxiomaticArtifactRef;
}

export interface EvaluationOccurrenceView {
  readonly ref: EvaluationOccurrenceRef;
  readonly source: string;
  readonly position: CanonicalValue;
}

export interface PolicyIdentity {
  readonly kind: "projection" | "adoption";
  readonly name: string;
  readonly version: string;
}

export type ProjectionPathEntry =
  | {
      readonly kind: "root";
      readonly ref: AxiomaticRootRef;
      readonly body: AxiomaticRootBody;
    }
  | {
      readonly kind: "node";
      readonly ref: AxiomaticNodeRef;
      readonly parent: AxiomaticRevisionRef;
      readonly block: SemanticBlock;
    };

export interface ProjectionPolicyInput {
  readonly root: RootView;
  readonly parent: AxiomaticRevisionRef;
  readonly path: readonly ProjectionPathEntry[];
  readonly candidateInput: CanonicalValue;
  readonly environment: CanonicalValue;
  readonly endpoint: CanonicalValue;
  readonly explicitInputs: CanonicalValue;
}

export interface ProjectionDraft {
  readonly selectedNodes: readonly AxiomaticNodeRef[];
  readonly appendContent: CanonicalValue;
  readonly transformations?: readonly CanonicalValue[];
}

export interface VersionedProjectionPolicy {
  readonly identity: PolicyIdentity & { readonly kind: "projection" };
  project(input: ProjectionPolicyInput): ProjectionDraft;
}

export interface ProjectionPlanView {
  readonly ref: ProjectionPlanRef;
  readonly root: AxiomaticRootRef;
  readonly parent: AxiomaticRevisionRef;
  readonly occurrence: InvocationOccurrenceRef;
  readonly candidateInput: AxiomaticArtifactRef;
  readonly environment: AxiomaticArtifactRef;
  readonly endpoint: AxiomaticArtifactRef;
  readonly policy: PolicyRef;
  readonly explicitInputs: AxiomaticArtifactRef;
  readonly selectedNodes: readonly AxiomaticNodeRef[];
  readonly appendContent: CanonicalValue;
  readonly transformations: readonly CanonicalValue[];
}

export interface PrepareEvaluationInput {
  readonly parent: AxiomaticRevisionRef;
  readonly occurrence: InvocationOccurrenceRef;
  readonly evaluationOccurrence?: EvaluationOccurrenceRef;
  readonly environment: AxiomaticArtifactRef;
  readonly endpoint: AxiomaticArtifactRef;
  readonly projectionPolicy: VersionedProjectionPolicy;
  readonly explicitInputs?: CanonicalValue;
}

export interface ProjectionPolicyContextInput {
  readonly parent: AxiomaticRevisionRef;
  readonly occurrence: InvocationOccurrenceRef;
  readonly environment: AxiomaticArtifactRef;
  readonly endpoint: AxiomaticArtifactRef;
  readonly explicitInputs?: CanonicalValue;
}

export interface PrepareEvaluationFromDraftInput {
  readonly parent: AxiomaticRevisionRef;
  readonly occurrence: InvocationOccurrenceRef;
  readonly evaluationOccurrence?: EvaluationOccurrenceRef;
  readonly environment: AxiomaticArtifactRef;
  readonly endpoint: AxiomaticArtifactRef;
  readonly projectionPolicyIdentity: PolicyIdentity & { readonly kind: "projection" };
  readonly explicitInputs?: CanonicalValue;
  readonly draft: ProjectionDraft;
}

export interface EvaluationAttemptView {
  readonly ref: EvaluationAttemptRef;
  readonly evaluation: EvaluationRunRef;
  readonly ordinal: number;
}

export interface EmissionView {
  readonly ref: EmissionRef;
  readonly evaluation: EvaluationRunRef;
  readonly attempt: EvaluationAttemptRef;
  readonly ordinal: number;
  readonly producer: string;
  readonly protocol: string;
  readonly payloadRef: AxiomaticArtifactRef;
  readonly payload: CanonicalValue;
}

export type EvaluationOutcomeKind = "completed" | "failed";

export interface OutcomeView {
  readonly ref: OutcomeRef;
  readonly evaluation: EvaluationRunRef;
  readonly attempt: EvaluationAttemptRef;
  readonly kind: EvaluationOutcomeKind;
  readonly detailsRef: AxiomaticArtifactRef;
  readonly details: CanonicalValue;
}

export interface EvaluationUnknownView {
  readonly ref: EvaluationUnknownRef;
  readonly evaluation: EvaluationRunRef;
  readonly attempt: EvaluationAttemptRef;
  readonly reasonRef: AxiomaticArtifactRef;
  readonly reason: CanonicalValue;
}

export interface EvaluationLocalFailureView {
  readonly ref: EvaluationLocalFailureRef;
  readonly evaluation: EvaluationRunRef;
  readonly phase: string;
  readonly reasonRef: AxiomaticArtifactRef;
  readonly reason: CanonicalValue;
}

export type EvaluationStatus =
  | "prepared"
  | "attempted"
  | "completed"
  | "failed"
  | "failed-local"
  | "unknown";

export interface EvaluationView {
  readonly ref: EvaluationRunRef;
  readonly root: AxiomaticRootRef;
  readonly parent: AxiomaticRevisionRef;
  readonly occurrence: InvocationOccurrenceRef;
  readonly evaluationOccurrence: EvaluationOccurrenceRef;
  readonly projection: ProjectionPlanRef;
  readonly status: EvaluationStatus;
  readonly attempt?: EvaluationAttemptView;
  readonly emissions: readonly EmissionRef[];
  readonly outcome?: OutcomeView;
  readonly lateOutcome?: OutcomeView;
  readonly unknown?: EvaluationUnknownView;
  readonly localFailure?: EvaluationLocalFailureView;
}

export interface AdoptionPolicyInput {
  readonly evaluation: EvaluationView;
  readonly root: RootView;
  readonly parent: AxiomaticRevisionRef;
  readonly candidateInput: CanonicalValue;
  readonly projection: ProjectionPlanView;
  readonly emissions: readonly EmissionView[];
  readonly outcome: OutcomeView;
  readonly explicitInputs: CanonicalValue;
}

export type AdoptionDecision =
  | {
      readonly kind: "adopt";
      readonly block: SemanticBlock;
    }
  | {
      readonly kind: "defer" | "reject";
      readonly reason: CanonicalValue;
    };

export interface VersionedAdoptionPolicy {
  readonly identity: PolicyIdentity & { readonly kind: "adoption" };
  adopt(input: AdoptionPolicyInput): AdoptionDecision;
}

export interface AdoptionResult {
  readonly key: string;
  readonly evaluation: EvaluationRunRef;
  readonly parent: AxiomaticRevisionRef;
  readonly policy: PolicyRef;
  readonly explicitInputs: AxiomaticArtifactRef;
  readonly decisionRef: AdoptionDecisionRef;
  readonly decision: AdoptionDecision;
  readonly node?: NodeView;
}

export interface AxiomaticStateView {
  readonly version: "axiomatic-state/v2";
  readonly roots: readonly RootView[];
  readonly nodes: readonly NodeView[];
  readonly invocationOccurrences: readonly InvocationOccurrenceView[];
  readonly evaluationOccurrences: readonly EvaluationOccurrenceView[];
  readonly projections: readonly ProjectionPlanView[];
  readonly evaluations: readonly EvaluationView[];
  readonly emissions: readonly EmissionView[];
  readonly outcomes: readonly OutcomeView[];
  readonly unknowns: readonly EvaluationUnknownView[];
  readonly localFailures: readonly EvaluationLocalFailureView[];
  readonly adoptions: readonly AdoptionResult[];
}

interface StoredArtifact {
  readonly domain: string;
  readonly value: CanonicalValue;
}

interface RootRecord extends RootView {}

interface NodeRecord extends NodeView {}

interface OccurrenceRecord extends InvocationOccurrenceView {}

interface EvaluationRecord {
  readonly ref: EvaluationRunRef;
  readonly root: AxiomaticRootRef;
  readonly parent: AxiomaticRevisionRef;
  readonly occurrence: InvocationOccurrenceRef;
  readonly evaluationOccurrence: EvaluationOccurrenceRef;
  readonly projection: ProjectionPlanRef;
}

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("AXIOMATIC_INVALID_SHAPE", `${label} 必须是对象`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("AXIOMATIC_INVALID_SHAPE", `${label} 字段集合不一致`);
  }
}

function copy(value: CanonicalValue): CanonicalValue {
  return immutableCanonicalCopy(value);
}

function objectValue(value: Record<string, CanonicalValue>): CanonicalObject {
  return copy(value as unknown as CanonicalValue) as CanonicalObject;
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail("AXIOMATIC_INVALID_INPUT", `${label} 必须是非空字符串`);
  }
}

function isRef(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

export function normalizeAxiomaticRootBody(body: AxiomaticRootBody): AxiomaticRootBody {
  canonicalize(body as unknown as CanonicalValue);
  assertObject(body, "RootBody");
  assertExactKeys(body, ROOT_FIELDS, "RootBody");
  if (typeof body.rootPrompt !== "string" || !Array.isArray(body.toolDefinitions)) {
    fail(
      "AXIOMATIC_INVALID_INPUT",
      "Root 必须包含字符串 rootPrompt 和 toolDefinitions 数组",
    );
  }
  for (const tool of body.toolDefinitions) {
    assertObject(tool, "ToolDefinition");
    assertExactKeys(tool, TOOL_FIELDS, "ToolDefinition");
    if (
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !tool.inputSchema ||
      typeof tool.inputSchema !== "object" ||
      Array.isArray(tool.inputSchema)
    ) {
      fail("AXIOMATIC_INVALID_INPUT", "ToolDefinition 字段类型不合法");
    }
  }
  const normalized = normalizeBuild({
    fixedSystemPrompt: body.rootPrompt,
    capabilities: body.toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  }) as {
    readonly fixedSystemPrompt: string;
    readonly capabilities: readonly {
      readonly name: string;
      readonly description: string;
      readonly parameters: CanonicalObject;
    }[];
  };
  return copy({
    rootPrompt: normalized.fixedSystemPrompt,
    toolDefinitions: normalized.capabilities.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
  }) as unknown as AxiomaticRootBody;
}

function normalizePolicyIdentity(identity: PolicyIdentity): PolicyIdentity {
  canonicalize(identity as unknown as CanonicalValue);
  assertObject(identity, "PolicyIdentity");
  assertExactKeys(identity, ["kind", "name", "version"], "PolicyIdentity");
  if (identity.kind !== "projection" && identity.kind !== "adoption") {
    fail("AXIOMATIC_INVALID_INPUT", "PolicyIdentity.kind 不受支持");
  }
  nonEmpty(identity.name, "PolicyIdentity.name");
  nonEmpty(identity.version, "PolicyIdentity.version");
  return Object.freeze({ kind: identity.kind, name: identity.name, version: identity.version });
}

function policyRef(identity: PolicyIdentity): PolicyRef {
  return contentRef(DOMAINS.policy, normalizePolicyIdentity(identity));
}

function normalizeSemanticItem(item: SemanticItem, label: string): SemanticItem {
  assertObject(item, label);
  switch (item.kind) {
    case "message":
      assertExactKeys(item, ["kind", "role", "content"], label);
      if (item.role !== "user" && item.role !== "assistant") {
        fail("AXIOMATIC_INVALID_SHAPE", `${label}.role 不受支持`);
      }
      return copy(item as unknown as CanonicalValue) as unknown as SemanticItem;
    case "thinking":
      assertExactKeys(item, ["kind", "content"], label);
      return copy(item as unknown as CanonicalValue) as unknown as SemanticItem;
    case "tool-call":
      assertExactKeys(item, ["kind", "callId", "name", "arguments"], label);
      nonEmpty(item.callId, `${label}.callId`);
      nonEmpty(item.name, `${label}.name`);
      return copy(item as unknown as CanonicalValue) as unknown as SemanticItem;
    case "tool-result":
      assertExactKeys(item, ["kind", "callId", "name", "result", "isError"], label);
      nonEmpty(item.callId, `${label}.callId`);
      nonEmpty(item.name, `${label}.name`);
      if (typeof item.isError !== "boolean") {
        fail("AXIOMATIC_INVALID_SHAPE", `${label}.isError 必须是 boolean`);
      }
      return copy(item as unknown as CanonicalValue) as unknown as SemanticItem;
    default:
      fail("AXIOMATIC_INVALID_SHAPE", `${label}.kind 不受支持`);
  }
}

export function normalizeAxiomaticSemanticItems(
  items: readonly SemanticItem[],
  label = "SemanticItems",
): readonly SemanticItem[] {
  canonicalize(items as unknown as CanonicalValue);
  if (!Array.isArray(items)) {
    fail("AXIOMATIC_INVALID_SHAPE", `${label} 必须是数组`);
  }
  return Object.freeze(items.map((item, index) => normalizeSemanticItem(item, `${label}[${index}]`)));
}

export function normalizeAxiomaticSemanticBlock(block: SemanticBlock): SemanticBlock {
  canonicalize(block as unknown as CanonicalValue);
  assertObject(block, "SemanticBlock");
  const actual = Object.keys(block);
  if (
    actual.some((key) => !FRAME_FIELDS.includes(key as (typeof FRAME_FIELDS)[number])) ||
    !Object.hasOwn(block, "version") ||
    !Object.hasOwn(block, "input") ||
    !Object.hasOwn(block, "output")
  ) {
    fail("AXIOMATIC_INVALID_SHAPE", "SemanticBlock 必须包含 version/input/output 且不能有未知字段");
  }
  if (block.version !== "evaluation-frame/v2") {
    fail("AXIOMATIC_INVALID_SHAPE", "SemanticBlock.version 必须为 evaluation-frame/v2");
  }
  const input = normalizeAxiomaticSemanticItems(block.input, "SemanticBlock.input");
  const output = normalizeAxiomaticSemanticItems(block.output, "SemanticBlock.output");
  if (
    input.some(
      (item) =>
        !(
          (item.kind === "message" && item.role === "user") ||
          item.kind === "tool-result"
        ),
    )
  ) {
    fail(
      "AXIOMATIC_INVALID_SHAPE",
      "SemanticBlock.input 只接受 user message 与 tool-result",
    );
  }
  if (
    output.some(
      (item) =>
        !(
          (item.kind === "message" && item.role === "assistant") ||
          item.kind === "thinking" ||
          item.kind === "tool-call"
        ),
    )
  ) {
    fail(
      "AXIOMATIC_INVALID_SHAPE",
      "SemanticBlock.output 只接受 assistant message、thinking 与 tool-call",
    );
  }
  const normalized = {
    version: block.version,
    input,
    output,
    ...(block.environment === undefined ? {} : { environment: copy(block.environment) }),
    ...(block.metadata === undefined ? {} : { metadata: copy(block.metadata) }),
  } satisfies SemanticBlock;
  return copy(normalized as unknown as CanonicalValue) as unknown as SemanticBlock;
}

function normalizeOutcomeKind(kind: unknown): EvaluationOutcomeKind {
  if (kind !== "completed" && kind !== "failed") {
    fail("AXIOMATIC_INVALID_INPUT", "Outcome kind 不受支持");
  }
  return kind;
}

function normalizeDecision(decision: AdoptionDecision): AdoptionDecision {
  canonicalize(decision as unknown as CanonicalValue);
  assertObject(decision, "AdoptionDecision");
  if (decision.kind === "adopt") {
    assertExactKeys(decision, ["kind", "block"], "Adopt decision");
    return Object.freeze({
      kind: "adopt" as const,
      block: normalizeAxiomaticSemanticBlock(decision.block),
    });
  }
  if (decision.kind === "defer" || decision.kind === "reject") {
    assertExactKeys(decision, ["kind", "reason"], `${decision.kind} decision`);
    return Object.freeze({ kind: decision.kind, reason: copy(decision.reason) });
  }
  fail("AXIOMATIC_INVALID_SHAPE", "AdoptionDecision.kind 不受支持");
}

function byRef<T extends { readonly ref: string }>(left: T, right: T): number {
  return Buffer.from(left.ref, "utf8").compare(Buffer.from(right.ref, "utf8"));
}

export class AxiomaticRuntimeV2 {
  readonly #artifacts = new Map<AxiomaticArtifactRef, StoredArtifact>();
  readonly #roots = new Map<AxiomaticRootRef, RootRecord>();
  readonly #nodes = new Map<AxiomaticNodeRef, NodeRecord>();
  readonly #occurrences = new Map<InvocationOccurrenceRef, OccurrenceRecord>();
  readonly #occurrencePositions = new Map<string, InvocationOccurrenceRef>();
  readonly #evaluationOccurrences = new Map<EvaluationOccurrenceRef, EvaluationOccurrenceView>();
  readonly #evaluationOccurrencePositions = new Map<string, EvaluationOccurrenceRef>();
  readonly #evaluationOccurrenceIntents = new Map<EvaluationOccurrenceRef, string>();
  readonly #plans = new Map<ProjectionPlanRef, ProjectionPlanView>();
  readonly #projectionClaims = new Map<string, ProjectionPlanRef>();
  readonly #evaluations = new Map<EvaluationRunRef, EvaluationRecord>();
  readonly #attempts = new Map<EvaluationAttemptRef, EvaluationAttemptView>();
  readonly #attemptByEvaluation = new Map<EvaluationRunRef, EvaluationAttemptRef>();
  readonly #emissions = new Map<EmissionRef, EmissionView>();
  readonly #emissionClaims = new Map<string, EmissionRef>();
  readonly #outcomes = new Map<OutcomeRef, OutcomeView>();
  readonly #outcomeByEvaluation = new Map<EvaluationRunRef, OutcomeRef>();
  readonly #unknowns = new Map<EvaluationUnknownRef, EvaluationUnknownView>();
  readonly #unknownByEvaluation = new Map<EvaluationRunRef, EvaluationUnknownRef>();
  readonly #localFailures = new Map<EvaluationLocalFailureRef, EvaluationLocalFailureView>();
  readonly #localFailureByEvaluation = new Map<EvaluationRunRef, EvaluationLocalFailureRef>();
  readonly #adoptions = new Map<string, AdoptionResult>();
  #policyDepth = 0;

  materializeEnvironment(value: CanonicalValue): AxiomaticArtifactRef {
    this.#assertPolicyHasNoPower();
    return this.#materialize(DOMAINS.environment, value);
  }

  materializeEndpoint(value: CanonicalValue): AxiomaticArtifactRef {
    this.#assertPolicyHasNoPower();
    return this.#materialize(DOMAINS.endpoint, value);
  }

  createRoot(body: AxiomaticRootBody): RootView {
    this.#assertPolicyHasNoPower();
    const normalized = normalizeAxiomaticRootBody(body);
    const agent = contentRef(DOMAINS.agent, normalized as unknown as CanonicalValue);
    const root = contentRef(DOMAINS.root, agent);
    const existing = this.#roots.get(root);
    if (existing) return this.#rootView(existing);
    const record: RootRecord = Object.freeze({
      agent,
      root,
      body: normalized,
    });
    this.#roots.set(root, record);
    return this.#rootView(record);
  }

  rootOf(revision: AxiomaticRevisionRef): RootView {
    this.#assertPolicyHasNoPower();
    const root = this.#rootForRevision(revision);
    return this.#rootView(root);
  }

  #appendNode(parent: AxiomaticRevisionRef, block: SemanticBlock): NodeView {
    const root = this.#rootForRevision(parent);
    const normalized = normalizeAxiomaticSemanticBlock(block);
    const value = objectValue({
      version: "axiomatic-node/v2",
      parent,
      block: normalized as unknown as CanonicalValue,
    });
    const ref = contentRef(DOMAINS.node, value);
    const existing = this.#nodes.get(ref);
    if (existing) return this.#nodeView(existing);
    const record: NodeRecord = Object.freeze({
      ref,
      root: root.root,
      agent: root.agent,
      parent,
      block: normalized,
    });
    this.#nodes.set(ref, record);
    return this.#nodeView(record);
  }

  path(head: AxiomaticRevisionRef): readonly AxiomaticRevisionRef[] {
    this.#assertPolicyHasNoPower();
    this.#rootForRevision(head);
    const path: AxiomaticRevisionRef[] = [];
    let current: AxiomaticRevisionRef = head;
    while (true) {
      path.push(current);
      if (this.#roots.has(current)) break;
      const node = this.#nodes.get(current as AxiomaticNodeRef);
      if (!node) fail("AXIOMATIC_CORRUPT_STATE", `缺少 Node ${current}`);
      current = node.parent;
    }
    path.reverse();
    return Object.freeze(path);
  }

  materializeEvaluationOccurrence(
    source: string,
    position: CanonicalValue,
  ): EvaluationOccurrenceView {
    this.#assertPolicyHasNoPower();
    nonEmpty(source, "evaluationOccurrence.source");
    canonicalize(position);
    const positionKey = canonicalize({ source, position } as unknown as CanonicalValue);
    const existingRef = this.#evaluationOccurrencePositions.get(positionKey);
    if (existingRef) return this.#evaluationOccurrenceView(this.#evaluationOccurrences.get(existingRef)!);
    const value = objectValue({
      version: "evaluation-occurrence/v2",
      source,
      position,
    });
    const ref = contentRef(DOMAINS.evaluationOccurrence, value);
    const record: EvaluationOccurrenceView = Object.freeze({
      ref,
      source,
      position: copy(position),
    });
    this.#evaluationOccurrences.set(ref, record);
    this.#evaluationOccurrencePositions.set(positionKey, ref);
    return this.#evaluationOccurrenceView(record);
  }

  getEvaluationOccurrence(ref: EvaluationOccurrenceRef): EvaluationOccurrenceView {
    this.#assertPolicyHasNoPower();
    const occurrence = this.#evaluationOccurrences.get(ref);
    if (!occurrence) fail("AXIOMATIC_UNKNOWN_EVALUATION_OCCURRENCE", `未知 EvaluationOccurrence ${ref}`);
    return this.#evaluationOccurrenceView(occurrence);
  }

  materializeInvocationOccurrence(
    source: string,
    position: CanonicalValue,
    payload: CanonicalValue,
  ): InvocationOccurrenceView {
    this.#assertPolicyHasNoPower();
    nonEmpty(source, "occurrence.source");
    canonicalize(position);
    const payloadRef = this.#materialize(DOMAINS.payload, payload);
    const positionKey = canonicalize({ source, position } as unknown as CanonicalValue);
    const existingRef = this.#occurrencePositions.get(positionKey);
    if (existingRef) {
      const existing = this.#occurrences.get(existingRef)!;
      if (existing.payloadRef !== payloadRef) {
        fail("AXIOMATIC_OCCURRENCE_CONFLICT", "同一来源位置不能对应不同输入");
      }
      return this.#occurrenceView(existing);
    }
    const value = objectValue({
      version: "invocation-occurrence/v2",
      source,
      position,
      payload: payloadRef,
    });
    const ref = contentRef(DOMAINS.occurrence, value);
    const record: OccurrenceRecord = Object.freeze({
      ref,
      source,
      position: copy(position),
      payloadRef,
    });
    this.#occurrences.set(ref, record);
    this.#occurrencePositions.set(positionKey, ref);
    return this.#occurrenceView(record);
  }

  prepareEvaluation(input: PrepareEvaluationInput): EvaluationRunRef {
    this.#assertPolicyHasNoPower();
    const root = this.#rootForRevision(input.parent);
    const occurrence = this.#occurrences.get(input.occurrence);
    if (!occurrence) fail("AXIOMATIC_UNKNOWN_OCCURRENCE", `未知 InvocationOccurrence ${input.occurrence}`);
    this.#assertArtifactKind(input.environment, DOMAINS.environment, "environment");
    this.#assertArtifactKind(input.endpoint, DOMAINS.endpoint, "endpoint");
    const identity = normalizePolicyIdentity(input.projectionPolicy.identity);
    if (identity.kind !== "projection" || typeof input.projectionPolicy.project !== "function") {
      fail("AXIOMATIC_INVALID_POLICY", "prepareEvaluation 需要 projection policy");
    }
    const projectionPolicyRef = policyRef(identity);
    const explicitInputs = input.explicitInputs === undefined ? null : copy(input.explicitInputs);
    const explicitInputsRef = this.#materialize(DOMAINS.payload, explicitInputs);
    const intentKey = canonicalize({
      parent: input.parent,
      invocation: input.occurrence,
      environment: input.environment,
      endpoint: input.endpoint,
      projectionPolicy: projectionPolicyRef,
      explicitInputs: explicitInputsRef,
    } as unknown as CanonicalValue);
    const evaluationOccurrence = input.evaluationOccurrence === undefined
      ? this.materializeEvaluationOccurrence("default", {
          parent: input.parent,
          invocation: input.occurrence,
          environment: input.environment,
          endpoint: input.endpoint,
          projectionPolicy: projectionPolicyRef,
          explicitInputs: explicitInputsRef,
        })
      : this.#evaluationOccurrences.get(input.evaluationOccurrence);
    if (!evaluationOccurrence) {
      fail(
        "AXIOMATIC_UNKNOWN_EVALUATION_OCCURRENCE",
        `未知 EvaluationOccurrence ${input.evaluationOccurrence}`,
      );
    }
    const claimedIntent = this.#evaluationOccurrenceIntents.get(evaluationOccurrence.ref);
    if (claimedIntent !== undefined && claimedIntent !== intentKey) {
      fail(
        "AXIOMATIC_EVALUATION_OCCURRENCE_CONFLICT",
        "同一 EvaluationOccurrence 不能绑定不同求值意图",
      );
    }
    const projectionInput = this.getProjectionPolicyInput({
      parent: input.parent,
      occurrence: input.occurrence,
      environment: input.environment,
      endpoint: input.endpoint,
      explicitInputs,
    });
    const draft = this.#invokePolicy("ProjectionPolicy", () =>
      input.projectionPolicy.project(projectionInput),
    );
    return this.prepareEvaluationFromDraft({
      parent: input.parent,
      occurrence: input.occurrence,
      evaluationOccurrence: evaluationOccurrence.ref,
      environment: input.environment,
      endpoint: input.endpoint,
      projectionPolicyIdentity: identity as PolicyIdentity & { readonly kind: "projection" },
      explicitInputs,
      draft,
    });
  }

  prepareEvaluationFromDraft(input: PrepareEvaluationFromDraftInput): EvaluationRunRef {
    this.#assertPolicyHasNoPower();
    const root = this.#rootForRevision(input.parent);
    const occurrence = this.#occurrences.get(input.occurrence);
    if (!occurrence) fail("AXIOMATIC_UNKNOWN_OCCURRENCE", `未知 InvocationOccurrence ${input.occurrence}`);
    this.#assertArtifactKind(input.environment, DOMAINS.environment, "environment");
    this.#assertArtifactKind(input.endpoint, DOMAINS.endpoint, "endpoint");
    const identity = normalizePolicyIdentity(input.projectionPolicyIdentity);
    if (identity.kind !== "projection") {
      fail("AXIOMATIC_INVALID_POLICY", "prepareEvaluationFromDraft 需要 projection policy identity");
    }
    const projectionPolicyRef = policyRef(identity);
    const explicitInputs = input.explicitInputs === undefined ? null : copy(input.explicitInputs);
    const explicitInputsRef = this.#materialize(DOMAINS.payload, explicitInputs);
    const intentKey = canonicalize({
      parent: input.parent,
      invocation: input.occurrence,
      environment: input.environment,
      endpoint: input.endpoint,
      projectionPolicy: projectionPolicyRef,
      explicitInputs: explicitInputsRef,
    } as unknown as CanonicalValue);
    const evaluationOccurrence = input.evaluationOccurrence === undefined
      ? this.materializeEvaluationOccurrence("default", {
          parent: input.parent,
          invocation: input.occurrence,
          environment: input.environment,
          endpoint: input.endpoint,
          projectionPolicy: projectionPolicyRef,
          explicitInputs: explicitInputsRef,
        })
      : this.#evaluationOccurrences.get(input.evaluationOccurrence);
    if (!evaluationOccurrence) {
      fail(
        "AXIOMATIC_UNKNOWN_EVALUATION_OCCURRENCE",
        `未知 EvaluationOccurrence ${input.evaluationOccurrence}`,
      );
    }
    const claimedIntent = this.#evaluationOccurrenceIntents.get(evaluationOccurrence.ref);
    if (claimedIntent !== undefined && claimedIntent !== intentKey) {
      fail(
        "AXIOMATIC_EVALUATION_OCCURRENCE_CONFLICT",
        "同一 EvaluationOccurrence 不能绑定不同求值意图",
      );
    }
    const plan = this.#normalizeProjectionPlan({
      root: root.root,
      parent: input.parent,
      occurrence: input.occurrence,
      candidateInput: occurrence.payloadRef,
      environment: input.environment,
      endpoint: input.endpoint,
      policy: projectionPolicyRef,
      explicitInputs: explicitInputsRef,
      path: this.path(input.parent),
      draft: input.draft,
    });
    const projectionKey = canonicalize({
      root: root.root,
      parent: input.parent,
      occurrence: input.occurrence,
      environment: input.environment,
      endpoint: input.endpoint,
      policy: projectionPolicyRef,
      explicitInputs: explicitInputsRef,
    } as unknown as CanonicalValue);
    const existingPlanRef = this.#projectionClaims.get(projectionKey);
    if (existingPlanRef && existingPlanRef !== plan.ref) {
      fail("AXIOMATIC_POLICY_NONDETERMINISM", "同一 ProjectionPolicy 输入产生了不同计划");
    }
    this.#projectionClaims.set(projectionKey, plan.ref);
    this.#plans.set(plan.ref, plan);
    this.#evaluationOccurrenceIntents.set(evaluationOccurrence.ref, intentKey);
    const evaluationValue = objectValue({
      version: "evaluation-run/v2",
      root: root.root,
      parent: input.parent,
      occurrence: input.occurrence,
      evaluationOccurrence: evaluationOccurrence.ref,
      projection: plan.ref,
      policy: projectionPolicyRef,
      endpoint: input.endpoint,
      explicitInputs: explicitInputsRef,
    });
    const run = contentRef(DOMAINS.evaluation, evaluationValue);
    if (!this.#evaluations.has(run)) {
      this.#evaluations.set(run, Object.freeze({
        ref: run,
        root: root.root,
        parent: input.parent,
        occurrence: input.occurrence,
        evaluationOccurrence: evaluationOccurrence.ref,
        projection: plan.ref,
      }));
    }
    return run;
  }

  getProjectionPolicyInput(input: ProjectionPolicyContextInput): ProjectionPolicyInput {
    this.#assertPolicyHasNoPower();
    const root = this.#rootForRevision(input.parent);
    const occurrence = this.#occurrences.get(input.occurrence);
    if (!occurrence) {
      fail("AXIOMATIC_UNKNOWN_OCCURRENCE", `未知 InvocationOccurrence ${input.occurrence}`);
    }
    this.#assertArtifactKind(input.environment, DOMAINS.environment, "environment");
    this.#assertArtifactKind(input.endpoint, DOMAINS.endpoint, "endpoint");
    const path = this.path(input.parent);
    return Object.freeze({
      root: this.#rootView(root),
      parent: input.parent,
      path: this.#pathEntries(path),
      candidateInput: this.#readArtifact(occurrence.payloadRef),
      environment: this.#readArtifact(input.environment),
      endpoint: this.#readArtifact(input.endpoint),
      explicitInputs: input.explicitInputs === undefined ? null : copy(input.explicitInputs),
    });
  }

  getAdoptionPolicyInput(
    evaluationRef: EvaluationRunRef,
    explicitInputs: CanonicalValue = null,
  ): AdoptionPolicyInput {
    this.#assertPolicyHasNoPower();
    const evaluation = this.#evaluation(evaluationRef);
    const status = this.#evaluationStatus(evaluation);
    if (
      (status !== "completed" && status !== "failed") ||
      !this.#outcomeFor(evaluation.ref)
    ) {
      fail(
        "AXIOMATIC_EVALUATION_NOT_ADOPTABLE",
        "只有具有明确外部 Outcome 的 Evaluation 才能交给采纳政策",
      );
    }
    const root = this.#roots.get(evaluation.root);
    const projection = this.#plans.get(evaluation.projection);
    const occurrence = this.#occurrences.get(evaluation.occurrence);
    if (!root || !projection || !occurrence) {
      fail("AXIOMATIC_CORRUPT_STATE", "AdoptionPolicy 输入的账本关系缺失");
    }
    const explicitInputsCopy = copy(explicitInputs);
    return Object.freeze({
      evaluation: this.#evaluationView(evaluation),
      root: this.#rootView(root),
      parent: evaluation.parent,
      candidateInput: this.#readArtifact(occurrence.payloadRef),
      projection: this.#projectionView(projection),
      emissions: this.#emissionsFor(evaluation.ref),
      outcome: this.#outcomeFor(evaluation.ref)!,
      explicitInputs: explicitInputsCopy,
    });
  }

  failEvaluationLocally(
    evaluationRef: EvaluationRunRef,
    phase: string,
    reason: CanonicalValue,
  ): EvaluationLocalFailureView {
    this.#assertPolicyHasNoPower();
    nonEmpty(phase, "localFailure.phase");
    const evaluation = this.#evaluation(evaluationRef);
    const existingFailure = this.#localFailureFor(evaluation.ref);
    if (existingFailure) {
      const reasonRef = this.#materialize(DOMAINS.payload, reason);
      if (
        existingFailure.phase !== phase ||
        existingFailure.reasonRef !== reasonRef
      ) {
        fail("AXIOMATIC_LOCAL_FAILURE_CONFLICT", "同一 Evaluation 不能提交不同本地失败");
      }
      return this.#localFailureView(existingFailure);
    }
    if (this.#evaluationStatus(evaluation) !== "prepared") {
      fail(
        "AXIOMATIC_LOCAL_FAILURE_FORBIDDEN",
        "只有可证明尚未认领外部 attempt 时才能记录本地失败",
      );
    }
    const reasonRef = this.#materialize(DOMAINS.payload, reason);
    const value = objectValue({
      version: "evaluation-local-failure/v2",
      evaluation: evaluation.ref,
      phase,
      reason: reasonRef,
    });
    const ref = contentRef(DOMAINS.localFailure, value);
    const failure: EvaluationLocalFailureView = Object.freeze({
      ref,
      evaluation: evaluation.ref,
      phase,
      reasonRef,
      reason: copy(reason),
    });
    this.#localFailures.set(ref, failure);
    this.#localFailureByEvaluation.set(evaluation.ref, ref);
    return this.#localFailureView(failure);
  }

  claimEvaluationAttempt(evaluationRef: EvaluationRunRef): EvaluationView {
    this.#assertPolicyHasNoPower();
    const evaluation = this.#evaluation(evaluationRef);
    if (this.#evaluationStatus(evaluation) !== "prepared") {
      fail("AXIOMATIC_EVALUATION_NOT_DISPATCHABLE", "Evaluation 没有新的外部 attempt 资格");
    }
    const value = objectValue({
      version: "evaluation-attempt/v2",
      evaluation: evaluation.ref,
      ordinal: 0,
    });
    const ref = contentRef(DOMAINS.evaluationAttempt, value);
    const attempt: EvaluationAttemptView = Object.freeze({
      ref,
      evaluation: evaluation.ref,
      ordinal: 0,
    });
    this.#attempts.set(ref, attempt);
    this.#attemptByEvaluation.set(evaluation.ref, ref);
    return this.#evaluationView(evaluation);
  }

  recordEmission(input: {
    readonly evaluation: EvaluationRunRef;
    readonly ordinal: number;
    readonly producer: string;
    readonly protocol: string;
    readonly payload: CanonicalValue;
  }): EmissionRef {
    this.#assertPolicyHasNoPower();
    const evaluation = this.#evaluation(input.evaluation);
    const status = this.#evaluationStatus(evaluation);
    if (status !== "attempted" && status !== "unknown") {
      fail("AXIOMATIC_EMISSION_NOT_CAPTURABLE", "Emission 需要已认领且尚未确定终止的 attempt");
    }
    const attempt = this.#attemptFor(evaluation.ref);
    if (!attempt) {
      fail("AXIOMATIC_CORRUPT_STATE", "Evaluation attempt 状态缺失");
    }
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
      fail("AXIOMATIC_INVALID_INPUT", "Emission.ordinal 必须是非负安全整数");
    }
    nonEmpty(input.producer, "Emission.producer");
    nonEmpty(input.protocol, "Emission.protocol");
    const payload = this.#materialize(DOMAINS.payload, input.payload);
    const value = objectValue({
      version: "emission/v2",
      evaluation: evaluation.ref,
      attempt: attempt.ref,
      ordinal: input.ordinal,
      producer: input.producer,
      protocol: input.protocol,
      payload,
    });
    const ref = contentRef(DOMAINS.emission, value);
    const claimKey = this.#emissionClaimKey(evaluation.ref, input.ordinal);
    const existingAtOrdinal = this.#emissionClaims.get(claimKey);
    if (existingAtOrdinal && existingAtOrdinal !== ref) {
      fail("AXIOMATIC_EMISSION_CONFLICT", "同一 Evaluation 的同一 ordinal 不能对应不同 Emission");
    }
    if (!this.#emissions.has(ref)) {
      const emission: EmissionView = Object.freeze({
        ref,
        evaluation: evaluation.ref,
        attempt: attempt.ref,
        ordinal: input.ordinal,
        producer: input.producer,
        protocol: input.protocol,
        payloadRef: payload,
        payload: copy(input.payload),
      });
      this.#emissions.set(ref, emission);
    }
    this.#emissionClaims.set(claimKey, ref);
    return ref;
  }

  completeEvaluation(
    evaluationRef: EvaluationRunRef,
    kind: EvaluationOutcomeKind,
    details: CanonicalValue,
  ): OutcomeRef {
    this.#assertPolicyHasNoPower();
    const evaluation = this.#evaluation(evaluationRef);
    const normalizedKind = normalizeOutcomeKind(kind);
    const attempt = this.#attemptFor(evaluation.ref);
    if (!attempt) {
      fail("AXIOMATIC_OUTCOME_NOT_CAPTURABLE", "Evaluation outcome 需要已认领的 attempt");
    }
    const detailsRef = this.#materialize(DOMAINS.payload, details);
    const value = objectValue({
      version: "evaluation-outcome/v2",
      evaluation: evaluation.ref,
      attempt: attempt.ref,
      kind: normalizedKind,
      details: detailsRef,
    });
    const ref = contentRef(DOMAINS.outcome, value);
    const existing = this.#outcomeFor(evaluation.ref);
    if (existing) {
      if (existing.ref !== ref) {
        fail("AXIOMATIC_OUTCOME_CONFLICT", "同一 Evaluation 不能提交不同终态");
      }
      return ref;
    }
    const outcome: OutcomeView = Object.freeze({
      ref,
      evaluation: evaluation.ref,
      attempt: attempt.ref,
      kind: normalizedKind,
      detailsRef,
      details: copy(details),
    });
    const status = this.#evaluationStatus(evaluation);
    if (status !== "attempted" && status !== "unknown") {
      fail("AXIOMATIC_INVALID_STATE", "Evaluation 尚未认领 attempt 或已经终止");
    }
    this.#outcomes.set(ref, outcome);
    this.#outcomeByEvaluation.set(evaluation.ref, ref);
    return ref;
  }

  markUnknown(evaluationRef: EvaluationRunRef, reason: CanonicalValue): void {
    this.#assertPolicyHasNoPower();
    const evaluation = this.#evaluation(evaluationRef);
    const attempt = this.#attemptFor(evaluation.ref);
    if (!attempt) {
      fail("AXIOMATIC_INVALID_STATE", "只有已认领 attempt 的 Evaluation 能变为 unknown");
    }
    const reasonRef = this.#materialize(DOMAINS.payload, reason);
    const existingUnknown = this.#unknownFor(evaluation.ref);
    if (existingUnknown) {
      if (existingUnknown.reasonRef !== reasonRef) {
        fail("AXIOMATIC_OUTCOME_CONFLICT", "同一 unknown Evaluation 不能更换原因");
      }
      return;
    }
    if (this.#evaluationStatus(evaluation) !== "attempted") {
      fail("AXIOMATIC_INVALID_STATE", "只有尚无 Outcome 的 attempt 能变为 unknown");
    }
    const value = objectValue({
      version: "evaluation-unknown/v2",
      evaluation: evaluation.ref,
      attempt: attempt.ref,
      reason: reasonRef,
    });
    const ref = contentRef(DOMAINS.unknown, value);
    const unknown: EvaluationUnknownView = Object.freeze({
      ref,
      evaluation: evaluation.ref,
      attempt: attempt.ref,
      reasonRef,
      reason: copy(reason),
    });
    this.#unknowns.set(ref, unknown);
    this.#unknownByEvaluation.set(evaluation.ref, ref);
  }

  adoptEvaluation(
    evaluationRef: EvaluationRunRef,
    policy: VersionedAdoptionPolicy,
    explicitInputs: CanonicalValue = null,
  ): AdoptionResult {
    this.#assertPolicyHasNoPower();
    const identity = normalizePolicyIdentity(policy.identity);
    if (identity.kind !== "adoption" || typeof policy.adopt !== "function") {
      fail("AXIOMATIC_INVALID_POLICY", "adoptEvaluation 需要 adoption policy");
    }
    const explicitInputsCopy = copy(explicitInputs);
    const adoptionInput = this.getAdoptionPolicyInput(evaluationRef, explicitInputsCopy);
    const decision = normalizeDecision(
      this.#invokePolicy("AdoptionPolicy", () => policy.adopt(adoptionInput)),
    );
    return this.adoptEvaluationDecision(
      evaluationRef,
      identity as PolicyIdentity & { readonly kind: "adoption" },
      decision,
      explicitInputsCopy,
    );
  }

  adoptEvaluationDecision(
    evaluationRef: EvaluationRunRef,
    policyIdentity: PolicyIdentity & { readonly kind: "adoption" },
    decision: AdoptionDecision,
    explicitInputs: CanonicalValue = null,
  ): AdoptionResult {
    this.#assertPolicyHasNoPower();
    const evaluation = this.#evaluation(evaluationRef);
    const status = this.#evaluationStatus(evaluation);
    if (
      (status !== "completed" && status !== "failed") ||
      !this.#outcomeFor(evaluation.ref)
    ) {
      fail(
        "AXIOMATIC_EVALUATION_NOT_ADOPTABLE",
        "只有具有明确外部 Outcome 的 Evaluation 才能提交采纳决定",
      );
    }
    const identity = normalizePolicyIdentity(policyIdentity);
    if (identity.kind !== "adoption") {
      fail("AXIOMATIC_INVALID_POLICY", "adoptEvaluationDecision 需要 adoption policy identity");
    }
    const adoptionPolicyRef = policyRef(identity);
    const explicitInputsCopy = copy(explicitInputs);
    const explicitInputsRef = this.#materialize(DOMAINS.payload, explicitInputsCopy);
    const key = canonicalize({
      evaluation: evaluation.ref,
      parent: evaluation.parent,
      policy: adoptionPolicyRef,
      explicitInputs: explicitInputsRef,
    } as unknown as CanonicalValue);
    const normalizedDecision = normalizeDecision(decision);
    const decisionRef = contentRef(DOMAINS.decision, objectValue({
      version: "adoption-decision/v2",
      evaluation: evaluation.ref,
      parent: evaluation.parent,
      policy: adoptionPolicyRef,
      explicitInputs: explicitInputsRef,
      decision: normalizedDecision as unknown as CanonicalValue,
    }));
    const existing = this.#adoptions.get(key);
    if (existing) {
      if (existing.decisionRef !== decisionRef) {
        fail("AXIOMATIC_POLICY_NONDETERMINISM", "同一 AdoptionPolicy 输入产生了不同决定");
      }
      return this.#adoptionView(existing);
    }
    let node: NodeView | undefined;
    if (normalizedDecision.kind === "adopt") {
      node = this.#appendNode(evaluation.parent, normalizedDecision.block);
    }
    const result: AdoptionResult = Object.freeze({
      key,
      evaluation: evaluation.ref,
      parent: evaluation.parent,
      policy: adoptionPolicyRef,
      explicitInputs: explicitInputsRef,
      decisionRef,
      decision: normalizedDecision,
      ...(node === undefined ? {} : { node }),
    });
    this.#adoptions.set(key, result);
    return this.#adoptionView(result);
  }

  state(): AxiomaticStateView {
    this.#assertPolicyHasNoPower();
    return Object.freeze({
      version: "axiomatic-state/v2",
      roots: Object.freeze(
        [...this.#roots.values()]
          .toSorted((left, right) =>
            Buffer.from(left.root, "utf8").compare(Buffer.from(right.root, "utf8")),
          )
          .map((root) => this.#rootView(root)),
      ),
      nodes: Object.freeze(
        [...this.#nodes.values()].toSorted(byRef).map((node) => this.#nodeView(node)),
      ),
      invocationOccurrences: Object.freeze(
        [...this.#occurrences.values()]
          .toSorted(byRef)
          .map((occurrence) => this.#occurrenceView(occurrence)),
      ),
      evaluationOccurrences: Object.freeze(
        [...this.#evaluationOccurrences.values()]
          .toSorted(byRef)
          .map((occurrence) => this.#evaluationOccurrenceView(occurrence)),
      ),
      projections: Object.freeze(
        [...this.#plans.values()].toSorted(byRef).map((plan) => this.#projectionView(plan)),
      ),
      evaluations: Object.freeze(
        [...this.#evaluations.values()]
          .toSorted(byRef)
          .map((evaluation) => this.#evaluationView(evaluation)),
      ),
      emissions: Object.freeze(
        [...this.#emissions.values()]
          .toSorted(byRef)
          .map((emission) => this.#emissionView(emission)),
      ),
      outcomes: Object.freeze(
        [...this.#outcomes.values()]
          .toSorted(byRef)
          .map((outcome) => this.#outcomeView(outcome)),
      ),
      unknowns: Object.freeze(
        [...this.#unknowns.values()]
          .toSorted(byRef)
          .map((unknown) => this.#unknownView(unknown)),
      ),
      localFailures: Object.freeze(
        [...this.#localFailures.values()]
          .toSorted(byRef)
          .map((failure) => this.#localFailureView(failure)),
      ),
      adoptions: Object.freeze(
        [...this.#adoptions.values()]
          .toSorted((left, right) =>
            Buffer.from(left.decisionRef, "utf8").compare(
              Buffer.from(right.decisionRef, "utf8"),
            ),
          )
          .map((adoption) => this.#adoptionView(adoption)),
      ),
    });
  }

  getEvaluation(ref: EvaluationRunRef): EvaluationView {
    this.#assertPolicyHasNoPower();
    return this.#evaluationView(this.#evaluation(ref));
  }

  getProjection(ref: ProjectionPlanRef): ProjectionPlanView {
    this.#assertPolicyHasNoPower();
    const plan = this.#plans.get(ref);
    if (!plan) fail("AXIOMATIC_UNKNOWN_PROJECTION", `未知 ProjectionPlan ${ref}`);
    return this.#projectionView(plan);
  }

  getNode(ref: AxiomaticNodeRef): NodeView {
    this.#assertPolicyHasNoPower();
    const node = this.#nodes.get(ref);
    if (!node) fail("AXIOMATIC_UNKNOWN_NODE", `未知 Node ${ref}`);
    return this.#nodeView(node);
  }

  #assertPolicyHasNoPower(): void {
    if (this.#policyDepth > 0) {
      fail("AXIOMATIC_POLICY_HAS_POWER", "政策回调不得同步重入运行时后果入口");
    }
  }

  #invokePolicy<T>(label: string, callback: () => T): T {
    this.#policyDepth += 1;
    try {
      const result = callback();
      if (isThenable(result)) {
        try {
          void Promise.resolve(result as PromiseLike<unknown>).catch(() => undefined);
        } catch {
          // The policy is rejected below even if its thenable is malformed.
        }
        fail("AXIOMATIC_ASYNC_POLICY", `${label} 必须同步返回规范决定`);
      }
      return result;
    } finally {
      this.#policyDepth -= 1;
    }
  }

  #materialize(domain: string, value: CanonicalValue): AxiomaticArtifactRef {
    const normalized = copy(value);
    const ref = contentRef(domain, normalized);
    const existing = this.#artifacts.get(ref);
    if (!existing) this.#artifacts.set(ref, Object.freeze({ domain, value: normalized }));
    return ref;
  }

  #readArtifact(ref: AxiomaticArtifactRef): CanonicalValue {
    const stored = this.#artifacts.get(ref);
    if (!stored) fail("AXIOMATIC_UNKNOWN_ARTIFACT", `未知 Artifact ${ref}`);
    return copy(stored.value);
  }

  #assertArtifactKind(
    ref: AxiomaticArtifactRef,
    domain: string,
    label: string,
  ): void {
    const stored = this.#artifacts.get(ref);
    if (!stored || stored.domain !== domain) {
      fail("AXIOMATIC_INVALID_INPUT", `${label} 不是已物化的正确 Artifact`);
    }
  }

  #rootForRevision(revision: AxiomaticRevisionRef): RootRecord {
    const root = this.#roots.get(revision as AxiomaticRootRef);
    if (root) return root;
    const node = this.#nodes.get(revision as AxiomaticNodeRef);
    if (!node) fail("AXIOMATIC_UNKNOWN_REVISION", `未知 Revision ${revision}`);
    return this.#roots.get(node.root)!;
  }

  #evaluation(ref: EvaluationRunRef): EvaluationRecord {
    const evaluation = this.#evaluations.get(ref);
    if (!evaluation) fail("AXIOMATIC_UNKNOWN_EVALUATION", `未知 Evaluation ${ref}`);
    return evaluation;
  }

  #attemptFor(evaluation: EvaluationRunRef): EvaluationAttemptView | undefined {
    const ref = this.#attemptByEvaluation.get(evaluation);
    return ref === undefined ? undefined : this.#attempts.get(ref);
  }

  #outcomeFor(evaluation: EvaluationRunRef): OutcomeView | undefined {
    const ref = this.#outcomeByEvaluation.get(evaluation);
    return ref === undefined ? undefined : this.#outcomes.get(ref);
  }

  #unknownFor(evaluation: EvaluationRunRef): EvaluationUnknownView | undefined {
    const ref = this.#unknownByEvaluation.get(evaluation);
    return ref === undefined ? undefined : this.#unknowns.get(ref);
  }

  #localFailureFor(evaluation: EvaluationRunRef): EvaluationLocalFailureView | undefined {
    const ref = this.#localFailureByEvaluation.get(evaluation);
    return ref === undefined ? undefined : this.#localFailures.get(ref);
  }

  #emissionsFor(evaluation: EvaluationRunRef): readonly EmissionView[] {
    return Object.freeze(
      [...this.#emissions.values()]
        .filter((emission) => emission.evaluation === evaluation)
        .toSorted((left, right) => left.ordinal - right.ordinal)
        .map((emission) => this.#emissionView(emission)),
    );
  }

  #emissionClaimKey(evaluation: EvaluationRunRef, ordinal: number): string {
    return canonicalize({ evaluation, ordinal } as unknown as CanonicalValue);
  }

  #evaluationStatus(evaluation: EvaluationRecord): EvaluationStatus {
    const outcome = this.#outcomeFor(evaluation.ref);
    if (outcome) return outcome.kind;
    if (this.#unknownFor(evaluation.ref)) return "unknown";
    if (this.#attemptFor(evaluation.ref)) return "attempted";
    if (this.#localFailureFor(evaluation.ref)) return "failed-local";
    return "prepared";
  }

  #normalizeProjectionPlan(input: {
    readonly root: AxiomaticRootRef;
    readonly parent: AxiomaticRevisionRef;
    readonly occurrence: InvocationOccurrenceRef;
    readonly candidateInput: AxiomaticArtifactRef;
    readonly environment: AxiomaticArtifactRef;
    readonly endpoint: AxiomaticArtifactRef;
    readonly policy: PolicyRef;
    readonly explicitInputs: AxiomaticArtifactRef;
    readonly path: readonly AxiomaticRevisionRef[];
    readonly draft: ProjectionDraft;
  }): ProjectionPlanView {
    assertObject(input.draft, "ProjectionDraft");
    assertExactKeys(
      input.draft,
      input.draft.transformations === undefined
        ? ["selectedNodes", "appendContent"]
        : ["selectedNodes", "appendContent", "transformations"],
      "ProjectionDraft",
    );
    if (!Array.isArray(input.draft.selectedNodes)) {
      fail("AXIOMATIC_INVALID_PROJECTION", "ProjectionDraft.selectedNodes 必须是数组");
    }
    if (
      input.draft.transformations !== undefined &&
      !Array.isArray(input.draft.transformations)
    ) {
      fail("AXIOMATIC_INVALID_PROJECTION", "ProjectionDraft.transformations 必须是数组");
    }
    const selectedNodes = [...input.draft.selectedNodes];
    const allowedNodes = new Set(input.path.slice(1));
    if (
      selectedNodes.some((ref) => !isRef(ref) || !allowedNodes.has(ref)) ||
      new Set(selectedNodes).size !== selectedNodes.length
    ) {
      fail(
        "AXIOMATIC_INVALID_PROJECTION",
        "ProjectionPolicy 只能选择 parent 路径中的非根 Node",
      );
    }
    const transformations = input.draft.transformations ?? [];
    const value = objectValue({
      version: "projection-plan/v2",
      root: input.root,
      parent: input.parent,
      occurrence: input.occurrence,
      candidateInput: input.candidateInput,
      environment: input.environment,
      endpoint: input.endpoint,
      policy: input.policy,
      explicitInputs: input.explicitInputs,
      selectedNodes,
      appendContent: input.draft.appendContent,
      transformations: [...transformations],
    });
    const ref = contentRef(DOMAINS.projection, value);
    return Object.freeze({
      ref,
      root: input.root,
      parent: input.parent,
      occurrence: input.occurrence,
      candidateInput: input.candidateInput,
      environment: input.environment,
      endpoint: input.endpoint,
      policy: input.policy,
      explicitInputs: input.explicitInputs,
      selectedNodes: Object.freeze(selectedNodes),
      appendContent: copy(input.draft.appendContent),
      transformations: Object.freeze(transformations.map((item) => copy(item))),
    });
  }

  #pathEntries(path: readonly AxiomaticRevisionRef[]): readonly ProjectionPathEntry[] {
    return Object.freeze(
      path.map((ref) => {
        const root = this.#roots.get(ref as AxiomaticRootRef);
        if (root) {
          return Object.freeze({
            kind: "root" as const,
            ref: root.root,
            body: this.#rootView(root).body,
          });
        }
        const node = this.#nodes.get(ref as AxiomaticNodeRef);
        if (!node) fail("AXIOMATIC_CORRUPT_STATE", `路径缺少 Revision ${ref}`);
        return Object.freeze({
          kind: "node" as const,
          ref: node.ref,
          parent: node.parent,
          block: normalizeAxiomaticSemanticBlock(node.block),
        });
      }),
    );
  }

  #rootView(root: RootView): RootView {
    return Object.freeze({
      agent: root.agent,
      root: root.root,
      body: normalizeAxiomaticRootBody(root.body),
    });
  }

  #nodeView(node: NodeView): NodeView {
    return Object.freeze({
      ref: node.ref,
      root: node.root,
      agent: node.agent,
      parent: node.parent,
      block: normalizeAxiomaticSemanticBlock(node.block),
    });
  }

  #evaluationOccurrenceView(occurrence: EvaluationOccurrenceView): EvaluationOccurrenceView {
    return Object.freeze({
      ref: occurrence.ref,
      source: occurrence.source,
      position: copy(occurrence.position),
    });
  }

  #occurrenceView(occurrence: InvocationOccurrenceView): InvocationOccurrenceView {
    return Object.freeze({
      ref: occurrence.ref,
      source: occurrence.source,
      position: copy(occurrence.position),
      payloadRef: occurrence.payloadRef,
    });
  }

  #projectionView(plan: ProjectionPlanView): ProjectionPlanView {
    return Object.freeze({
      ref: plan.ref,
      root: plan.root,
      parent: plan.parent,
      occurrence: plan.occurrence,
      candidateInput: plan.candidateInput,
      environment: plan.environment,
      endpoint: plan.endpoint,
      policy: plan.policy,
      explicitInputs: plan.explicitInputs,
      selectedNodes: Object.freeze([...plan.selectedNodes]),
      appendContent: copy(plan.appendContent),
      transformations: Object.freeze(plan.transformations.map((item) => copy(item))),
    });
  }

  #outcomeView(outcome: OutcomeView): OutcomeView {
    return Object.freeze({
      ref: outcome.ref,
      evaluation: outcome.evaluation,
      attempt: outcome.attempt,
      kind: outcome.kind,
      detailsRef: outcome.detailsRef,
      details: copy(outcome.details),
    });
  }

  #unknownView(unknown: EvaluationUnknownView): EvaluationUnknownView {
    return Object.freeze({
      ref: unknown.ref,
      evaluation: unknown.evaluation,
      attempt: unknown.attempt,
      reasonRef: unknown.reasonRef,
      reason: copy(unknown.reason),
    });
  }

  #localFailureView(failure: EvaluationLocalFailureView): EvaluationLocalFailureView {
    return Object.freeze({
      ref: failure.ref,
      evaluation: failure.evaluation,
      phase: failure.phase,
      reasonRef: failure.reasonRef,
      reason: copy(failure.reason),
    });
  }

  #emissionView(emission: EmissionView): EmissionView {
    return Object.freeze({
      ref: emission.ref,
      evaluation: emission.evaluation,
      attempt: emission.attempt,
      ordinal: emission.ordinal,
      producer: emission.producer,
      protocol: emission.protocol,
      payloadRef: emission.payloadRef,
      payload: copy(emission.payload),
    });
  }

  #evaluationView(evaluation: EvaluationRecord): EvaluationView {
    const attempt = this.#attemptFor(evaluation.ref);
    const outcome = this.#outcomeFor(evaluation.ref);
    const unknown = this.#unknownFor(evaluation.ref);
    const localFailure = this.#localFailureFor(evaluation.ref);
    const emissionRefs = Object.freeze(
      [...this.#emissions.values()]
        .filter((emission) => emission.evaluation === evaluation.ref)
        .toSorted((left, right) => left.ordinal - right.ordinal)
        .map((emission) => emission.ref),
    );
    return Object.freeze({
      ref: evaluation.ref,
      root: evaluation.root,
      parent: evaluation.parent,
      occurrence: evaluation.occurrence,
      evaluationOccurrence: evaluation.evaluationOccurrence,
      projection: evaluation.projection,
      status: this.#evaluationStatus(evaluation),
      ...(attempt === undefined ? {} : { attempt }),
      emissions: emissionRefs,
      ...(outcome === undefined ? {} : { outcome }),
      ...(unknown === undefined || outcome === undefined ? {} : { lateOutcome: outcome }),
      ...(unknown === undefined ? {} : { unknown }),
      ...(localFailure === undefined
        ? {}
        : { localFailure: this.#localFailureView(localFailure) }),
    });
  }

  #adoptionView(result: AdoptionResult): AdoptionResult {
    return Object.freeze({
      key: result.key,
      evaluation: result.evaluation,
      parent: result.parent,
      policy: result.policy,
      explicitInputs: result.explicitInputs,
      decisionRef: result.decisionRef,
      decision: result.decision,
      ...(result.node === undefined ? {} : { node: this.#nodeView(result.node) }),
    });
  }
}

export function axiomaticPolicyRef(identity: PolicyIdentity): PolicyRef {
  return policyRef(identity);
}

export const AXIOMATIC_V2_DOMAINS = Object.freeze({ ...DOMAINS });
