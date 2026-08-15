import test from "node:test";
import assert from "node:assert/strict";

import {
  AnthropicMessagesAdapter,
  OpenAIChatCompletionsAdapter,
  OpenAIResponsesAdapter,
  MODEL_DEFAULTS,
} from "../../src/model-adapters.ts";
import { SemanticError } from "../../src/errors.ts";
import { modelRequestMatchesEndpoint } from "../../src/model-contract.ts";
import {
  MAX_MODEL_REQUEST_BYTES,
  MAX_MODEL_RESPONSE_BYTES,
  type ModelAdapter,
  type ModelInputV1,
} from "../../src/model-adapter.ts";

const INPUT: ModelInputV1 = {
  version: "axiomatic-model-input/v1",
  root: {
    rootPrompt: "system prompt",
    toolDefinitions: [],
  },
  history: [{
    version: "evaluation-frame/v2",
    input: [{ kind: "message", role: "user", content: "previous" }],
    output: [{ kind: "message", role: "assistant", content: "answer" }],
  }],
  candidateInput: [{ kind: "message", role: "user", content: "current" }],
  environment: { version: "environment-snapshot/v1", values: null },
};

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  fetch: typeof globalThis.fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previousEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ADAPTER_CASES: readonly {
  readonly env: string;
  readonly name: string;
  readonly create: () => ModelAdapter;
}[] = [
  {
    env: "OPENCODE_GO",
    name: "OpenCode Go Chat Completions",
    create: () => new OpenAIChatCompletionsAdapter({
      ...MODEL_DEFAULTS.opencodeGo,
      apiKeyEnv: "OPENCODE_GO",
      baseUrl: "https://opencode.test/v1/",
      model: "opencode-model",
    }),
  },
  {
    env: "OPENAI_API_KEY",
    name: "OpenAI Chat Completions",
    create: () => new OpenAIChatCompletionsAdapter({
      ...MODEL_DEFAULTS.openaiCompletions,
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://openai.test/v1/",
      model: "chat-model",
    }),
  },
  {
    env: "OPENAI_API_KEY",
    name: "OpenAI Responses",
    create: () => new OpenAIResponsesAdapter({
      ...MODEL_DEFAULTS.openaiResponses,
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://openai.test/v1/",
      model: "responses-model",
    }),
  },
  {
    env: "ANTHROPIC_API_KEY",
    name: "Anthropic Messages",
    create: () => new AnthropicMessagesAdapter({
      ...MODEL_DEFAULTS.anthropicMessages,
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: "https://anthropic.test/v1/",
      model: "messages-model",
    }),
  },
];

test("OpenAI Chat Completions adapter compiles and normalizes its native wire shape", async () => {
  await withEnvironment({ OPENAI_API_KEY: "openai-test-key" }, async (input, init) => {
    assert.equal(input, "https://api.openai.test/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer openai-test-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "chat-model");
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [
      { role: "system", content: "system prompt" },
      { role: "system", content: '[environment]\n{"values":null,"version":"environment-snapshot/v1"}' },
      { role: "user", content: "previous" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "current" },
    ]);
    return jsonResponse({
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
      usage: { total_tokens: 4 },
    });
  }, async () => {
    const adapter = new OpenAIChatCompletionsAdapter({
      ...MODEL_DEFAULTS.openaiCompletions,
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.test/v1/",
      model: "chat-model",
    });
    const prepared = adapter.prepare(INPUT);
    const result = await adapter.complete(prepared);
    assert.deepEqual(result.output, [{ kind: "message", role: "assistant", content: "done" }]);
    assert.equal(result.finishReason, "stop");
  });
});

test("durable request binding matches every selected endpoint identity field", () => {
  const endpoint = {
    version: "model-endpoint/v2" as const,
    provider: "openai" as const,
    adapter: "openai-responses/v1" as const,
    baseUrl: "https://api.openai.test/v1/",
    model: "responses-model",
    maxTokens: 128,
  };
  const request = {
    provider: endpoint.provider,
    adapter: endpoint.adapter,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    maxTokens: endpoint.maxTokens,
  };
  assert.equal(modelRequestMatchesEndpoint(request, endpoint), true);
  assert.equal(modelRequestMatchesEndpoint({ ...request, provider: "anthropic" }, endpoint), false);
  assert.equal(modelRequestMatchesEndpoint({ ...request, adapter: "openai-chat-completions/v1" }, endpoint), false);
  assert.equal(modelRequestMatchesEndpoint({ ...request, baseUrl: "https://other.test/v1/" }, endpoint), false);
  assert.equal(modelRequestMatchesEndpoint({ ...request, model: "other-model" }, endpoint), false);
  assert.equal(modelRequestMatchesEndpoint({ ...request, maxTokens: 129 }, endpoint), false);
  assert.equal(modelRequestMatchesEndpoint({ ...request, maxTokens: undefined }, endpoint), false);
});

