import test from "node:test";
import assert from "node:assert/strict";

import {
  OpenCodeGoClient,
  OPENCODE_GO_DEFAULTS,
  compileOpenCodeGoChatRequest,
  type OpenCodeGoModelRequestV1,
} from "../../src/opencode-go-client.ts";
import { SemanticError } from "../../src/errors.ts";

const modelRequest: OpenCodeGoModelRequestV1 = {
  version: "opencode-go-model-request/v1",
  root: { rootPrompt: "system", toolDefinitions: [] },
  history: [
    {
      version: "evaluation-frame/v2",
      input: [{ kind: "message", role: "user", content: "previous" }],
      output: [{ kind: "message", role: "assistant", content: "answer" }],
    },
  ],
  candidateInput: [{ kind: "message", role: "user", content: "current" }],
};

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof SemanticError && error.code === code);
}

async function withFetch<T>(fetch: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

test("OpenCode Go request compilation is provider-neutral and deterministic", () => {
  const request = compileOpenCodeGoChatRequest(modelRequest);
  assert.equal(request.version, "opencode-go-chat-request/v1");
  assert.equal(request.model, OPENCODE_GO_DEFAULTS.model);
  assert.deepEqual(request.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "previous" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "current" },
  ]);
  const withToolResult = compileOpenCodeGoChatRequest({
    ...modelRequest,
    candidateInput: [{
      kind: "tool-result",
      callId: "call-1",
      name: "lookup",
      result: { value: 1 },
      isError: false,
    }],
  });
  assert.deepEqual(withToolResult.messages.at(-1), {
    role: "tool",
    tool_call_id: "call-1",
    name: "lookup",
    content: '{"isError":false,"result":{"value":1}}',
  });
  expectCode(
    () => compileOpenCodeGoChatRequest({ ...modelRequest, maxTokens: 0 }),
    "OPENCODE_GO_INVALID_INPUT",
  );
});

test("OpenCode Go client reads the key only at dispatch and parses reasoning output", async () => {
  const previous = process.env.OPENCODE_GO;
  process.env.OPENCODE_GO = "test-secret-do-not-log";
  let called = false;
  try {
    await withFetch(async (input, init) => {
      called = true;
      assert.equal(input, "https://opencode.ai/zen/go/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret-do-not-log");
      const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean };
      assert.equal(body.model, "deepseek-v4-flash");
      assert.equal(body.stream, false);
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { reasoning_content: "reason", content: "answer" },
        }],
        usage: { total_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }, async () => {
      const client = new OpenCodeGoClient();
      const result = await client.complete(modelRequest);
      assert.equal(called, true);
      assert.deepEqual(result.output, [
        { kind: "thinking", content: "reason" },
        { kind: "message", role: "assistant", content: "answer" },
      ]);
      assert.equal(result.finishReason, "stop");
    });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GO;
    else process.env.OPENCODE_GO = previous;
  }
});

test("OpenCode Go client fails closed without a key and does not expose it in errors", async () => {
  const previous = process.env.OPENCODE_GO;
  delete process.env.OPENCODE_GO;
  try {
    const client = new OpenCodeGoClient();
    await assert.rejects(
      () => client.complete(modelRequest),
      (error: unknown) => error instanceof SemanticError &&
        error.code === "OPENCODE_GO_KEY_MISSING" &&
        !error.message.includes("test-secret"),
    );
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GO;
    else process.env.OPENCODE_GO = previous;
  }
});

test("OpenCode Go client rejects malformed provider output as a definitive protocol failure", async () => {
  const previous = process.env.OPENCODE_GO;
  process.env.OPENCODE_GO = "test-key";
  try {
    await withFetch(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: { invalid: true } } }],
    }), { status: 200 }), async () => {
      const client = new OpenCodeGoClient();
      await assert.rejects(
        () => client.complete(modelRequest),
        (error: unknown) => error instanceof SemanticError && error.code === "OPENCODE_GO_PROTOCOL",
      );
    });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GO;
    else process.env.OPENCODE_GO = previous;
  }
});

test("OpenCode Go client maps HTTP failure, timeout, and caller abort without retry", async () => {
  const previous = process.env.OPENCODE_GO;
  process.env.OPENCODE_GO = "test-key";
  try {
    await withFetch(async () => new Response("provider failure", { status: 503 }), async () => {
      const httpClient = new OpenCodeGoClient();
      await assert.rejects(() => httpClient.complete(modelRequest), (error: unknown) =>
        error instanceof SemanticError && error.code === "OPENCODE_GO_HTTP");
    });

    await withFetch(() => new Promise<Response>(() => {}), async () => {
      const timeoutClient = new OpenCodeGoClient({ timeoutMs: 10 });
      await assert.rejects(() => timeoutClient.complete(modelRequest), (error: unknown) =>
        error instanceof SemanticError && error.code === "OPENCODE_GO_TIMEOUT");

      const controller = new AbortController();
      const abortClient = new OpenCodeGoClient();
      const pending = abortClient.complete(modelRequest, controller.signal);
      controller.abort();
      await assert.rejects(pending, (error: unknown) =>
        error instanceof SemanticError && error.code === "OPENCODE_GO_ABORTED");
    });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GO;
    else process.env.OPENCODE_GO = previous;
  }
});
