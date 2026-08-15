import { AxiomaticDurableEngine } from "../../src/axiomatic-durable-engine.ts";
import { AxiomaticSqliteConnection } from "../../src/axiomatic-sqlite-connection.ts";

const path = process.argv[2];
if (!path) {
  process.stderr.write("missing database path\n");
  process.exit(2);
}

const connection = AxiomaticSqliteConnection.open(path, { busyTimeoutMs: 5_000 });
const engine = AxiomaticDurableEngine.open(connection);
const root = engine.root().root;
process.stdout.write("ready\n");

process.stdin.once("data", () => {
  try {
    engine.prepareOpenCodeEvaluation({
      parent: root,
      source: "axiomatic-durable-race",
      position: 1,
      input: [{ kind: "message", role: "user", content: "same" }],
      environment: { version: "environment-snapshot/v1", values: null },
      endpoint: {
        version: "opencode-go-endpoint/v1",
        provider: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1/",
        model: "deepseek-v4-flash",
      },
    });
    process.stdout.write("ok\n");
    engine.close();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
    process.stdout.write(`err:${code}\n`);
    try {
      engine.close();
    } catch {
      // Preserve the command result for the parent process.
    }
    process.exitCode = 1;
  }
});
process.stdin.resume();
