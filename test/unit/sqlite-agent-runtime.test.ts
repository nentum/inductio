import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAgentRuntime } from "../../src/sqlite-agent-runtime.ts";
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
  fetch: typeof globalThis.fetch,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previousKey = process.env.OPENCODE_GO;
  const previousFetch = globalThis.fetch;
  process.env.OPENCODE_GO = "test-provider-key";
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENCODE_GO;
    else process.env.OPENCODE_GO = previousKey;
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

test("SqliteAgentRuntime persists completed OpenCode Go output and adopted head", async () => {
  await withProvider(async () => completionResponse(), async () => {
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

test("invalid provider configuration fails before creating the SQLite file", async () => {
  await withPath((path) => {
    assert.equal(existsSync(path), false);
    assert.throws(
      () => SqliteAgentRuntime.open(path, ROOT, { baseUrl: "http://insecure.invalid/" }),
      (error: unknown) => error instanceof SemanticError && error.code === "OPENCODE_GO_INSECURE_ENDPOINT",
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
        (error: unknown) => error instanceof SemanticError && error.code === "OPENCODE_GO_KEY_MISSING",
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
    await withProvider(async () => { throw new Error("network"); }, async () => {
      const runtime = SqliteAgentRuntime.open(path, ROOT);
      const unknown = await runtime.run(input(runtime, 1));
      assert.equal(unknown.status, "unknown");
      assert.equal(runtime.evaluation(unknown.evaluation).status, "unknown");
      runtime.close();
    });

    await withProvider(async () => new Response("provider failure", { status: 503 }), async () => {
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
  await withProvider(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
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
