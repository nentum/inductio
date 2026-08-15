import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAgentRuntime } from "../src/index.ts";

const ROOT = {
  rootPrompt: "You are a production connectivity probe. Reply briefly.",
  toolDefinitions: [],
} as const;

test("live OpenCode Go deepseek-v4-flash completes the durable v2 command path", {
  skip: !process.env.OPENCODE_GO,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "live-opencode-go-v2-"));
  const path = join(directory, "runtime.db");
  let runtime: SqliteAgentRuntime | undefined;
  try {
    runtime = SqliteAgentRuntime.open(path, ROOT);
    const result = await runtime.run({
      parent: runtime.root().root,
      source: "live-opencode-go",
      position: 1,
      input: [{ kind: "message", role: "user", content: "Reply with exactly OK." }],
    });
    assert.equal(result.status, "completed");
    assert.notEqual(result.head, result.parent);
    assert.equal(runtime.evaluation(result.evaluation).status, "completed");
    assert.equal(result.output.some((item) => item.kind === "message" && item.role === "assistant"), true);
    const stateRef = runtime.stateRef();
    runtime.close();
    runtime = SqliteAgentRuntime.open(path);
    assert.equal(runtime.stateRef(), stateRef);
    assert.deepEqual(runtime.path(result.head), [runtime.root().root, result.head]);
    console.log(JSON.stringify({
      LIVE_OPENCODE_GO: "PASS",
      model: result.request.model,
      finish: result.status,
      emissions: runtime.evaluation(result.evaluation).emissions.length,
    }));
  } finally {
    runtime?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
