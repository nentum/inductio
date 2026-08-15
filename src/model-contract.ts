import type {
  AxiomaticRootBody,
  EvaluationRunRef,
  ProjectionPlanRef,
  SemanticBlock,
  SemanticItem,
} from "./axiomatic-v2.ts";
import type { CanonicalValue } from "./types.ts";

export type ModelAdapterId =
  | "openai-chat-completions/v1"
  | "openai-responses/v1"
  | "anthropic-messages/v1";

export type ModelProviderId = "opencode-go" | "openai" | "anthropic";

export interface ModelEndpointV2 {
  readonly version: "model-endpoint/v2";
  readonly provider: ModelProviderId;
  readonly adapter: ModelAdapterId;
  readonly baseUrl: string;
  readonly model: string;
  readonly maxTokens?: number;
}

export interface AxiomaticModelRequestV2 {
  readonly ref: string;
  readonly version: "axiomatic-model-request/v2";
  readonly evaluation: EvaluationRunRef;
  readonly projection: ProjectionPlanRef;
  readonly endpoint: string;
  readonly provider: ModelProviderId;
  readonly adapter: ModelAdapterId;
  readonly baseUrl: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly root: AxiomaticRootBody;
  readonly modelInput: {
    readonly version: "axiomatic-model-input/v1";
    readonly history: readonly SemanticBlock[];
    readonly candidateInput: readonly SemanticItem[];
    readonly environment: CanonicalValue;
  };
}

export interface NormalizedModelCompletionV1 {
  readonly version: "model-completion/v1";
  readonly output: readonly SemanticItem[];
  readonly finishReason: string;
  readonly usage?: CanonicalValue;
}

export type DurableProviderRequest = AxiomaticModelRequestV2 | {
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
};

export function isAxiomaticModelRequestV2(
  request: DurableProviderRequest,
): request is AxiomaticModelRequestV2 {
  return request.version === "axiomatic-model-request/v2";
}

/** Defense-in-depth binding between durable identity and the selected wire adapter. */
export function modelRequestMatchesEndpoint(
  request: Pick<
    AxiomaticModelRequestV2,
    "provider" | "adapter" | "baseUrl" | "model" | "maxTokens"
  >,
  endpoint: ModelEndpointV2,
): boolean {
  return request.provider === endpoint.provider &&
    request.adapter === endpoint.adapter &&
    request.baseUrl === endpoint.baseUrl &&
    request.model === endpoint.model &&
    request.maxTokens === endpoint.maxTokens;
}
