import {
  AxiomaticDurableEngine,
  type AxiomaticProviderRequestV1,
  type DurableStateView,
} from "./axiomatic-durable-engine.ts";
import { AxiomaticSqliteConnection, type AxiomaticSqliteOpenOptions } from "./axiomatic-sqlite-connection.ts";
import { SemanticError, STORAGE_CODES } from "./errors.ts";
import {
  OpenCodeGoClient,
  type OpenCodeGoClientOptions,
  type OpenCodeGoCompletionV1,
  type OpenCodeGoModelRequestV1,
} from "./opencode-go-client.ts";
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
import type { CanonicalValue } from "./types.ts";

const ENDPOINT_VERSION = "opencode-go-endpoint/v1" as const;
const PROTOCOL = "opencode-go-chat-completions/v1";

export interface SqliteAgentRuntimeOptions extends AxiomaticSqliteOpenOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

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
  readonly request: AxiomaticProviderRequestV1;
  readonly output: readonly SemanticItem[];
  readonly adoption?: AdoptionResult;
  readonly errorCode?: string;
}

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function isDefinitiveProviderFailure(error: SemanticError): boolean {
  return (
    error.code === "OPENCODE_GO_HTTP" ||
    error.code === "OPENCODE_GO_PROTOCOL" ||
    error.code === "OPENCODE_GO_UNSUPPORTED_TOOL_CALL" ||
    error.code === "OPENCODE_GO_RESPONSE_LIMIT"
  );
}

function providerRequest(request: AxiomaticProviderRequestV1): OpenCodeGoModelRequestV1 {
  return {
    version: "opencode-go-model-request/v1",
    model: request.model,
    root: request.root,
    history: request.modelInput.history,
    candidateInput: request.modelInput.candidateInput,
    environment: request.modelInput.environment,
  };
}

/**
 * Public durable facade. It exposes no SQLite handle, owner token, policy
 * callback, transport secret, or core write port.
 */
export class SqliteAgentRuntime {
  readonly #connection: AxiomaticSqliteConnection;
  readonly #engine: AxiomaticDurableEngine;
  readonly #client: OpenCodeGoClient;
  #closed = false;
  #running = false;
  #activeController: AbortController | undefined;

  private constructor(
    connection: AxiomaticSqliteConnection,
    engine: AxiomaticDurableEngine,
    client: OpenCodeGoClient,
  ) {
    this.#connection = connection;
    this.#engine = engine;
    this.#client = client;
  }

  static open(
    path: string,
    root?: AxiomaticRootBody,
    options: SqliteAgentRuntimeOptions = {},
  ): SqliteAgentRuntime {
    const clientOptions: OpenCodeGoClientOptions = {
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    };
    const client = new OpenCodeGoClient(clientOptions);
    const connection = AxiomaticSqliteConnection.open(path, {
      ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    try {
      const engine = AxiomaticDurableEngine.open(connection, root);
      return new SqliteAgentRuntime(connection, engine, client);
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
    if (input.signal?.aborted) fail("OPENCODE_GO_ABORTED", "run was aborted before preparation");
    this.#client.assertReady();
    this.#running = true;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort("caller-aborted");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    this.#activeController = controller;
    let prepared: ReturnType<AxiomaticDurableEngine["prepareOpenCodeEvaluation"]> | undefined;
    try {
      prepared = this.#engine.prepareOpenCodeEvaluation({
        parent: input.parent,
        source: input.source,
        position: input.position,
        input: input.input,
        environment: input.environment ?? {
          version: "environment-snapshot/v1",
          values: null,
        },
        endpoint: {
          version: ENDPOINT_VERSION,
          provider: "opencode-go",
          baseUrl: this.#client.baseUrl,
          model: this.#client.model,
        },
        ...(input.evaluationOccurrence === undefined
          ? {}
          : { evaluationOccurrence: input.evaluationOccurrence }),
      });
      if (controller.signal.aborted) {
        fail("OPENCODE_GO_ABORTED", "run was aborted before dispatch");
      }
      if (
        prepared.request.provider !== "opencode-go" ||
        prepared.request.baseUrl !== this.#client.baseUrl ||
        prepared.request.model !== this.#client.model
      ) {
        fail("AXIOMATIC_ENDPOINT_MISMATCH", "durable request does not match the configured transport");
      }
      this.#client.prepare(providerRequest(prepared.request));
      this.#engine.claimAttempt(prepared.evaluation);
      let completion: OpenCodeGoCompletionV1;
      try {
        completion = await this.#client.complete(providerRequest(prepared.request), controller.signal);
      } catch (error) {
        if (!(error instanceof SemanticError)) {
          this.#engine.markUnknown(prepared.evaluation, {
            version: "axiomatic-provider-unknown/v1",
            code: "OPENCODE_GO_NETWORK",
          });
          return this.#unknownResult(prepared, "OPENCODE_GO_NETWORK");
        }
        if (!isDefinitiveProviderFailure(error)) {
          this.#engine.markUnknown(prepared.evaluation, {
            version: "axiomatic-provider-unknown/v1",
            code: error.code,
          });
          return this.#unknownResult(prepared, error.code);
        }
        this.#engine.complete(prepared.evaluation, "failed", {
          version: "opencode-go-outcome/v1",
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
        producer: `opencode-go/${this.#client.model}`,
        protocol: PROTOCOL,
        payload: completion.output,
      });
      this.#engine.complete(prepared.evaluation, "completed", {
        version: "opencode-go-outcome/v1",
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
      if (
        prepared !== undefined &&
        !this.#connection.closed &&
        this.#safeStatus(prepared.evaluation) === "attempted"
      ) {
        try {
          this.#engine.markUnknown(prepared.evaluation, {
            version: "axiomatic-provider-unknown/v1",
            code: error instanceof SemanticError ? error.code : "AXIOMATIC_RUNTIME_FAILURE",
          });
        } catch {
          // Restart recovery will convert the durable attempt to unknown.
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
    if (this.#running) fail("AXIOMATIC_RUNTIME_BUSY", "cannot close while a provider run is active");
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
    prepared: ReturnType<AxiomaticDurableEngine["prepareOpenCodeEvaluation"]>,
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
