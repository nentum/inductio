import {
  AxiomaticDurableEngine,
  type DurableStateView,
  type PreparedDurableEvaluation,
} from "./axiomatic-durable-engine.ts";
import { AxiomaticSqliteConnection, type AxiomaticSqliteOpenOptions } from "./axiomatic-sqlite-connection.ts";
import { SemanticError, STORAGE_CODES } from "./errors.ts";
import {
  createBuiltInModelAdapter,
  type BuiltInAdapterOptions,
} from "./model-adapters.ts";
import type { ModelInputV1, ModelAdapter } from "./model-adapter.ts";
import type {
  DurableProviderRequest,
  ModelEndpointV2,
  AxiomaticModelRequestV2,
} from "./model-contract.ts";
import { isAxiomaticModelRequestV2, modelRequestMatchesEndpoint } from "./model-contract.ts";
import type {
  AdoptionResult,
  AxiomaticRevisionRef,
  AxiomaticRootBody,
  EvaluationRunRef,
  EvaluationStatus,
  EvaluationView,
  RootView,
  SemanticItem,
} from "./axiomatic-v2.ts";
import type { CanonicalObject, CanonicalValue } from "./types.ts";

export type SqliteAgentRuntimeOptions = AxiomaticSqliteOpenOptions & BuiltInAdapterOptions;

export interface SqliteAgentRunInput {
  readonly parent: AxiomaticRevisionRef;
  readonly source: string;
  readonly position: CanonicalValue;
  readonly input: readonly SemanticItem[];
  readonly environment?: CanonicalValue;
  readonly evaluationOccurrence?: {
    readonly source: string;
    readonly position: CanonicalValue;
  };
  readonly signal?: AbortSignal;
}

export interface SqliteAgentRunResult {
  readonly status: "completed" | "failed" | "unknown";
  readonly parent: AxiomaticRevisionRef;
  readonly head: AxiomaticRevisionRef;
  readonly evaluation: EvaluationRunRef;
  readonly request: DurableProviderRequest;
  readonly output: readonly SemanticItem[];
  readonly adoption?: AdoptionResult;
  readonly errorCode?: string;
}

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function isDefinitiveModelFailure(error: SemanticError): boolean {
  return (
    error.code === "MODEL_HTTP" ||
    error.code === "MODEL_PROTOCOL" ||
    error.code === "MODEL_UNSUPPORTED_TOOL_CALL" ||
    error.code === "MODEL_RESPONSE_LIMIT"
  );
}

function modelInput(request: AxiomaticModelRequestV2): ModelInputV1 {
  return {
    version: "axiomatic-model-input/v1",
    root: request.root,
    history: request.modelInput.history,
    candidateInput: request.modelInput.candidateInput,
    environment: request.modelInput.environment,
  };
}

