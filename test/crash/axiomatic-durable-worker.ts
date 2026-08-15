import { writeFileSync } from "node:fs";

import { AxiomaticDurableEngine } from "../../src/axiomatic-durable-engine.ts";
import { AxiomaticSqliteConnection } from "../../src/axiomatic-sqlite-connection.ts";

const path = process.argv[2];
const cut = process.argv[3];
if (!path || !["partial-projection", "attempt", "emission", "outcome"].includes(cut ?? "")) {
  process.stderr.write("usage: axiomatic-durable-worker.ts <db> <partial-projection|attempt|emission|outcome>\n");
  process.exit(2);
}

const connection = AxiomaticSqliteConnection.open(path, { busyTimeoutMs: 5_000 });
const engine = AxiomaticDurableEngine.open(connection);
if (cut === "partial-projection") {
  connection.withImmediateTransaction(() => {
    connection.run(
      "INSERT INTO axiomatic_commands(command_ref, command_kind, body_bytes, result_bytes) VALUES (?, 'mark-unknown', ?, ?)",
      `sha256:${"f".repeat(64)}`,
      Buffer.from("partial-command", "utf8"),
      Buffer.from("partial-result", "utf8"),
    );
    connection.run(
      "INSERT INTO axiomatic_roots(root_ref, agent_ref, body_bytes) VALUES (?, ?, ?)",
      `sha256:${"e".repeat(64)}`,
      `sha256:${"d".repeat(64)}`,
      Buffer.from("partial-projection", "utf8"),
    );
    writeFileSync(1, "cut:partial-projection:partial\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  throw new Error("unreachable");
}
const prepared = engine.prepareEvaluation({
  parent: engine.root().root,
  source: `axiomatic-crash-${cut}`,
  position: 1,
  input: [{ kind: "message", role: "user", content: "crash-cut" }],
  environment: { version: "environment-snapshot/v1", values: null },
  endpoint: {
    version: "model-endpoint/v2",
    provider: "opencode-go",
    adapter: "openai-chat-completions/v1",
    baseUrl: "https://opencode.ai/zen/go/v1/",
    model: "deepseek-v4-flash",
  },
});
engine.claimAttempt(prepared.evaluation);
if (cut === "attempt") await stop(prepared.evaluation);

const output = [{ kind: "message" as const, role: "assistant" as const, content: "durable-output" }];
engine.recordEmission({
  evaluation: prepared.evaluation,
  ordinal: 0,
  producer: "crash-fixture",
  protocol: "crash-fixture/v1",
  payload: output,
});
if (cut === "emission") await stop(prepared.evaluation);

engine.complete(prepared.evaluation, "completed", {
  version: "axiomatic-model-outcome/v2",
  finishReason: "stop",
});
await stop(prepared.evaluation);

async function stop(evaluation: string): Promise<never> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`cut:${cut}:${evaluation}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  setInterval(() => {}, 1_000);
  return await new Promise<never>(() => {});
}
