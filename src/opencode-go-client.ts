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
import type { CanonicalValue } from "./types.ts";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_API_KEY_ENV = "OPENCODE_GO";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export interface OpenCodeGoMessageV1 {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_call_id?: string;
  readonly name?: string;
}

export interface OpenCodeGoToolV1 {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: CanonicalValue;
  };
}

export interface OpenCodeGoChatRequestV1 {
  readonly version: "opencode-go-chat-request/v1";
  readonly model: string;
  readonly messages: readonly OpenCodeGoMessageV1[];
  readonly tools?: readonly OpenCodeGoToolV1[];
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface OpenCodeGoModelRequestV1 {
  readonly version: "opencode-go-model-request/v1";
  readonly model?: string;
  readonly root: AxiomaticRootBody;
  readonly history: readonly SemanticBlock[];
  readonly candidateInput: readonly SemanticItem[];
  readonly environment?: CanonicalValue;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface OpenCodeGoCompletionV1 {
  readonly version: "opencode-go-completion/v1";
  readonly output: readonly SemanticItem[];
  readonly finishReason: string;
  readonly usage?: CanonicalValue;
}

export interface OpenCodeGoClientOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail("OPENCODE_GO_INVALID_INPUT", `${label} must be a non-empty string`);
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("OPENCODE_GO_INVALID_INPUT", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    fail("OPENCODE_GO_INVALID_INPUT", `${label} has an invalid field set`);
  }
}

function normalizedModelRequest(value: unknown): OpenCodeGoModelRequestV1 {
  const input = recordValue(value, "model request");
  assertKeys(
    input,
    ["version", "model", "root", "history", "candidateInput", "environment", "temperature", "maxTokens"],
    ["version", "root", "history", "candidateInput"],
    "model request",
  );
  if (input.version !== "opencode-go-model-request/v1") {
    fail("OPENCODE_GO_UNSUPPORTED_VERSION", "unsupported OpenCode Go model request version");
  }
  if (!Array.isArray(input.history) || !Array.isArray(input.candidateInput)) {
    fail("OPENCODE_GO_INVALID_INPUT", "model request history and candidateInput must be arrays");
  }
  try {
    canonicalize(input);
    const root = normalizeAxiomaticRootBody(input.root as AxiomaticRootBody);
    const history = input.history.map((block) =>
      normalizeAxiomaticSemanticBlock(block as SemanticBlock),
    );
    const candidateInput = normalizeAxiomaticSemanticItems(
      input.candidateInput as readonly SemanticItem[],
      "OpenCode Go candidateInput",
    );
    if (candidateInput.some((item) => !((item.kind === "message" && item.role === "user") || item.kind === "tool-result"))) {
      fail("OPENCODE_GO_INVALID_INPUT", "candidateInput accepts only user messages and tool results");
    }
    if (input.model !== undefined) nonEmpty(input.model, "model");
    const result: OpenCodeGoModelRequestV1 = {
      version: input.version,
      root,
      history: Object.freeze(history),
      candidateInput,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.environment === undefined ? {} : { environment: immutableCanonicalCopy(input.environment as CanonicalValue) }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature as number }),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens as number }),
    };
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof SemanticError && error.code.startsWith("OPENCODE_GO_")) throw error;
    fail("OPENCODE_GO_INVALID_INPUT", "model request contains invalid semantic data");
  }
}

function assertFiniteInteger(value: unknown, label: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("OPENCODE_GO_INVALID_INPUT", `${label} is outside the supported range`);
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value ?? DEFAULT_BASE_URL;
  nonEmpty(raw, "baseUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("OPENCODE_GO_INVALID_INPUT", "baseUrl must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    fail("OPENCODE_GO_INSECURE_ENDPOINT", "OpenCode Go endpoint must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    fail("OPENCODE_GO_INVALID_INPUT", "baseUrl must not contain credentials, query, or fragment");
  }
  return url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
}

function canonicalCopy(
  value: unknown,
  label: string,
  code = "OPENCODE_GO_INVALID_INPUT",
): CanonicalValue {
  try {
    return immutableCanonicalCopy(value as CanonicalValue);
  } catch {
    fail(code, `${label} must be a canonical value`);
  }
}

function copyContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return canonicalize(value);
  } catch {
    fail("OPENCODE_GO_INVALID_INPUT", "semantic content cannot be serialized");
  }
}

