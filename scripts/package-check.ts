import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "inductio-package-"));
const consumer = join(temporary, "consumer");
const npmExecPath = process.env.npm_execpath;

function runNode(args: readonly string[], cwd: string): string {
  const result = spawnSync(process.execPath, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error(
      `node ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function runNpm(args: readonly string[], cwd: string): string {
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : [...args];
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} failed\nerror:\n${String(result.error)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

try {
  for (const path of [join(root, "dist/index.js"), join(root, "dist/index.d.ts")]) {
    assert.ok(existsSync(path), `missing build output: ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly private?: unknown;
    readonly license?: unknown;
    readonly packageManager?: unknown;
    readonly os?: unknown;
    readonly cpu?: unknown;
    readonly dependencies?: unknown;
    readonly optionalDependencies?: unknown;
    readonly peerDependencies?: unknown;
    readonly exports?: unknown;
  };
  assert.equal(manifest.name, "inductio");
  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.private, false);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.packageManager, "npm@10.9.8");
  assert.deepEqual(manifest.os, ["win32", "linux"]);
  assert.deepEqual(manifest.cpu, ["x64"]);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.deepEqual(manifest.exports, {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
  });

  const packOutput = runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
    root,
  );
  const [packed] = JSON.parse(packOutput) as readonly {
    readonly filename: string;
    readonly files: readonly { readonly path: string }[];
  }[];
  assert.ok(packed, "npm pack did not report an artifact");
  assert.equal(packed.filename, "inductio-0.3.0.tgz");
  assert.deepEqual(
    packed.files.map((file) => file.path).toSorted(),
    ["LICENSE", "README.md", "RELEASE-SCOPE.md", "dist/index.d.ts", "dist/index.js", "package.json", "schema/003-axiomatic-v2.sql"],
  );
  const tarball = join(temporary, packed.filename);
  const secondPackDirectory = join(temporary, "second-pack");
  mkdirSync(secondPackDirectory);
  const secondPackOutput = runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", secondPackDirectory],
    root,
  );
  const [secondPacked] = JSON.parse(secondPackOutput) as readonly {
    readonly filename: string;
  }[];
  assert.equal(secondPacked?.filename, packed.filename);
  assert.deepEqual(
    readFileSync(join(secondPackDirectory, packed.filename)),
    readFileSync(tarball),
    "repeated npm pack output must be byte-identical",
  );

  const bundle = readFileSync(join(root, "dist/index.js"), "utf8");
  const declarations = readFileSync(join(root, "dist/index.d.ts"), "utf8");
  const nativeImports = [...new Set(
    [...bundle.matchAll(/node:[a-z0-9_/-]+/g)].map((match) => match[0]),
  )].toSorted();
  assert.deepEqual(nativeImports, [
    "node:child_process",
    "node:crypto",
    "node:fs",
    "node:path",
    "node:sqlite",
    "node:url",
    "node:vm",
  ]);
  for (const forbidden of [
    "AGENT_RUNTIME_FAULT_HOOK",
    "InternalHost",
    "OwnerToken",
    "TransportSecrets",
    "createProductRuntime",
    "CapabilityGateway",
  ]) {
    assert.equal(bundle.includes(forbidden), false, `bundle contains forbidden surface: ${forbidden}`);
    assert.equal(
      declarations.includes(forbidden),
      false,
      `declarations contain forbidden surface: ${forbidden}`,
    );
  }
  for (const hidden of [
    "AxiomaticRuntimeV2",
    "AxiomaticDurableEngine",
    "AxiomaticSqliteConnection",
    "modelClient",
    "VersionedProjectionPolicy",
    "VersionedAdoptionPolicy",
  ]) {
    assert.equal(
      declarations.includes(hidden),
      false,
      `declarations expose lower-level core: ${hidden}`,
    );
  }
  assert.match(declarations, /apiKeyEnv: "OPENCODE_GO"/);
  assert.equal(declarations.includes("apiKeyEnv?:"), false, "declarations expose configurable apiKeyEnv");
  assert.equal(declarations.includes("fetch?: typeof globalThis.fetch"), false, "declarations expose fetch injection");

  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumer,
  );

  writeFileSync(
    join(consumer, "smoke.mjs"),
    `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as runtimePackage from "inductio";

assert.deepEqual(Object.keys(runtimePackage).sort(), [
  "InMemoryAgentRuntime",
  "OPENCODE_GO_DEFAULTS",
  "OpenCodeGoClient",
  "SemanticError",
  "SqliteAgentRuntime",
  "compileOpenCodeGoChatRequest",
  "createInMemoryAgentRuntime",
  "effectivePolicyIdentity",
  "executePolicyPlugin",
  "inMemoryRuntimeStateRef",
  "normalizePolicyPlugin",
  "normalizePolicyPluginPair",
  "restoreInMemoryAgentRuntime",
]);
const pluginPath = fileURLToPath(new URL("./package-plugin.mjs", import.meta.url));
writeFileSync(pluginPath, [
  "export default function project(input) {",
  "  return {",
  "    selectedNodes: [],",
  "    appendContent: {",
  "      version: 'offline-model-input/v1',",
  "      history: [],",
  "      candidateInput: input.candidateInput,",
  "      environment: input.environment,",
  "    },",
  "  };",
  "}",
].join("\\n") + "\\n");
const plugin = runtimePackage.normalizePolicyPlugin({
  version: "policy-plugin/v1",
  identity: { kind: "projection", name: "package-smoke", version: "v1" },
  module: pluginPath,
  sourceSha256: createHash("sha256").update(readFileSync(pluginPath)).digest("hex"),
}, "projection");
const pluginResult = await runtimePackage.executePolicyPlugin(plugin, {
  root: {
    agent: "sha256:" + "1".repeat(64),
    root: "sha256:" + "2".repeat(64),
    body: { rootPrompt: "smoke", toolDefinitions: [] },
  },
  parent: "sha256:" + "2".repeat(64),
  path: [{
    kind: "root",
    ref: "sha256:" + "2".repeat(64),
    body: { rootPrompt: "smoke", toolDefinitions: [] },
  }],
  candidateInput: [{ kind: "message", role: "user", content: "hello" }],
  environment: { version: "environment-snapshot/v1", values: null },
  endpoint: { version: "offline-endpoint/v1" },
  explicitInputs: null,
});
assert.deepEqual(pluginResult.selectedNodes, []);
const runtime = runtimePackage.createInMemoryAgentRuntime({
  rootPrompt: "offline smoke",
  toolDefinitions: [],
});
const first = runtime.run({
  parent: runtime.root().root,
  source: "package-smoke",
  position: 1,
  input: [{ kind: "message", role: "user", content: { text: "hello" } }],
  evaluator: { version: "offline-evaluator/v1", kind: "echo" },
});
assert.equal(first.status, "completed");
assert.notEqual(first.head, first.parent);
const restored = runtimePackage.restoreInMemoryAgentRuntime(runtime.snapshot());
assert.equal(restored.stateRef(), runtime.stateRef());
assert.deepEqual(restored.path(first.head), runtime.path(first.head));
const durableDirectory = mkdtempSync(join(tmpdir(), "axiomatic-package-sqlite-"));
const previousKey = process.env.OPENCODE_GO;
const previousFetch = globalThis.fetch;
process.env.OPENCODE_GO = "package-test-key";
globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{ finish_reason: "stop", message: { content: "ok" } }],
}), { status: 200, headers: { "content-type": "application/json" } });
const durable = runtimePackage.SqliteAgentRuntime.open(
  join(durableDirectory, "runtime.db"),
  { rootPrompt: "durable smoke", toolDefinitions: [] },
  {},
);
const durableResult = await durable.run({
  parent: durable.root().root,
  source: "package-durable-smoke",
  position: 1,
  input: [{ kind: "message", role: "user", content: "hello" }],
});
assert.equal(durableResult.status, "completed");
durable.close();
globalThis.fetch = previousFetch;
if (previousKey === undefined) delete process.env.OPENCODE_GO;
else process.env.OPENCODE_GO = previousKey;
rmSync(durableDirectory, { recursive: true, force: true });
await assert.rejects(
  import("inductio/dist/index.js"),
  (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
);
console.log("INSTALLED_PACKAGE_SMOKE=PASS");
`,
    "utf8",
  );
  const smokeOutput = runNode([join(consumer, "smoke.mjs")], consumer);
  assert.match(smokeOutput, /INSTALLED_PACKAGE_SMOKE=PASS/);

  writeFileSync(
    join(consumer, "type-smoke.ts"),
    `import {
  SqliteAgentRuntime,
  createInMemoryAgentRuntime,
  type AxiomaticRootBody,
  type SemanticItem,
  type SqliteAgentRuntimeOptions,
} from "inductio";

const root: AxiomaticRootBody = { rootPrompt: "typed", toolDefinitions: [] };
const input: readonly SemanticItem[] = [
  { kind: "message", role: "user", content: "hello" },
];
const runtime = createInMemoryAgentRuntime(root);
runtime.run({
  parent: runtime.root().root,
  source: "type-smoke",
  position: 1,
  input,
  evaluator: { version: "offline-evaluator/v1", kind: "echo" },
});
const sqliteOptions: SqliteAgentRuntimeOptions = { timeoutMs: 30_000 };
const durable = SqliteAgentRuntime.open("/absolute/type-smoke.db", root, sqliteOptions);
void durable.run({
  parent: durable.root().root,
  source: "durable-type-smoke",
  position: 1,
  input,
});
durable.close();
`,
    "utf8",
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          types: [],
        },
        include: ["type-smoke.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  runNode(
    [join(root, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")],
    consumer,
  );

  const releaseDirectory = join(root, "release");
  rmSync(releaseDirectory, { recursive: true, force: true });
  mkdirSync(releaseDirectory);
  const releaseTarball = join(releaseDirectory, packed.filename);
  copyFileSync(tarball, releaseTarball);
  const sha256 = createHash("sha256").update(readFileSync(releaseTarball)).digest("hex");
  console.log("PACKAGE_CONTENTS_CHECK=PASS");
  console.log("SAME_HOST_TARBALL_BYTE_IDENTITY=PASS");
  console.log("INSTALLED_PACKAGE_SMOKE=PASS");
  console.log("INSTALLED_TYPES_SMOKE=PASS");
  console.log(`PACKAGE_TARBALL=${releaseTarball}`);
  console.log(`PACKAGE_SHA256=${sha256}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