test("OpenAI Responses adapter uses /responses and parses message/reasoning output", async () => {
  await withEnvironment({ OPENAI_API_KEY: "responses-test-key" }, async (input, init) => {
    assert.equal(input, "https://api.openai.test/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer responses-test-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "responses-model");
    assert.equal(body.instructions, "system prompt");
    assert.equal(body.stream, false);
    assert.equal(body.store, false);
    const inputItems = body.input as readonly Record<string, unknown>[];
    assert.equal(inputItems[0]?.type, "message");
    assert.equal(inputItems[0]?.role, "user");
    return jsonResponse({
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  }, async () => {
    const adapter = new OpenAIResponsesAdapter({
      ...MODEL_DEFAULTS.openaiResponses,
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.test/v1/",
      model: "responses-model",
    });
    const result = await adapter.complete(adapter.prepare(INPUT));
    assert.deepEqual(result.output, [
      { kind: "thinking", content: "reason" },
      { kind: "message", role: "assistant", content: "answer" },
    ]);
  });
});

test("OpenAI Responses requires an explicit final status", async () => {
  let calls = 0;
  await withEnvironment({ OPENAI_API_KEY: "responses-test-key" }, async () => {
    calls += 1;
    return jsonResponse({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }],
    });
  }, async () => {
    const adapter = new OpenAIResponsesAdapter({
      ...MODEL_DEFAULTS.openaiResponses,
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.test/v1/",
    });
    await assert.rejects(
      () => adapter.complete(adapter.prepare(INPUT)),
      (error: unknown) => error instanceof SemanticError && error.code === "MODEL_PROTOCOL",
    );
  });
  assert.equal(calls, 1);
});

test("Anthropic Messages adapter uses native headers and content blocks", async () => {
  await withEnvironment({ ANTHROPIC_API_KEY: "anthropic-test-key" }, async (input, init) => {
    assert.equal(input, "https://anthropic.test/v1/messages");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "anthropic-test-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "claude-test");
    assert.equal(body.system, "system prompt");
    assert.equal(body.max_tokens, 128);
    const messages = body.messages as readonly Record<string, unknown>[];
    assert.equal(messages[0]?.role, "user");
    return jsonResponse({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "anthropic answer" },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  }, async () => {
    const adapter = new AnthropicMessagesAdapter({
      ...MODEL_DEFAULTS.anthropicMessages,
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: "https://anthropic.test/v1/",
      model: "claude-test",
      maxTokens: 128,
    });
    const result = await adapter.complete(adapter.prepare(INPUT));
    assert.deepEqual(result.output, [
      { kind: "thinking", content: "internal" },
      { kind: "message", role: "assistant", content: "anthropic answer" },
    ]);
    assert.equal(result.finishReason, "end_turn");
  });
});

test("native adapters preserve tool-call continuity and tool-result error semantics", () => {
  const toolInput: ModelInputV1 = {
    version: "axiomatic-model-input/v1",
    root: {
      rootPrompt: "tool system",
      toolDefinitions: [{
        name: "lookup",
        description: "Look up a value.",
        inputSchema: { type: "object" },
      }],
    },
    history: [{
      version: "evaluation-frame/v2",
      input: [{ kind: "message", role: "user", content: "look it up" }],
      output: [{ kind: "tool-call", callId: "call-1", name: "lookup", arguments: { key: "x" } }],
    }],
    candidateInput: [{
      kind: "tool-result",
      callId: "call-1",
      name: "lookup",
      result: { value: 1 },
      isError: true,
    }],
    environment: { version: "environment-snapshot/v1", values: { region: "test" } },
  };

  const chat = ADAPTER_CASES[1]!.create().prepare(toolInput);
  const chatBody = JSON.parse(chat.body) as { readonly messages: readonly Record<string, unknown>[] };
  assert.deepEqual(chatBody.messages.slice(-2), [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"key":"x"}' } }],
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      name: "lookup",
      content: '{"isError":true,"result":{"value":1}}',
    },
  ]);

  const responses = ADAPTER_CASES[2]!.create().prepare(toolInput);
  const responsesBody = JSON.parse(responses.body) as { readonly input: readonly Record<string, unknown>[] };
  assert.deepEqual(responsesBody.input.slice(-2), [
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"key":"x"}' },
    { type: "function_call_output", call_id: "call-1", output: '{"isError":true,"result":{"value":1}}' },
  ]);

  const anthropic = ADAPTER_CASES[3]!.create().prepare(toolInput);
  const anthropicBody = JSON.parse(anthropic.body) as { readonly messages: readonly { readonly role: string; readonly content: readonly Record<string, unknown>[] }[] };
  assert.deepEqual(anthropicBody.messages.slice(-2), [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { key: "x" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: '{"value":1}', is_error: true }],
    },
  ]);
});

