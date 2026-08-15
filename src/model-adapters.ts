import {
  JsonModelAdapter,
  anthropicMessages,
  anthropicTools,
  adapterFail,
  objectValue,
  openAIChatMessages,
  openAIResponsesInput,
  openAITools,
  optionalCanonical,
  normalizedCompletion,
  stringValue,
  textParts,
  unsupportedToolCall,
  type AdapterConstructorOptions,
  type ModelInputV1,
} from "./model-adapter.ts";
import type { ModelAdapterId, ModelProviderId } from "./model-contract.ts";
import type { CanonicalValue } from "./types.ts";

const INTERNAL_DEFAULTS = Object.freeze({
  opencodeGo: Object.freeze({
    provider: "opencode-go" as const,
    adapter: "openai-chat-completions/v1" as const,
    baseUrl: "https://opencode.ai/zen/go/v1/",
    model: "deepseek-v4-flash",
    apiKeyEnv: "OPENCODE_GO",
  }),
  openaiCompletions: Object.freeze({
    provider: "openai" as const,
    adapter: "openai-chat-completions/v1" as const,
    baseUrl: "https://api.openai.com/v1/",
    model: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  }),
  openaiResponses: Object.freeze({
    provider: "openai" as const,
    adapter: "openai-responses/v1" as const,
    baseUrl: "https://api.openai.com/v1/",
    model: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  }),
  anthropicMessages: Object.freeze({
    provider: "anthropic" as const,
    adapter: "anthropic-messages/v1" as const,
    baseUrl: "https://api.anthropic.com/v1/",
    model: "claude-3-5-haiku-latest",
    maxTokens: 4096,
    apiKeyEnv: "ANTHROPIC_API_KEY",
  }),
});

export const MODEL_DEFAULTS = Object.freeze({
  opencodeGo: Object.freeze({
    provider: INTERNAL_DEFAULTS.opencodeGo.provider,
    adapter: INTERNAL_DEFAULTS.opencodeGo.adapter,
    baseUrl: INTERNAL_DEFAULTS.opencodeGo.baseUrl,
    model: INTERNAL_DEFAULTS.opencodeGo.model,
  }),
  openaiCompletions: Object.freeze({
    provider: INTERNAL_DEFAULTS.openaiCompletions.provider,
    adapter: INTERNAL_DEFAULTS.openaiCompletions.adapter,
    baseUrl: INTERNAL_DEFAULTS.openaiCompletions.baseUrl,
    model: INTERNAL_DEFAULTS.openaiCompletions.model,
  }),
  openaiResponses: Object.freeze({
    provider: INTERNAL_DEFAULTS.openaiResponses.provider,
    adapter: INTERNAL_DEFAULTS.openaiResponses.adapter,
    baseUrl: INTERNAL_DEFAULTS.openaiResponses.baseUrl,
    model: INTERNAL_DEFAULTS.openaiResponses.model,
  }),
  anthropicMessages: Object.freeze({
    provider: INTERNAL_DEFAULTS.anthropicMessages.provider,
    adapter: INTERNAL_DEFAULTS.anthropicMessages.adapter,
    baseUrl: INTERNAL_DEFAULTS.anthropicMessages.baseUrl,
    model: INTERNAL_DEFAULTS.anthropicMessages.model,
    maxTokens: INTERNAL_DEFAULTS.anthropicMessages.maxTokens,
  }),
});

function parseUsage(value: unknown): CanonicalValue | undefined {
  return optionalCanonical(value, "usage");
}

function outputMessage(content: string): { readonly kind: "message"; readonly role: "assistant"; readonly content: string } {
  return { kind: "message", role: "assistant", content };
}

function outputThinking(content: string): { readonly kind: "thinking"; readonly content: string } {
  return { kind: "thinking", content };
}

function parseOpenAIChatCompletion(value: unknown) {
  const root = objectValue(value, "OpenAI completion");
  if (!Array.isArray(root.choices) || root.choices.length === 0) {
    adapterFail("MODEL_PROTOCOL", "OpenAI completion has no choices");
  }
  const choice = objectValue(root.choices[0], "OpenAI completion choice");
  const message = objectValue(choice.message, "OpenAI completion message");
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) adapterFail("MODEL_PROTOCOL", "OpenAI tool_calls is invalid");
    if (message.tool_calls.length > 0) unsupportedToolCall();
  }
  const output: ({ readonly kind: "message"; readonly role: "assistant"; readonly content: string } | { readonly kind: "thinking"; readonly content: string })[] = [];
  if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
    const reasoning = textParts(message.reasoning_content, "OpenAI reasoning_content");
    if (reasoning.length > 0) output.push(outputThinking(reasoning));
  }
  const content = textParts(message.content, "OpenAI message content");
  output.push(outputMessage(content));
  const finishReason = stringValue(choice.finish_reason, "OpenAI finish_reason");
  return normalizedCompletion(output, finishReason, parseUsage(root.usage));
}

