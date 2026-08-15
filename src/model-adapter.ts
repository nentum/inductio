import { canonicalize, immutableCanonicalCopy } from "./canonical-v1.ts";
import { SemanticError } from "./errors.ts";
import {
  normalizeAxiomaticRootBody,
  normalizeAxiomaticSemanticBlock,
  normalizeAxiomaticSemanticItems,
  type AxiomaticRootBody,
  type SemanticBlock,
  type SemanticItem,
} from "./axiomatic-v2.ts";
import type {
  ModelAdapterId,
  ModelEndpointV2,
  ModelProviderId,
  NormalizedModelCompletionV1,
} from "./model-contract.ts";
import type { CanonicalObject, CanonicalValue } from "./types.ts";

export const DEFAULT_MODEL_TIMEOUT_MS = 300_000;
export const MAX_MODEL_TIMEOUT_MS = 600_000;
export const MAX_MODEL_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ModelInputV1 {
  readonly version: "axiomatic-model-input/v1";
  readonly root: AxiomaticRootBody;
  readonly history: readonly SemanticBlock[];
  readonly candidateInput: readonly SemanticItem[];
  readonly environment: CanonicalValue;
}

export interface PreparedModelCall {
  readonly version: "prepared-model-call/v1";
  readonly input: ModelInputV1;
  readonly body: string;
}

export interface ModelAdapter {
  readonly provider: ModelProviderId;
  readonly adapter: ModelAdapterId;
  readonly baseUrl: string;
  readonly model: string;
  readonly endpoint: ModelEndpointV2;
  assertReady(): void;
  prepare(input: ModelInputV1): PreparedModelCall;
  complete(prepared: PreparedModelCall, signal?: AbortSignal): Promise<NormalizedModelCompletionV1>;
}

export interface AdapterConstructorOptions {
  readonly provider: ModelProviderId;
  readonly adapter: ModelAdapterId;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly userAgent?: string;
}

export interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_call_id?: string;
  readonly name?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  }[];
}

export interface OpenAIToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: CanonicalObject;
  };
}

export interface OpenAIResponseInputItem {
  readonly type: "message" | "function_call" | "function_call_output";
  readonly role?: "user" | "assistant";
  readonly content?: readonly {
    readonly type: "input_text" | "output_text";
    readonly text: string;
  }[];
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly output?: string;
}

export interface AnthropicContentBlock {
  readonly type: "text" | "tool_use" | "tool_result";
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: CanonicalValue;
  readonly tool_use_id?: string;
  readonly content?: string;
  readonly is_error?: boolean;
}

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentBlock[];
}

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function supportedAdapterPair(provider: ModelProviderId, adapter: ModelAdapterId): boolean {
  return (provider === "opencode-go" && adapter === "openai-chat-completions/v1") ||
    (provider === "openai" && (adapter === "openai-chat-completions/v1" || adapter === "openai-responses/v1")) ||
    (provider === "anthropic" && adapter === "anthropic-messages/v1");
}

export function adapterFail(code: string, message: string): never {
  fail(code, message);
}

export function immutableCopy(value: CanonicalValue): CanonicalValue {
  return immutableCanonicalCopy(value);
}

export function contentText(value: CanonicalValue): string {
  return typeof value === "string" ? value : canonicalize(value);
}

export function assertFiniteInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("MODEL_INVALID_INPUT", `${label} is outside the supported range`);
  }
}

