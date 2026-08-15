import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAgentRuntime } from "../src/index.ts";
import type { SqliteAgentRuntimeOptions } from "../src/index.ts";

const ROOT = {
  rootPrompt: "You are a production connectivity probe. Reply briefly.",
  toolDefinitions: [],
} as const;

const CASES = [
  {
    name: "opencode-go-chat-completions",
    env: "OPENCODE_GO",
    provider: "opencode-go" as const,
    adapter: "openai-chat-completions/v1" as const,
    model: "deepseek-v4-flash",
    baseUrl: "https://opencode.ai/zen/go/v1/",
  },
  {
    name: "openai-chat-completions",
    env: "OPENAI_API_KEY",
    provider: "openai" as const,
    adapter: "openai-chat-completions/v1" as const,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/",
  },
  {
    name: "openai-responses",
    env: "OPENAI_API_KEY",
    provider: "openai" as const,
    adapter: "openai-responses/v1" as const,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/",
  },
  {
    name: "anthropic-messages",
    env: "ANTHROPIC_API_KEY",
    provider: "anthropic" as const,
    adapter: "anthropic-messages/v1" as const,
    model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest",
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1/",
  },
] as const;

for (const item of CASES) {
  test(`live ${item.name} completes one durable evaluation`, {
    skip: !process.env[item.env],
  }, async () => {
    const directory = mkdtempSync(join(tmpdir(), `live-${item.name}-`));
    const path = join(directory, "runtime.db");
    let runtime: SqliteAgentRuntime | undefined;
    try {
      runtime = SqliteAgentRuntime.open(path, ROOT, {
        provider: item.provider,
        adapter: item.adapter,
        baseUrl: item.baseUrl,
        model: item.model,
      } as SqliteAgentRuntimeOptions);
      const result = await runtime.run({
        parent: runtime.root().root,
        source: item.name,
        position: 1,
        input: [{ kind: "message", role: "user", content: "Reply with exactly OK." }],
      });
      assert.equal(result.status, "completed");
      if (result.request.version !== "axiomatic-model-request/v2") {
        throw new Error(`unexpected durable request version: ${result.request.version}`);
      }
      assert.equal(result.request.provider, item.provider);
      assert.equal(result.request.adapter, item.adapter);
      assert.equal(runtime.evaluation(result.evaluation).status, "completed");
      console.log(JSON.stringify({
        LIVE_MODEL_ADAPTER: "PASS",
        adapter: item.adapter,
        provider: item.provider,
        model: result.request.model,
        emissions: runtime.evaluation(result.evaluation).emissions.length,
      }));
    } finally {
      runtime?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
}