export class OpenAIChatCompletionsAdapter extends JsonModelAdapter {
  constructor(options: AdapterConstructorOptions) {
    super(options);
  }

  protected compileBody(input: ModelInputV1): CanonicalValue {
    return {
      model: this.model,
      messages: openAIChatMessages(input),
      ...(input.root.toolDefinitions.length === 0 ? {} : { tools: openAITools(input.root) }),
      ...(this.maxTokens === undefined ? {} : { max_tokens: this.maxTokens }),
      stream: false,
    } as unknown as CanonicalValue;
  }

  protected urlPath(): string {
    return `${this.baseUrl}chat/completions`;
  }

  protected requestHeaders(apiKey: string): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "user-agent": this.userAgent,
    };
  }

  protected parseCompletion(value: unknown) {
    return parseOpenAIChatCompletion(value);
  }

}

export class OpenAIResponsesAdapter extends JsonModelAdapter {
  constructor(options: AdapterConstructorOptions) {
    super(options);
  }

  protected compileBody(input: ModelInputV1): CanonicalValue {
    return {
      model: this.model,
      instructions: input.root.rootPrompt,
      input: openAIResponsesInput(input),
      ...(input.root.toolDefinitions.length === 0 ? {} : {
        tools: input.root.toolDefinitions.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      }),
      ...(this.maxTokens === undefined ? {} : { max_output_tokens: this.maxTokens }),
      stream: false,
      store: false,
    } as unknown as CanonicalValue;
  }

  protected urlPath(): string {
    return `${this.baseUrl}responses`;
  }

  protected requestHeaders(apiKey: string): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "user-agent": this.userAgent,
    };
  }

  protected parseCompletion(value: unknown) {
    const root = objectValue(value, "OpenAI Responses response");
    if (!Array.isArray(root.output)) adapterFail("MODEL_PROTOCOL", "OpenAI Responses output is invalid");
    const output: ({ readonly kind: "message"; readonly role: "assistant"; readonly content: string } | { readonly kind: "thinking"; readonly content: string })[] = [];
    for (const [index, raw] of root.output.entries()) {
      const item = objectValue(raw, `OpenAI Responses output[${index}]`);
      if (item.type === "function_call") unsupportedToolCall();
      if (item.type === "reasoning") {
        if (Array.isArray(item.summary)) {
          for (const [summaryIndex, summary] of item.summary.entries()) {
            const record = objectValue(summary, `OpenAI reasoning summary[${summaryIndex}]`);
            const text = stringValue(record.text, `OpenAI reasoning summary[${summaryIndex}].text`);
            if (text.length > 0) output.push(outputThinking(text));
          }
        }
        continue;
      }
      if (item.type !== "message") adapterFail("MODEL_PROTOCOL", "unsupported OpenAI Responses output item");
      if (item.role !== "assistant") adapterFail("MODEL_PROTOCOL", "OpenAI Responses message role is invalid");
      if (!Array.isArray(item.content)) {
        adapterFail("MODEL_PROTOCOL", "OpenAI Responses message content is invalid");
      }
      const text = item.content.map((part, partIndex) => {
        const record = objectValue(part, `OpenAI Responses content[${partIndex}]`);
        if (record.type !== "output_text") adapterFail("MODEL_PROTOCOL", "OpenAI Responses content part is invalid");
        return stringValue(record.text, `OpenAI Responses content[${partIndex}].text`);
      }).join("");
      output.push(outputMessage(text));
    }
    const status = root.status;
    if (status !== "completed" && status !== "incomplete") {
      adapterFail("MODEL_PROTOCOL", "OpenAI Responses status is not a final completion");
    }
    let finishReason = status;
    if (status === "incomplete") {
      const incomplete = objectValue(root.incomplete_details, "OpenAI incomplete_details");
      if (typeof incomplete.reason === "string" && incomplete.reason.length > 0) finishReason = incomplete.reason;
    }
    return normalizedCompletion(output, finishReason, parseUsage(root.usage));
  }

}