function semanticItemToMessage(item: SemanticItem): OpenCodeGoMessageV1 {
  switch (item.kind) {
    case "message":
      return Object.freeze({
        role: item.role,
        content: copyContent(item.content),
      });
    case "thinking":
      return Object.freeze({
        role: "assistant",
        content: `[thinking]\n${copyContent(item.content)}`,
      });
    case "tool-call":
      return Object.freeze({
        role: "assistant",
        content: canonicalize({
          kind: item.kind,
          callId: item.callId,
          name: item.name,
          arguments: item.arguments,
        }),
      });
    case "tool-result":
      return Object.freeze({
        role: "tool",
        tool_call_id: item.callId,
        name: item.name,
        content: canonicalize({
          result: item.result,
          isError: item.isError,
        }),
      });
  }
}

export function compileOpenCodeGoChatRequest(
  input: OpenCodeGoModelRequestV1,
  options: Pick<OpenCodeGoClientOptions, "model"> = {},
): OpenCodeGoChatRequestV1 {
  const normalized = normalizedModelRequest(input);
  const model = normalized.model ?? options.model ?? DEFAULT_MODEL;
  nonEmpty(model, "model");
  const messages: OpenCodeGoMessageV1[] = [
    { role: "system", content: normalized.root.rootPrompt },
  ];
  const tools: OpenCodeGoToolV1[] = normalized.root.toolDefinitions.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
  for (const block of normalized.history) {
    for (const item of block.input) messages.push(semanticItemToMessage(item));
    for (const item of block.output) messages.push(semanticItemToMessage(item));
  }
  if (normalized.environment !== undefined) {
    messages.push({ role: "system", content: `[environment]\n${copyContent(normalized.environment)}` });
  }
  for (const item of normalized.candidateInput) messages.push(semanticItemToMessage(item));
  const request: OpenCodeGoChatRequestV1 = {
    version: "opencode-go-chat-request/v1",
    model,
    messages: Object.freeze(messages),
    ...(tools.length === 0 ? {} : { tools: Object.freeze(tools) }),
    ...(normalized.temperature === undefined ? {} : { temperature: normalized.temperature }),
    ...(normalized.maxTokens === undefined ? {} : { maxTokens: normalized.maxTokens }),
  };
  if (request.temperature !== undefined) {
    if (typeof request.temperature !== "number" || !Number.isFinite(request.temperature) || request.temperature < 0) {
      fail("OPENCODE_GO_INVALID_INPUT", "temperature must be a finite non-negative number");
    }
  }
  if (request.maxTokens !== undefined) {
    assertFiniteInteger(request.maxTokens, "maxTokens", 1, 1_000_000);
  }
  return Object.freeze(request);
}