function adapterOptionsFromEndpoint(
  endpoint: ModelEndpointV2,
  options: Pick<SqliteAgentRuntimeOptions, "timeoutMs" | "userAgent">,
): BuiltInAdapterOptions {
  const common = {
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    ...(endpoint.maxTokens === undefined ? {} : { maxTokens: endpoint.maxTokens }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  };
  switch (endpoint.provider) {
    case "opencode-go":
      if (endpoint.adapter !== "openai-chat-completions/v1") {
        fail("AXIOMATIC_ENDPOINT_MISMATCH", "OpenCode Go endpoint has an invalid adapter");
      }
      return { ...common, provider: endpoint.provider, adapter: endpoint.adapter };
    case "openai":
      if (endpoint.adapter !== "openai-chat-completions/v1" && endpoint.adapter !== "openai-responses/v1") {
        fail("AXIOMATIC_ENDPOINT_MISMATCH", "OpenAI endpoint has an invalid adapter");
      }
      return { ...common, provider: endpoint.provider, adapter: endpoint.adapter };
    case "anthropic":
      if (endpoint.adapter !== "anthropic-messages/v1") {
        fail("AXIOMATIC_ENDPOINT_MISMATCH", "Anthropic endpoint has an invalid adapter");
      }
      return { ...common, provider: endpoint.provider, adapter: endpoint.adapter };
  }
}

/**
 * Public durable facade. The provider is selected declaratively; raw SQLite,
 * transport clients, fetch callbacks, credential resolvers, and core ports are
 * intentionally not part of this surface.
 */
export class SqliteAgentRuntime {
  readonly #connection: AxiomaticSqliteConnection;
  readonly #engine: AxiomaticDurableEngine;
  readonly #adapter: ModelAdapter;
  #closed = false;
  #running = false;
  #activeController: AbortController | undefined;

  private constructor(
    connection: AxiomaticSqliteConnection,
    engine: AxiomaticDurableEngine,
    adapter: ModelAdapter,
  ) {
    this.#connection = connection;
    this.#engine = engine;
    this.#adapter = adapter;
  }

  static open(
    path: string,
    root?: AxiomaticRootBody,
    options: SqliteAgentRuntimeOptions = {},
  ): SqliteAgentRuntime {
    const preflightAdapter = createBuiltInModelAdapter(options);
    const hasEndpointOverride = options.provider !== undefined ||
      options.adapter !== undefined ||
      options.baseUrl !== undefined ||
      options.model !== undefined ||
      options.maxTokens !== undefined;
    const connection = AxiomaticSqliteConnection.open(path, {
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    try {
      const engine = AxiomaticDurableEngine.open(connection, root);
      const persisted = engine.modelEndpoint();
      const adapter = hasEndpointOverride || persisted === undefined
        ? preflightAdapter
        : createBuiltInModelAdapter(adapterOptionsFromEndpoint(persisted, options));
      return new SqliteAgentRuntime(connection, engine, adapter);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  root(): RootView {
    this.#assertOpen();
    return this.#engine.root();
  }

  stateRef(): string {
    this.#assertOpen();
    return this.#engine.stateRef();
  }

  state(): DurableStateView {
    this.#assertOpen();
    return this.#engine.state();
  }

  path(head: AxiomaticRevisionRef): readonly AxiomaticRevisionRef[] {
    this.#assertOpen();
    return this.#engine.path(head);
  }

  evaluation(ref: EvaluationRunRef): EvaluationView {
    this.#assertOpen();
    return this.#engine.evaluation(ref);
  }

  async run(input: SqliteAgentRunInput): Promise<SqliteAgentRunResult> {
    this.#assertOpen();
    if (this.#running) fail("AXIOMATIC_RUNTIME_BUSY", "one runtime instance accepts one run at a time");
    if (input.signal?.aborted) fail("MODEL_ABORTED", "run was aborted before preparation");
    this.#adapter.assertReady();
    this.#running = true;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort("caller-aborted");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    this.#activeController = controller;
    let prepared: PreparedDurableEvaluation | undefined;
    try {
      prepared = this.#engine.prepareEvaluation({
        parent: input.parent,
        source: input.source,
        position: input.position,
        input: input.input,
        environment: input.environment ?? {
          version: "environment-snapshot/v1",
          values: null,
        },
        endpoint: this.#adapter.endpoint as unknown as CanonicalObject,
        ...(input.evaluationOccurrence === undefined
          ? {}
          : { evaluationOccurrence: input.evaluationOccurrence }),
      });
      if (controller.signal.aborted) {
        fail("MODEL_ABORTED", "run was aborted before dispatch");
      }
      if (!isAxiomaticModelRequestV2(prepared.request)) {
        fail("AXIOMATIC_ENDPOINT_MISMATCH", "new durable execution produced a legacy provider request");
      }
      if (!modelRequestMatchesEndpoint(prepared.request, this.#adapter.endpoint)) {
        fail("AXIOMATIC_ENDPOINT_MISMATCH", "durable request does not match the selected model endpoint");
      }
      const preparedCall = this.#adapter.prepare(modelInput(prepared.request));
      this.#engine.claimAttempt(prepared.evaluation);
      let completion;
      try {
        completion = await this.#adapter.complete(preparedCall, controller.signal);
      } catch (error) {
        if (!(error instanceof SemanticError)) {
          this.#engine.markUnknown(prepared.evaluation, {
            version: "axiomatic-model-unknown/v2",
            code: "MODEL_NETWORK",
          });
          return this.#unknownResult(prepared, "MODEL_NETWORK");
        }
        if (!isDefinitiveModelFailure(error)) {
          this.#engine.markUnknown(prepared.evaluation, {
            version: "axiomatic-model-unknown/v2",
            code: error.code,
          });
          return this.#unknownResult(prepared, error.code);
        }
        this.#engine.complete(prepared.evaluation, "failed", {
          version: "axiomatic-model-outcome/v2",
          code: error.code,
        });
        const adoption = this.#engine.reject(prepared.evaluation, { code: error.code });
        return {
          status: "failed",
          parent: input.parent,
          head: input.parent,
          evaluation: prepared.evaluation,
          request: prepared.request,
          output: Object.freeze([]),
          adoption,
          errorCode: error.code,
        };
      }
      this.#engine.recordEmission({
        evaluation: prepared.evaluation,
        ordinal: 0,
        producer: `${prepared.request.provider}/${prepared.request.model}`,
        protocol: prepared.request.adapter,
        payload: completion.output,
      });
      this.#engine.complete(prepared.evaluation, "completed", {
        version: "axiomatic-model-outcome/v2",
        adapter: prepared.request.adapter,
        finishReason: completion.finishReason,
        ...(completion.usage === undefined ? {} : { usage: completion.usage }),
      });
      const adoption = this.#engine.adoptCompleted(
        prepared.evaluation,
        prepared.request.modelInput.candidateInput,
        completion.output,
      );
      return {
        status: "completed",
        parent: input.parent,
        head: adoption.node?.ref ?? input.parent,
        evaluation: prepared.evaluation,
        request: prepared.request,
        output: completion.output,
        adoption,
      };
    } catch (error) {
      if (prepared !== undefined && !this.#connection.closed) {
        const status = this.#safeStatus(prepared.evaluation);
        try {
          if (status === "prepared") {
            this.#engine.failLocal(
              prepared.evaluation,
              "before-attempt",
              { code: error instanceof SemanticError ? error.code : "AXIOMATIC_RUNTIME_FAILURE" },
            );
          } else if (status === "attempted") {
            this.#engine.markUnknown(prepared.evaluation, {
              version: "axiomatic-model-unknown/v2",
              code: error instanceof SemanticError ? error.code : "AXIOMATIC_RUNTIME_FAILURE",
            });
          }
        } catch {
          // Restart recovery will convert an uncertain attempted state to unknown.
        }
      }
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      this.#activeController = undefined;
      this.#running = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#running) fail("AXIOMATIC_RUNTIME_BUSY", "cannot close while a model run is active");
    this.#closed = true;
    this.#engine.close();
  }

  /** Cancels the in-flight request; a durable attempt recovers as unknown. */
  crashClose(): void {
    if (this.#closed) return;
    this.#activeController?.abort("crash-close");
    this.#closed = true;
    this.#engine.close();
  }

  #unknownResult(
    prepared: PreparedDurableEvaluation,
    code: string,
  ): SqliteAgentRunResult {
    return {
      status: "unknown",
      parent: prepared.projection.parent,
      head: prepared.projection.parent,
      evaluation: prepared.evaluation,
      request: prepared.request,
      output: Object.freeze([]),
      errorCode: code,
    };
  }

  #safeStatus(evaluation: EvaluationRunRef): EvaluationStatus | undefined {
    try {
      return this.#engine.evaluation(evaluation).status;
    } catch {
      return undefined;
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#connection.closed) fail(STORAGE_CODES.CLOSED, "SQLite Agent runtime is closed");
  }
}