export class AnthropicMessagesAdapter extends JsonModelAdapter {
  constructor(options: AdapterConstructorOptions) {
    super(options);
  }

  protected compileBody(input: ModelInputV1): CanonicalValue {
    return {
      model: this.model,
      system: input.root.rootPrompt,
      max_tokens: this.maxTokens ?? 4096,
      messages: anthropicMessages(input),
      ...(input.root.toolDefinitions.length === 0 ? {} : { tools: anthropicTools(input.root) }),
      stream: false,
    } as unknown as CanonicalValue;
  }

  protected urlPath(): string {
    return `${this.baseUrl}messages`;
  }

  protected requestHeaders(apiKey: string): Record<string, string> {
    return {
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": this.userAgent,
      "x-api-key": apiKey,
    };
  }

  protected parseCompletion(value: unknown) {
    const root = objectValue(value, "Anthropic response");
    if (!Array.isArray(root.content)) adapterFail("MODEL_PROTOCOL", "Anthropic content is invalid");
    const output: ({ readonly kind: "message"; readonly role: "assistant"; readonly content: string } | { readonly kind: "thinking"; readonly content: string })[] = [];
    for (const [index, raw] of root.content.entries()) {
      const block = objectValue(raw, `Anthropic content[${index}]`);
      if (block.type === "tool_use") unsupportedToolCall();
      if (block.type === "thinking") {
        const text = stringValue(block.thinking, `Anthropic content[${index}].thinking`);
        if (text.length > 0) output.push(outputThinking(text));
        continue;
      }
      if (block.type !== "text") adapterFail("MODEL_PROTOCOL", "unsupported Anthropic content block");
      output.push(outputMessage(stringValue(block.text, `Anthropic content[${index}].text`)));
    }
    const finishReason = stringValue(root.stop_reason, "Anthropic stop_reason");
    return normalizedCompletion(output, finishReason, parseUsage(root.usage));
  }

}

export function createBuiltInModelAdapter(options: BuiltInAdapterOptions = {}): JsonModelAdapter {
  const provider = options.provider ?? "opencode-go";
  const adapter = options.adapter ?? defaultAdapter(provider);
  const defaults = defaultsFor(provider, adapter);
  const baseUrl = options.baseUrl ?? defaults.baseUrl;
  const model = options.model ?? defaults.model;
  const common: AdapterConstructorOptions = {
    provider,
    adapter,
    baseUrl,
    model,
    apiKeyEnv: defaults.apiKeyEnv,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxTokens === undefined && defaults.maxTokens === undefined
      ? {}
      : { maxTokens: options.maxTokens ?? defaults.maxTokens }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  };
  if (adapter === "openai-chat-completions/v1") return new OpenAIChatCompletionsAdapter(common);
  if (adapter === "openai-responses/v1") return new OpenAIResponsesAdapter(common);
  return new AnthropicMessagesAdapter(common);
}

interface CommonAdapterOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly userAgent?: string;
}

export type BuiltInAdapterOptions = CommonAdapterOptions & (
  | {
      readonly provider?: "opencode-go";
      readonly adapter?: "openai-chat-completions/v1";
    }
  | {
      readonly provider: "openai";
      readonly adapter?: "openai-chat-completions/v1" | "openai-responses/v1";
    }
  | {
      readonly provider: "anthropic";
      readonly adapter?: "anthropic-messages/v1";
    }
);

function defaultAdapter(provider: ModelProviderId): ModelAdapterId {
  switch (provider) {
    case "opencode-go": return "openai-chat-completions/v1";
    case "openai": return "openai-chat-completions/v1";
    case "anthropic": return "anthropic-messages/v1";
  }
}

function defaultsFor(provider: ModelProviderId, adapter: ModelAdapterId): {
  readonly baseUrl: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly apiKeyEnv: string;
} {
  if (provider === "opencode-go" && adapter === "openai-chat-completions/v1") return INTERNAL_DEFAULTS.opencodeGo;
  if (provider === "openai" && adapter === "openai-chat-completions/v1") return INTERNAL_DEFAULTS.openaiCompletions;
  if (provider === "openai" && adapter === "openai-responses/v1") return INTERNAL_DEFAULTS.openaiResponses;
  if (provider === "anthropic" && adapter === "anthropic-messages/v1") return INTERNAL_DEFAULTS.anthropicMessages;
  adapterFail("MODEL_UNSUPPORTED_ADAPTER", `unsupported provider/adapter combination: ${provider}/${adapter}`);
}
