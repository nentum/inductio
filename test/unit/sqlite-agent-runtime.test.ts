import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SqliteAgentRuntime,
  type SqliteAgentRuntimeOptions,
} from "../../src/sqlite-agent-runtime.ts";
import { SemanticError } from "../../src/errors.ts";

const ROOT = { rootPrompt: "durable facade", toolDefinitions: [] } as const;

async function withPath<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-agent-runtime-"));
  try {
    return await fn(join(directory, "runtime.db"));
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

async function withProvider<T>(
  envName: string,
  fetch: typeof globalThis.fetch,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previousKey = process.env[envName];
  const previousFetch = globalThis.fetch;
  process.env[envName] = "test-provider-key";
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env[envName];
    else process.env[envName] = previousKey;
  }
}

function input(runtime: SqliteAgentRuntime, position: number, signal?: AbortSignal) {
  return {
    parent: runtime.root().root,
    source: "sqlite-facade-test",
    position,
    input: [{ kind: "message" as const, role: "user" as const, content: `hello-${position}` }],
    ...(signal === undefined ? {} : { signal }),
  };
}

function completionResponse(content = "world"): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function responsesResponse(content = "world"): Response {
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function anthropicResponse(content = "world"): Response {
  return new Response(JSON.stringify({
    stop_reason: "end_turn",
    content: [{ type: "text", text: content }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const RUNTIME_ADAPTER_CASES: readonly {
  readonly env: string;
  readonly provider: "opencode-go" | "openai" | "anthropic";
  readonly adapter: "openai-chat-completions/v1" | "openai-responses/v1" | "anthropic-messages/v1";
  readonly options: SqliteAgentRuntimeOptions;
  readonly expectedPath: string;
}[] = [
  {
    env: "OPENCODE_GO",
    provider: "opencode-go",
    adapter: "openai-chat-completions/v1",
    options: {
      provider: "opencode-go",
      adapter: "openai-chat-completions/v1",
      baseUrl: "https://opencode.test/v1/",
      model: "opencode-test",
    },
    expectedPath: "https://opencode.test/v1/chat/completions",
  },
  {
    env: "OPENAI_API_KEY",
    provider: "openai",
    adapter: "openai-chat-completions/v1",
    options: {
      provider: "openai",
      adapter: "openai-chat-completions/v1",
      baseUrl: "https://api.openai.test/v1/",
      model: "chat-test",
    },
    expectedPath: "https://api.openai.test/v1/chat/completions",
  },
  {
    env: "OPENAI_API_KEY",
    provider: "openai",
    adapter: "openai-responses/v1",
    options: {
      provider: "openai",
      adapter: "openai-responses/v1",
      baseUrl: "https://api.openai.test/v1/",
      model: "responses-test",
    },
    expectedPath: "https://api.openai.test/v1/responses",
  },
  {
    env: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    adapter: "anthropic-messages/v1",
    options: {
      provider: "anthropic",
      adapter: "anthropic-messages/v1",
      baseUrl: "https://anthropic.test/v1/",
      model: "messages-test",
    },
    expectedPath: "https://anthropic.test/v1/messages",
  },
];

test("SqliteAgentRuntime persists completed OpenCode Go output and adopted head", async () => {
  await withProvider("OPENCODE_GO", async () => completionResponse(), async () => {
    await withPath(async (path) => {
      const runtime = SqliteAgentRuntime.open(path, ROOT);
      const result = await runtime.run(input(runtime, 1));
      assert.equal(result.status, "completed");
      assert.notEqual(result.head, result.parent);
      const secretBytes = Buffer.from("test-provider-key", "utf8");
      for (const suffix of ["", "-wal", "-shm"]) {
        const media = `${path}${suffix}`;
        if (existsSync(media)) assert.equal(readFileSync(media).includes(secretBytes), false);
      }
      assert.equal(runtime.evaluation(result.evaluation).status, "completed");
      const stateRef = runtime.stateRef();
      runtime.close();

      const reopened = SqliteAgentRuntime.open(path);
      assert.equal(reopened.stateRef(), stateRef);
      assert.deepEqual(reopened.path(result.head), [reopened.root().root, result.head]);
      reopened.close();
    });
  });
});

test("OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages persist native adapter identity", async () => {
  const cases = [
    {
      env: "OPENAI_API_KEY",
      provider: "openai" as const,
      adapter: "openai-chat-completions/v1" as const,
      baseUrl: "https://api.openai.test/v1/",
      model: "chat-test",
      response: completionResponse("chat-output"),
      expectedPath: "https://api.openai.test/v1/chat/completions",
    },
    {
      env: "OPENAI_API_KEY",
      provider: "openai" as const,
      adapter: "openai-responses/v1" as const,
      baseUrl: "https://api.openai.test/v1/",
      model: "responses-test",
      response: responsesResponse("responses-output"),
      expectedPath: "https://api.openai.test/v1/responses",
    },
    {
      env: "ANTHROPIC_API_KEY",
      provider: "anthropic" as const,
      adapter: "anthropic-messages/v1" as const,
      baseUrl: "https://anthropic.test/v1/",
      model: "messages-test",
      response: anthropicResponse("messages-output"),
      expectedPath: "https://anthropic.test/v1/messages",
    },
  ] as const;
  for (const item of cases) {
    await withProvider(item.env, async (input, init) => {
      assert.equal(input, item.expectedPath);
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get(item.env === "ANTHROPIC_API_KEY" ? "x-api-key" : "authorization"),
        item.env === "ANTHROPIC_API_KEY" ? "test-provider-key" : "Bearer test-provider-key",
      );
      return item.response;
    }, async () => {
      await withPath(async (path) => {
        let runtime: SqliteAgentRuntime | undefined;
        let reopened: SqliteAgentRuntime | undefined;
        try {
          runtime = SqliteAgentRuntime.open(path, ROOT, {
            provider: item.provider,
            adapter: item.adapter,
            baseUrl: item.baseUrl,
            model: item.model,
          } as Parameters<typeof SqliteAgentRuntime.open>[2]);
          const result = await runtime.run(input(runtime, 1));
          assert.equal(result.status, "completed", `${item.adapter}:${result.errorCode ?? "none"}`);
          assert.equal(result.request.version, "axiomatic-model-request/v2", item.adapter);
          assert.equal(result.request.provider, item.provider, item.adapter);
          assert.equal(result.request.adapter, item.adapter, item.adapter);
          assert.equal(JSON.stringify({ result, state: runtime.state() }).includes("test-provider-key"), false);
          const secretBytes = Buffer.from("test-provider-key", "utf8");
          for (const suffix of ["", "-wal", "-shm"]) {
            const media = `${path}${suffix}`;
            if (existsSync(media)) assert.equal(readFileSync(media).includes(secretBytes), false, `${item.adapter}:${suffix}`);
          }
          const stateRef = runtime.stateRef();
          runtime.close();
          runtime = undefined;
          reopened = SqliteAgentRuntime.open(path, ROOT);
          assert.equal(reopened.stateRef(), stateRef);
          assert.equal(reopened.evaluation(result.evaluation).status, "completed");
        } finally {
          reopened?.close();
          runtime?.close();
        }
      });
    });
  }
});

test("reopen recovers the persisted native endpoint and max-token identity", async () => {
  let calls = 0;
  await withProvider("ANTHROPIC_API_KEY", async (request, init) => {
    calls += 1;
    assert.equal(request, "https://persisted.anthropic.test/v1/messages");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "persisted-model");
    assert.equal(body.max_tokens, 123);
    return anthropicResponse(`persisted-${calls}`);
  }, async () => {
    await withPath(async (path) => {
      let runtime = SqliteAgentRuntime.open(path, ROOT, {
        provider: "anthropic",
        adapter: "anthropic-messages/v1",
        baseUrl: "https://persisted.anthropic.test/v1/",
        model: "persisted-model",
        maxTokens: 123,
      });
      const first = await runtime.run(input(runtime, 1));
      assert.equal(first.status, "completed");
      runtime.close();

      runtime = SqliteAgentRuntime.open(path);
      const second = await runtime.run({
        parent: first.head,
        source: "persisted-endpoint-reopen",
        position: 2,
        input: [{ kind: "message", role: "user", content: "second" }],
      });
      assert.equal(second.status, "completed");
      assert.equal(second.request.version, "axiomatic-model-request/v2");
      assert.equal(second.request.provider, "anthropic");
      assert.equal(second.request.adapter, "anthropic-messages/v1");
      assert.equal(second.request.maxTokens, 123);
      runtime.close();
    });
  });
  assert.equal(calls, 2);
});

test("all durable model profiles sanitize missing-credential preflight before Attempt", async () => {
  for (const item of RUNTIME_ADAPTER_CASES) {
    const previousKey = process.env[item.env];
    const previousFetch = globalThis.fetch;
    let calls = 0;
    delete process.env[item.env];
    globalThis.fetch = async () => {
      calls += 1;
      return completionResponse("unexpected");
    };
    try {
      await withPath(async (path) => {
        const runtime = SqliteAgentRuntime.open(path, ROOT, item.options);
        await assert.rejects(
          () => runtime.run(input(runtime, 1)),
          (error: unknown) => error instanceof SemanticError &&
            error.code === "MODEL_KEY_MISSING" &&
            !error.message.includes(item.env),
        );
        assert.equal(runtime.state().ledger.evaluations.length, 0, item.adapter);
        assert.equal(JSON.stringify(runtime.state()).includes(item.env), false, item.adapter);
        runtime.close();
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env[item.env];
      else process.env[item.env] = previousKey;
    }
    assert.equal(calls, 0, item.adapter);
  }
});

test("all durable model profiles classify HTTP as failed and uncertain network as unknown", async () => {
  for (const [index, item] of RUNTIME_ADAPTER_CASES.entries()) {
    let calls = 0;
    let phase: "network" | "http" = "network";
    await withProvider(item.env, async (request) => {
      calls += 1;
      assert.equal(request, item.expectedPath, item.adapter);
      if (phase === "network") throw new Error("uncertain transport");
      return new Response("provider failure", { status: 503 });
    }, async () => {
      await withPath(async (path) => {
        let runtime = SqliteAgentRuntime.open(path, ROOT, item.options);
        const unknown = await runtime.run({
          ...input(runtime, index * 10 + 1),
          source: `durable-${item.adapter}-network`,
        });
        assert.equal(unknown.status, "unknown", item.adapter);
        assert.equal(unknown.errorCode, "MODEL_NETWORK", item.adapter);
        assert.equal(runtime.evaluation(unknown.evaluation).status, "unknown", item.adapter);
        runtime.close();

        phase = "http";
        runtime = SqliteAgentRuntime.open(path);
        const failed = await runtime.run({
          ...input(runtime, index * 10 + 2),
          source: `durable-${item.adapter}-http`,
        });
        assert.equal(failed.status, "failed", item.adapter);
        assert.equal(failed.errorCode, "MODEL_HTTP", item.adapter);
        assert.equal(runtime.evaluation(failed.evaluation).status, "failed", item.adapter);
        assert.equal(failed.request.version, "axiomatic-model-request/v2", item.adapter);
        assert.equal(failed.request.provider, item.provider, item.adapter);
        assert.equal(failed.request.adapter, item.adapter, item.adapter);
        const durableText = JSON.stringify(runtime.state());
        assert.equal(durableText.includes("test-provider-key"), false, item.adapter);
        assert.equal(durableText.includes(item.env), false, item.adapter);
        for (const suffix of ["", "-wal", "-shm"]) {
          const media = `${path}${suffix}`;
          if (!existsSync(media)) continue;
          const bytes = readFileSync(media);
          assert.equal(bytes.includes(Buffer.from("test-provider-key")), false, `${item.adapter}:${suffix}`);
          assert.equal(bytes.includes(Buffer.from(item.env)), false, `${item.adapter}:${suffix}:env`);
        }
        runtime.close();
      });
    });
    assert.equal(calls, 2, item.adapter);
  }
});

test("invalid provider configuration fails before creating the SQLite file", async () => {
  await withPath((path) => {
    assert.equal(existsSync(path), false);
    assert.throws(
      () => SqliteAgentRuntime.open(path, ROOT, { baseUrl: "http://insecure.invalid/" }),
      (error: unknown) => error instanceof SemanticError && error.code === "MODEL_INSECURE_ENDPOINT",
    );
    assert.equal(existsSync(path), false);
  });
});

test("unsupported provider/adapter pairs fail before creating the SQLite file", async () => {
  await withPath((path) => {
    assert.throws(
      () => SqliteAgentRuntime.open(path, ROOT, {
        provider: "anthropic",
        adapter: "openai-chat-completions/v1",
      } as never),
      (error: unknown) => error instanceof SemanticError && error.code === "MODEL_UNSUPPORTED_ADAPTER",
    );
    assert.equal(existsSync(path), false);
  });
});

test("preflight failure does not create a durable attempt", async () => {
  await withPath(async (path) => {
    const previousKey = process.env.OPENCODE_GO;
    delete process.env.OPENCODE_GO;
    let called = false;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return completionResponse();
    };
    try {
      const runtime = SqliteAgentRuntime.open(path, ROOT);
      await assert.rejects(
        () => runtime.run(input(runtime, 1)),
        (error: unknown) => error instanceof SemanticError && error.code === "MODEL_KEY_MISSING",
      );
      assert.equal(runtime.state().ledger.evaluations.length, 0);
      assert.equal(called, false);
      runtime.close();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.OPENCODE_GO;
      else process.env.OPENCODE_GO = previousKey;
    }
  });
});

test("network failure becomes unknown while definitive HTTP failure becomes failed", async () => {
  await withPath(async (path) => {
    await withProvider("OPENCODE_GO", async () => { throw new Error("network"); }, async () => {
      const runtime = SqliteAgentRuntime.open(path, ROOT);
      const unknown = await runtime.run(input(runtime, 1));
      assert.equal(unknown.status, "unknown");
      assert.equal(runtime.evaluation(unknown.evaluation).status, "unknown");
      runtime.close();
    });

    await withProvider("OPENCODE_GO", async () => new Response("provider failure", { status: 503 }), async () => {
      const runtime = SqliteAgentRuntime.open(path);
      const failed = await runtime.run({
        ...input(runtime, 2),
        source: "sqlite-facade-http",
      });
      assert.equal(failed.status, "failed");
      assert.equal(runtime.evaluation(failed.evaluation).status, "failed");
      runtime.close();
    });
  });
});

test("crashClose aborts in-flight transport and restart recovers durable attempt as unknown", async () => {
  await withProvider("OPENCODE_GO", async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  }), async () => {
    await withPath(async (path) => {
      const runtime = SqliteAgentRuntime.open(path, ROOT);
      const pending = runtime.run(input(runtime, 1));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const evaluation = runtime.state().ledger.evaluations[0]!.ref;
      assert.equal(runtime.evaluation(evaluation).status, "attempted");
      runtime.crashClose();
      await assert.rejects(pending, (error: unknown) => error instanceof SemanticError);

      const reopened = SqliteAgentRuntime.open(path);
      assert.equal(reopened.evaluation(evaluation).status, "unknown");
      reopened.close();
    });
  });
});