test("all model adapters fail closed without credentials and never expose credential metadata", async () => {
  for (const item of ADAPTER_CASES) {
    let calls = 0;
    const secret = `${item.name}-secret`;
    await withEnvironment({ [item.env]: undefined }, async () => {
      calls += 1;
      return jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "unexpected" } }] });
    }, async () => {
      const adapter = item.create();
      assert.throws(() => adapter.assertReady(), (error: unknown) => {
        assert.ok(error instanceof SemanticError);
        assert.equal(error.code, "MODEL_KEY_MISSING");
        assert.equal(error.message.includes(item.env), false);
        assert.equal(error.message.includes(secret), false);
        return true;
      });
      await assert.rejects(
        () => adapter.complete(adapter.prepare(INPUT)),
        (error: unknown) => error instanceof SemanticError &&
          error.code === "MODEL_KEY_MISSING" &&
          !error.message.includes(item.env),
      );
    });
    assert.equal(calls, 0, item.name);
  }
});

test("all model adapters reject invalid credentials without exposing the environment name", async () => {
  for (const item of ADAPTER_CASES) {
    await withEnvironment({ [item.env]: "invalid\ncredential" }, async () => {
      throw new Error("fetch must not be called");
    }, async () => {
      const adapter = item.create();
      await assert.rejects(
        () => adapter.complete(adapter.prepare(INPUT)),
        (error: unknown) => error instanceof SemanticError &&
          error.code === "MODEL_KEY_INVALID" &&
          !error.message.includes(item.env) &&
          !error.message.includes("invalid\ncredential"),
      );
    });
  }
});

test("all model adapters classify definitive HTTP, protocol, and response-limit failures without retry", async () => {
  const failures: readonly {
    readonly name: string;
    readonly expected: string;
    readonly response: () => Response;
  }[] = [
    {
      name: "HTTP",
      expected: "MODEL_HTTP",
      response: () => new Response("provider failure", { status: 503 }),
    },
    {
      name: "protocol",
      expected: "MODEL_PROTOCOL",
      response: () => new Response("not-json", { status: 200 }),
    },
    {
      name: "response limit",
      expected: "MODEL_RESPONSE_LIMIT",
      response: () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_MODEL_RESPONSE_BYTES + 1) },
      }),
    },
  ];
  for (const item of ADAPTER_CASES) {
    for (const failure of failures) {
      let calls = 0;
      await withEnvironment({ [item.env]: "dispatch-secret" }, async () => {
        calls += 1;
        return failure.response();
      }, async () => {
        const adapter = item.create();
        await assert.rejects(
          () => adapter.complete(adapter.prepare(INPUT)),
          (error: unknown) => error instanceof SemanticError &&
            error.code === failure.expected &&
            !error.message.includes("dispatch-secret") &&
            !error.message.includes(item.env),
          `${item.name} ${failure.name}`,
        );
      });
      assert.equal(calls, 1, `${item.name} ${failure.name}`);
    }
  }
});

test("all model adapters reject provider tool calls instead of executing capabilities", async () => {
  const responses: readonly {
    readonly item: typeof ADAPTER_CASES[number];
    readonly response: () => Response;
  }[] = ADAPTER_CASES.map((item) => ({
    item,
    response: () => {
      if (item.name.includes("Chat")) {
        return jsonResponse({
          choices: [{ finish_reason: "tool_calls", message: {
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
          } }],
        });
      }
      if (item.name.includes("Responses")) {
        return jsonResponse({ status: "completed", output: [{ type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" }] });
      }
      return jsonResponse({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: {} }] });
    },
  }));
  for (const { item, response } of responses) {
    let calls = 0;
    await withEnvironment({ [item.env]: "tool-secret" }, async () => {
      calls += 1;
      return response();
    }, async () => {
      const adapter = item.create();
      await assert.rejects(
        () => adapter.complete(adapter.prepare(INPUT)),
        (error: unknown) => error instanceof SemanticError && error.code === "MODEL_UNSUPPORTED_TOOL_CALL",
      );
    });
    assert.equal(calls, 1, item.name);
  }
});

test("model adapters reject oversized canonical requests before dispatch", async () => {
  const adapter = new OpenAIChatCompletionsAdapter({
    ...MODEL_DEFAULTS.openaiCompletions,
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.test/v1/",
    model: "large-request-model",
  });
  const oversized: ModelInputV1 = {
    ...INPUT,
    candidateInput: [{ kind: "message", role: "user", content: "x".repeat(MAX_MODEL_REQUEST_BYTES) }],
  };
  assert.throws(() => adapter.prepare(oversized), (error: unknown) =>
    error instanceof SemanticError && error.code === "MODEL_REQUEST_LIMIT");
});

test("model adapter maps timeout and caller abort without a second dispatch", async () => {
  let calls = 0;
  await withEnvironment({ OPENAI_API_KEY: "abort-key" }, async () => {
    calls += 1;
    return await new Promise<Response>(() => {});
  }, async () => {
    const adapter = new OpenAIResponsesAdapter({
      ...MODEL_DEFAULTS.openaiResponses,
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.test/v1/",
      timeoutMs: 10,
    });
    await assert.rejects(
      () => adapter.complete(adapter.prepare(INPUT)),
      (error: unknown) => error instanceof SemanticError && error.code === "MODEL_TIMEOUT",
    );

    const controller = new AbortController();
    const pending = adapter.complete(adapter.prepare(INPUT), controller.signal);
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof SemanticError && error.code === "MODEL_ABORTED",
    );
  });
  assert.equal(calls, 2);
});