function normalizeChatRequest(value: unknown): OpenCodeGoChatRequestV1 {
  const input = recordValue(value, "chat request");
  assertKeys(input, ["version", "model", "messages", "tools", "temperature", "maxTokens"], ["version", "model", "messages"], "chat request");
  if (input.version !== "opencode-go-chat-request/v1") {
    fail("OPENCODE_GO_UNSUPPORTED_VERSION", "unsupported OpenCode Go chat request version");
  }
  nonEmpty(input.model, "model");
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    fail("OPENCODE_GO_INVALID_INPUT", "chat request messages must be a non-empty array");
  }
  const messages = input.messages.map((value, index) => {
    const message = recordValue(value, `messages[${index}]`);
    assertKeys(message, ["role", "content", "tool_call_id", "name"], ["role", "content"], `messages[${index}]`);
    if (
      (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") ||
      typeof message.content !== "string"
    ) {
      fail("OPENCODE_GO_INVALID_INPUT", `messages[${index}] is invalid`);
    }
    if (message.role === "tool") {
      nonEmpty(message.tool_call_id, `messages[${index}].tool_call_id`);
      if (message.name !== undefined) nonEmpty(message.name, `messages[${index}].name`);
    } else if (message.tool_call_id !== undefined || message.name !== undefined) {
      fail("OPENCODE_GO_INVALID_INPUT", `messages[${index}] has tool-only fields`);
    }
    return Object.freeze({
      role: message.role,
      content: message.content,
      ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
      ...(message.name === undefined ? {} : { name: message.name }),
    }) as OpenCodeGoMessageV1;
  });
  let tools: readonly OpenCodeGoToolV1[] | undefined;
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) fail("OPENCODE_GO_INVALID_INPUT", "chat request tools must be an array");
    tools = Object.freeze(input.tools.map((value, index) => {
      const tool = recordValue(value, `tools[${index}]`);
      assertKeys(tool, ["type", "function"], ["type", "function"], `tools[${index}]`);
      if (tool.type !== "function") fail("OPENCODE_GO_INVALID_INPUT", `tools[${index}].type is invalid`);
      const fn = recordValue(tool.function, `tools[${index}].function`);
      assertKeys(fn, ["name", "description", "parameters"], ["name", "description", "parameters"], `tools[${index}].function`);
      nonEmpty(fn.name, `tools[${index}].function.name`);
      if (typeof fn.description !== "string") fail("OPENCODE_GO_INVALID_INPUT", `tools[${index}].function.description is invalid`);
      return Object.freeze({
        type: "function" as const,
        function: {
          name: fn.name,
          description: fn.description,
          parameters: canonicalCopy(fn.parameters, `tools[${index}].function.parameters`),
        },
      });
    }));
  }
  try {
    canonicalize(input);
  } catch {
    fail("OPENCODE_GO_INVALID_INPUT", "chat request is not a canonical value");
  }
  const temperature = input.temperature;
  if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0)) {
    fail("OPENCODE_GO_INVALID_INPUT", "temperature must be a finite non-negative number");
  }
  const maxTokens = input.maxTokens;
  if (maxTokens !== undefined) assertFiniteInteger(maxTokens, "maxTokens", 1, 1_000_000);
  return Object.freeze({
    version: input.version,
    model: input.model,
    messages: Object.freeze(messages),
    ...(tools === undefined ? {} : { tools }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
}

function requestBody(request: OpenCodeGoChatRequestV1): string {
  const body = canonicalize({
    model: request.model,
    messages: request.messages,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    stream: false,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    fail("OPENCODE_GO_REQUEST_LIMIT", "OpenCode Go request exceeds the protocol limit");
  }
  return body;
}

async function readResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > MAX_RESPONSE_BYTES) {
    fail("OPENCODE_GO_RESPONSE_LIMIT", "OpenCode Go response exceeds the protocol limit");
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      fail("OPENCODE_GO_RESPONSE_LIMIT", "OpenCode Go response exceeds the protocol limit");
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
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail("OPENCODE_GO_RESPONSE_LIMIT", "OpenCode Go response exceeds the protocol limit");
      }
      try {
        chunks.push(decoder.decode(next.value, { stream: true }));
      } catch {
        fail("OPENCODE_GO_PROTOCOL", "OpenCode Go response is not valid UTF-8");
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch {
      fail("OPENCODE_GO_PROTOCOL", "OpenCode Go response is not valid UTF-8");
    }
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function extractText(value: unknown, label: string, optional = false): string {
  if (value === undefined || value === null) {
    if (optional) return "";
    fail("OPENCODE_GO_PROTOCOL", `${label} is missing`);
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part, index) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          fail("OPENCODE_GO_PROTOCOL", `${label}[${index}] is invalid`);
        }
        const text = (part as Record<string, unknown>).text;
        if (typeof text !== "string") {
          fail("OPENCODE_GO_PROTOCOL", `${label}[${index}].text is invalid`);
        }
        return text;
      })
      .join("");
  }
  fail("OPENCODE_GO_PROTOCOL", `${label} is invalid`);
}

function parseCompletion(value: unknown): OpenCodeGoCompletionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("OPENCODE_GO_PROTOCOL", "OpenCode Go response must be an object");
  }
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.choices) || root.choices.length === 0) {
    fail("OPENCODE_GO_PROTOCOL", "OpenCode Go response has no choices");
  }
  const choice = root.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    fail("OPENCODE_GO_PROTOCOL", "OpenCode Go choice is invalid");
  }
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    fail("OPENCODE_GO_PROTOCOL", "OpenCode Go response message is invalid");
  }
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.tool_calls !== undefined) {
    if (!Array.isArray(messageRecord.tool_calls)) {
      fail("OPENCODE_GO_PROTOCOL", "OpenCode Go tool_calls is invalid");
    }
    if (messageRecord.tool_calls.length > 0) {
      fail("OPENCODE_GO_UNSUPPORTED_TOOL_CALL", "capability execution is not enabled in this profile");
    }
  }
  const text = extractText(messageRecord.content, "OpenCode Go message content");
  const reasoning = extractText(messageRecord.reasoning_content, "OpenCode Go reasoning content", true);
  const output: SemanticItem[] = [];
  if (reasoning.length > 0) output.push({ kind: "thinking", content: reasoning });
  output.push({ kind: "message", role: "assistant", content: text });
  const finishReason = (choice as Record<string, unknown>).finish_reason;
  if (typeof finishReason !== "string" || finishReason.length === 0) {
    fail("OPENCODE_GO_PROTOCOL", "OpenCode Go finish_reason is invalid");
  }
  let normalizedOutput: readonly SemanticItem[];
  try {
    normalizedOutput = normalizeAxiomaticSemanticItems(output, "OpenCode Go output");
  } catch {
    fail("OPENCODE_GO_PROTOCOL", "OpenCode Go output is not canonical semantic data");
  }
  return Object.freeze({
    version: "opencode-go-completion/v1",
    output: normalizedOutput,
    finishReason,
    ...(root.usage === undefined ? {} : { usage: canonicalCopy(root.usage, "OpenCode Go usage", "OPENCODE_GO_PROTOCOL") }),
  });
}

