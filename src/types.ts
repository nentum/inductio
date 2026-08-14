export type CanonicalPrimitive = null | boolean | number | string;

export type CanonicalObject = { readonly [key: string]: CanonicalValue };

export type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | CanonicalObject;

export interface CapabilitySpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: CanonicalValue;
}

export interface BuildSpec {
  readonly fixedSystemPrompt: string;
  readonly capabilities: readonly CapabilitySpec[];
}

export type ArtifactRef = string;
export type AgentRef = string;
export type AgentRootRef = string;
export type FactRef = string;
export type RevisionRef = AgentRootRef | FactRef;

export interface Cursor {
  readonly agent: AgentRef;
  readonly at: RevisionRef;
}

export interface TriggerSignal {
  readonly cursor: Cursor;
  readonly occurrences?: readonly ArtifactRef[];
  readonly evidence?: readonly ArtifactRef[];
  readonly pending?: readonly ArtifactRef[];
}

export interface Provenance {
  readonly producer: string;
  readonly sourceRef?: ArtifactRef;
}

export interface OwnerToken {
  readonly agent: AgentRef;
  readonly owner: string;
  readonly fence: bigint;
}

export interface TurnPermit {
  readonly turn: FactRef;
  readonly agent: AgentRef;
  readonly owner: string;
  readonly fence: bigint;
}

export interface EvaluationDispatchPermit {
  readonly turn: FactRef;
  readonly requestFact: FactRef;
  readonly request: ArtifactRef;
  readonly agent: AgentRef;
  readonly owner: string;
  readonly fence: bigint;
}

export class TransportSecrets {
  readonly values: Readonly<Record<string, string>>;

  constructor(values: Readonly<Record<string, string>> = {}) {
    this.values = Object.freeze({ ...values });
  }
}

export interface CompileProviderRequestInput {
  readonly turn: FactRef;
  readonly planRef: ArtifactRef;
  readonly endpointRef: ArtifactRef;
  readonly adapterRef: ArtifactRef;
  readonly semanticBody: CanonicalValue;
  readonly transportSecrets?: TransportSecrets;
}

export interface MaterializeEmissionInput {
  readonly turn: FactRef;
  readonly ordinal: number;
  readonly producer: string;
  readonly protocol: string;
  readonly payload: CanonicalValue;
}

export interface CaptureEmissionInput extends MaterializeEmissionInput {
  readonly token: OwnerToken;
}

export interface CapabilityPermit {
  readonly request: FactRef;
  readonly preparedFact: FactRef;
  readonly agent: AgentRef;
  readonly owner: string;
  readonly fence: bigint;
}

export interface RequestCapabilityInput {
  readonly agent: AgentRef;
  readonly parent: RevisionRef;
  readonly capability: string;
  readonly arguments: CanonicalValue;
  readonly sourceArtifactRef: ArtifactRef;
  readonly processorRef: ArtifactRef;
  readonly token: OwnerToken;
}

export interface MaterializeEvidenceInput {
  readonly request: FactRef;
  readonly ordinal: number;
  readonly producer: string;
  readonly protocol: string;
  readonly payload: CanonicalValue;
}

export interface CaptureEvidenceInput extends MaterializeEvidenceInput {
  readonly token: OwnerToken;
}

export interface RecomposeOutput {
  readonly schema: string;
  readonly payload: CanonicalValue;
  readonly references?: readonly ArtifactRef[];
}

export interface RecomposeInput {
  readonly targetBuild: BuildSpec;
  readonly targetParent?: RevisionRef;
  readonly materials: readonly ArtifactRef[];
  readonly transformationRef: ArtifactRef;
  readonly outputs: readonly RecomposeOutput[];
  readonly provenance: Provenance;
  readonly token: OwnerToken;
}

export interface PrepareProjectionInput {
  readonly turn: FactRef;
  readonly permit?: TurnPermit;
  readonly token: OwnerToken;
  readonly environmentRef: ArtifactRef;
  readonly projectionPolicyRef: ArtifactRef;
  readonly endpointRef: ArtifactRef;
  readonly selectedFacts: readonly FactRef[];
  readonly selectedArtifacts?: readonly ArtifactRef[];
  readonly transformations?: readonly ArtifactRef[];
  readonly localInvariantResults?: CanonicalValue;
}

export interface PreparedProjection {
  readonly snapshotRef: ArtifactRef;
  readonly planRef: ArtifactRef;
  readonly factRef: FactRef;
}

export interface WallClock {
  nowMs(): bigint;
}

export interface OwnerLeaseRecord {
  readonly agent: AgentRef;
  readonly owner: string;
  readonly fence: bigint;
  readonly expiresAtMs: bigint;
  readonly renewedAtMs: bigint;
}

export interface RelationClaim {
  readonly namespace: string;
  readonly scope: string;
  readonly key: CanonicalValue;
  readonly result: CanonicalValue;
  readonly conflictCode: string;
}

export interface StoredArtifact<T extends CanonicalValue = CanonicalValue> {
  readonly ref: ArtifactRef;
  readonly domain: string;
  readonly value: T;
  readonly canonicalBytes: string;
}