export function nonEmpty(value: unknown, label: string, code = "MODEL_INVALID_INPUT"): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${label} must be a non-empty string`);
  }
}

export function normalizeBaseUrl(value: string): string {
  nonEmpty(value, "baseUrl");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("MODEL_INVALID_INPUT", "baseUrl must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    fail("MODEL_INSECURE_ENDPOINT", "model endpoint must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    fail("MODEL_INVALID_INPUT", "baseUrl must not contain credentials, query, or fragment");
  }
  return url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
}

export function normalizeModelInput(value: ModelInputV1): ModelInputV1 {
  try {
    canonicalize(value as unknown as CanonicalValue);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("MODEL_INVALID_INPUT", "model input must be an object");
    }
    const keys = Object.keys(value).toSorted();
    const expected = ["candidateInput", "environment", "history", "root", "version"].toSorted();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      fail("MODEL_INVALID_INPUT", "model input has an invalid field set");
    }
    if (value.version !== "axiomatic-model-input/v1" || !Array.isArray(value.history) || !Array.isArray(value.candidateInput)) {
      fail("MODEL_INVALID_INPUT", "model input version or arrays are invalid");
    }
    const root = normalizeAxiomaticRootBody(value.root);
    const history = value.history.map((block) => normalizeAxiomaticSemanticBlock(block));
    const candidateInput = normalizeAxiomaticSemanticItems(value.candidateInput, "candidateInput");
    if (candidateInput.some((item) => !((item.kind === "message" && item.role === "user") || item.kind === "tool-result"))) {
      fail("MODEL_INVALID_INPUT", "candidateInput accepts only user messages and tool results");
    }
    return Object.freeze({
      version: value.version,
      root,
      history: Object.freeze(history),
      candidateInput,
      environment: immutableCopy(value.environment),
    });
  } catch (error) {
    if (error instanceof SemanticError && error.code.startsWith("MODEL_")) throw error;
    fail("MODEL_INVALID_INPUT", "model input is not canonical semantic data");
  }
}

function semanticToOpenAIChatItems(item: SemanticItem): readonly OpenAIChatMessage[] {
  switch (item.kind) {
    case "message":
      return [{ role: item.role, content: contentText(item.content) }];
    case "thinking":
      return [{ role: "assistant", content: `[thinking]\n${contentText(item.content)}` }];
    case "tool-call":
      return [{
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.callId,
          type: "function",
          function: { name: item.name, arguments: canonicalize(item.arguments) },
        }],
      }];
    case "tool-result":
      return [{
        role: "tool",
        tool_call_id: item.callId,
        name: item.name,
        content: canonicalize({ result: item.result, isError: item.isError }),
      }];
  }
}

export function openAIChatMessages(input: ModelInputV1): readonly OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [{ role: "system", content: input.root.rootPrompt }];
  if (input.environment !== null) {
    messages.push({ role: "system", content: `[environment]\n${contentText(input.environment)}` });
  }
  for (const block of input.history) {
    for (const item of block.input) messages.push(...semanticToOpenAIChatItems(item));
    for (const item of block.output) messages.push(...semanticToOpenAIChatItems(item));
  }
  for (const item of input.candidateInput) messages.push(...semanticToOpenAIChatItems(item));
  return Object.freeze(messages);
}

export function openAITools(root: AxiomaticRootBody): readonly OpenAIToolDefinition[] {
  return Object.freeze(root.toolDefinitions.map((tool) => Object.freeze({
    type: "function" as const,
    function: Object.freeze({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }),
  })));
}

function responseMessage(role: "user" | "assistant", item: SemanticItem): OpenAIResponseInputItem {
  if (item.kind === "message") {
    return {
      type: "message",
      role,
      content: [{
        type: role === "user" ? "input_text" : "output_text",
        text: contentText(item.content),
      }],
    };
  }
  if (item.kind === "thinking") {
    return {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `[thinking]\n${contentText(item.content)}` }],
    };
  }
  if (item.kind === "tool-call") {
    return {
      type: "function_call",
      call_id: item.callId,
      name: item.name,
      arguments: canonicalize(item.arguments),
    };
  }
  return {
    type: "function_call_output",
    call_id: item.callId,
    output: canonicalize({ result: item.result, isError: item.isError }),
  };
}

export function openAIResponsesInput(input: ModelInputV1): readonly OpenAIResponseInputItem[] {
  const items: OpenAIResponseInputItem[] = [];
  if (input.environment !== null) {
    items.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `[environment]\n${contentText(input.environment)}` }],
    });
  }
  for (const block of input.history) {
    for (const item of block.input) items.push(responseMessage(item.kind === "message" ? item.role : "user", item));
    for (const item of block.output) items.push(responseMessage("assistant", item));
  }
  for (const item of input.candidateInput) items.push(responseMessage("user", item));
  return Object.freeze(items);
}

function anthropicBlock(item: SemanticItem): AnthropicContentBlock {
  switch (item.kind) {
    case "message":
      return { type: "text", text: contentText(item.content) };
    case "thinking":
      return { type: "text", text: `[thinking]\n${contentText(item.content)}` };
    case "tool-call":
      return { type: "tool_use", id: item.callId, name: item.name, input: immutableCopy(item.arguments) };
    case "tool-result":
      return {
        type: "tool_result",
        tool_use_id: item.callId,
        content: contentText(item.result),
        ...(item.isError ? { is_error: true } : {}),
      };
  }
}

function pushAnthropicItems(
  messages: AnthropicMessage[],
  role: "user" | "assistant",
  items: readonly SemanticItem[],
): void {
  if (items.length === 0) return;
  const blocks = items.map(anthropicBlock);
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    messages[messages.length - 1] = {
      role,
      content: Object.freeze([...previous.content, ...blocks]),
    };
    return;
  }
  messages.push({ role, content: Object.freeze(blocks) });
}

export function anthropicMessages(input: ModelInputV1): readonly AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  if (input.environment !== null) {
    pushAnthropicItems(messages, "user", [{ kind: "message", role: "user", content: `[environment]\n${contentText(input.environment)}` }]);
  }
  for (const block of input.history) {
    pushAnthropicItems(messages, "user", block.input);
    pushAnthropicItems(messages, "assistant", block.output);
  }
  pushAnthropicItems(messages, "user", input.candidateInput);
  return Object.freeze(messages);
}

export function anthropicTools(root: AxiomaticRootBody): readonly CanonicalObject[] {
  return Object.freeze(root.toolDefinitions.map((tool) => Object.freeze({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  })));
}

export function createModelEndpoint(options: AdapterConstructorOptions): ModelEndpointV2 {
  return Object.freeze({
    version: "model-endpoint/v2",
    provider: options.provider,
    adapter: options.adapter,
    baseUrl: options.baseUrl,
    model: options.model,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  });
}

export abstract class JsonModelAdapter implements ModelAdapter {
  readonly provider: ModelProviderId;
  readonly adapter: ModelAdapterId;
  readonly baseUrl: string;
  readonly model: string;
  readonly endpoint: ModelEndpointV2;
  readonly #apiKeyEnv: string;
  readonly #timeoutMs: number;
  protected readonly maxTokens: number | undefined;
  readonly #fetch: typeof globalThis.fetch;
  protected readonly userAgent: string;

  protected constructor(options: AdapterConstructorOptions) {
    this.provider = options.provider;
    this.adapter = options.adapter;
    if (!supportedAdapterPair(this.provider, this.adapter)) {
      fail("MODEL_UNSUPPORTED_ADAPTER", `unsupported provider/adapter combination: ${this.provider}/${this.adapter}`);
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    nonEmpty(options.model, "model");
    this.model = options.model;
    nonEmpty(options.apiKeyEnv, "apiKeyEnv");
    this.#apiKeyEnv = options.apiKeyEnv;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    assertFiniteInteger(this.#timeoutMs, "timeoutMs", 1, MAX_MODEL_TIMEOUT_MS);
    this.maxTokens = options.maxTokens;
    if (this.maxTokens !== undefined) assertFiniteInteger(this.maxTokens, "maxTokens", 1, 1_000_000);
    this.#fetch = globalThis.fetch;
    if (typeof this.#fetch !== "function") fail("MODEL_UNAVAILABLE", "global fetch is unavailable");
    this.userAgent = options.userAgent ?? `axiomatic-agent-runtime/${options.adapter}`;
    if (!/^[\x20-\x7e]{1,256}$/.test(this.userAgent)) {
      fail("MODEL_INVALID_INPUT", "userAgent must be 1-256 printable ASCII characters");
    }
    this.endpoint = createModelEndpoint({ ...options, baseUrl: this.baseUrl });
  }

  assertReady(): void {
    this.#readApiKey();
  }

  prepare(input: ModelInputV1): PreparedModelCall {
    const normalized = normalizeModelInput(input);
    const body = canonicalize(this.compileBody(normalized));
    if (Buffer.byteLength(body, "utf8") > MAX_MODEL_REQUEST_BYTES) {
      fail("MODEL_REQUEST_LIMIT", "model request exceeds the protocol limit");
    }
    return Object.freeze({
      version: "prepared-model-call/v1",
      input: normalized,
      body,
    });
  }

  async complete(prepared: PreparedModelCall, signal?: AbortSignal): Promise<NormalizedModelCompletionV1> {
    if (signal?.aborted) fail("MODEL_ABORTED", "model request was aborted before dispatch");
    const apiKey = this.#readApiKey();
    const controller = new AbortController();
    let timedOut = false;
    let rejectCancellation: ((error: SemanticError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("timeout");
      rejectCancellation?.(new SemanticError("MODEL_TIMEOUT", "model request timed out"));
    }, this.#timeoutMs);
    const onAbort = (): void => {
      controller.abort("caller-aborted");
      rejectCancellation?.(new SemanticError("MODEL_ABORTED", "model request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      let response: Response;
      try {
        response = await Promise.race([this.#fetch(this.urlPath(), {
          method: "POST",
          headers: this.requestHeaders(apiKey),
          body: prepared.body,
          signal: controller.signal,
        }), cancellation]);
      } catch (error) {
        if (timedOut) fail("MODEL_TIMEOUT", "model request timed out");
        if (signal?.aborted) fail("MODEL_ABORTED", "model request was aborted");
        fail("MODEL_NETWORK", "model network request failed");
      }
      if (!response.ok) {
        fail("MODEL_HTTP", `model provider returned HTTP ${response.status}`);
      }
      let text: string;
      try {
        text = await Promise.race([readResponseText(response), cancellation]);
      } catch (error) {
        if (timedOut) fail("MODEL_TIMEOUT", "model response timed out");
        if (signal?.aborted) fail("MODEL_ABORTED", "model response was aborted");
        if (error instanceof SemanticError) throw error;
        fail("MODEL_NETWORK", "model response body could not be read");
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        fail("MODEL_PROTOCOL", "model provider returned invalid JSON");
      }
      try {
        return this.parseCompletion(value);
      } catch (error) {
        if (error instanceof SemanticError && error.code.startsWith("MODEL_")) throw error;
        fail("MODEL_PROTOCOL", "model provider returned an invalid completion");
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      controller.abort("complete");
    }
    fail("MODEL_PROTOCOL", "model request completed without a response");
  }

  protected abstract compileBody(input: ModelInputV1): CanonicalValue;
  protected abstract urlPath(): string;
  protected abstract requestHeaders(apiKey: string): Record<string, string>;
  protected abstract parseCompletion(value: unknown): NormalizedModelCompletionV1;

  #readApiKey(): string {
    const apiKey = process.env[this.#apiKeyEnv];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      fail("MODEL_KEY_MISSING", "model provider credential is not configured");
    }
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      fail("MODEL_KEY_INVALID", "model provider credential is invalid");
    }
    return apiKey;
  }
}

export async function readResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > MAX_MODEL_RESPONSE_BYTES) {
    fail("MODEL_RESPONSE_LIMIT", "model response exceeds the protocol limit");
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_MODEL_RESPONSE_BYTES) {
      fail("MODEL_RESPONSE_LIMIT", "model response exceeds the protocol limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_MODEL_RESPONSE_BYTES) {
        await reader.cancel();
        fail("MODEL_RESPONSE_LIMIT", "model response exceeds the protocol limit");
      }
      try {
        chunks.push(decoder.decode(next.value, { stream: true }));
      } catch {
        fail("MODEL_PROTOCOL", "model response is not valid UTF-8");
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch {
      fail("MODEL_PROTOCOL", "model response is not valid UTF-8");
    }
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("MODEL_PROTOCOL", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") fail("MODEL_PROTOCOL", `${label} must be a string`);
  return value;
}

export function optionalCanonical(value: unknown, label: string): CanonicalValue | undefined {
  if (value === undefined) return undefined;
  try {
    return immutableCopy(value as CanonicalValue);
  } catch {
    fail("MODEL_PROTOCOL", `${label} is not canonical data`);
  }
}

export function textParts(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) fail("MODEL_PROTOCOL", `${label} is invalid`);
  return value.map((part, index) => {
    const record = objectValue(part, `${label}[${index}]`);
    return stringValue(record.text, `${label}[${index}].text`);
  }).join("");
}

export function normalizedCompletion(
  output: readonly SemanticItem[],
  finishReason: string,
  usage?: CanonicalValue,
): NormalizedModelCompletionV1 {
  nonEmpty(finishReason, "finishReason", "MODEL_PROTOCOL");
  if (output.length === 0) fail("MODEL_PROTOCOL", "model completion has no output");
  return Object.freeze({
    version: "model-completion/v1",
    output: normalizeAxiomaticSemanticItems(output, "model output"),
    finishReason,
    ...(usage === undefined ? {} : { usage: immutableCopy(usage) }),
  });
}

export function unsupportedToolCall(): never {
  fail("MODEL_UNSUPPORTED_TOOL_CALL", "capability execution is not enabled in this profile");
}