function errorCode(error: unknown): string {
  return error instanceof SemanticError ? error.code : "OPENCODE_GO_NETWORK";
}

export class OpenCodeGoClient {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent: string;

  constructor(options: OpenCodeGoClientOptions = {}) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#model = options.model ?? DEFAULT_MODEL;
    nonEmpty(this.#model, "model");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertFiniteInteger(this.#timeoutMs, "timeoutMs", 1, MAX_TIMEOUT_MS);
    this.#fetch = globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      fail("OPENCODE_GO_UNAVAILABLE", "global fetch is unavailable");
    }
    this.#userAgent = options.userAgent ?? "axiomatic-agent-runtime/opencode-go-v1";
    if (!/^[\x20-\x7e]{1,256}$/.test(this.#userAgent)) {
      fail("OPENCODE_GO_INVALID_INPUT", "userAgent must be 1-256 printable ASCII characters");
    }
  }

  get model(): string {
    return this.#model;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Checks credentials without retaining or returning the secret. */
  assertReady(): void {
    this.#readApiKey();
  }

  /** Compiles and bounds the request without reading credentials or dispatching. */
  prepare(
    input: OpenCodeGoModelRequestV1 | OpenCodeGoChatRequestV1,
  ): OpenCodeGoChatRequestV1 {
    const version = recordValue(input, "OpenCode Go request").version;
    const request = version === "opencode-go-model-request/v1"
      ? compileOpenCodeGoChatRequest(input as OpenCodeGoModelRequestV1, { model: this.#model })
      : normalizeChatRequest(input);
    if (request.model !== this.#model) {
      fail("OPENCODE_GO_MODEL_MISMATCH", "request model does not match the configured client model");
    }
    requestBody(request);
    return request;
  }

  #readApiKey(): string {
    const apiKey = process.env[DEFAULT_API_KEY_ENV];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      fail("OPENCODE_GO_KEY_MISSING", `environment variable ${DEFAULT_API_KEY_ENV} is required`);
    }
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      fail("OPENCODE_GO_KEY_INVALID", `environment variable ${DEFAULT_API_KEY_ENV} is not a valid bearer token`);
    }
    return apiKey;
  }

  async complete(
    input: OpenCodeGoModelRequestV1 | OpenCodeGoChatRequestV1,
    signal?: AbortSignal,
  ): Promise<OpenCodeGoCompletionV1> {
    if (signal?.aborted) {
      fail("OPENCODE_GO_ABORTED", "OpenCode Go request was aborted before dispatch");
    }
    const request = this.prepare(input);
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
      rejectCancellation?.(new SemanticError("OPENCODE_GO_TIMEOUT", "OpenCode Go request timed out"));
    }, this.#timeoutMs);
    const onAbort = (): void => {
      controller.abort("caller-aborted");
      rejectCancellation?.(new SemanticError("OPENCODE_GO_ABORTED", "OpenCode Go request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      let response: Response;
      try {
        response = await Promise.race([this.#fetch(`${this.#baseUrl}chat/completions`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "user-agent": this.#userAgent,
          },
          body: requestBody(request),
          signal: controller.signal,
        }), cancellation]);
      } catch (error) {
        if (timedOut) fail("OPENCODE_GO_TIMEOUT", "OpenCode Go request timed out");
        if (signal?.aborted) fail("OPENCODE_GO_ABORTED", "OpenCode Go request was aborted");
        fail(errorCode(error), "OpenCode Go network request failed");
      }
      if (!response.ok) {
        fail("OPENCODE_GO_HTTP", `OpenCode Go returned HTTP ${response.status}`);
      }
      let text: string;
      try {
        text = await Promise.race([readResponseText(response), cancellation]);
      } catch (error) {
        if (timedOut) fail("OPENCODE_GO_TIMEOUT", "OpenCode Go request timed out");
        if (signal?.aborted) fail("OPENCODE_GO_ABORTED", "OpenCode Go request was aborted");
        if (error instanceof SemanticError) throw error;
        fail("OPENCODE_GO_NETWORK", "OpenCode Go response body could not be read");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        fail("OPENCODE_GO_PROTOCOL", "OpenCode Go returned invalid JSON");
      }
      return parseCompletion(parsed);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      controller.abort("complete");
    }
  }
}

export const OPENCODE_GO_DEFAULTS = Object.freeze({
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});
