import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { canonicalize, immutableCanonicalCopy } from "./canonical-v1.ts";
import { SemanticError } from "./errors.ts";
import type {
  AdoptionPolicyInput,
  PolicyIdentity,
  ProjectionDraft,
  ProjectionPolicyInput,
  AdoptionDecision,
} from "./axiomatic-v2.ts";
import type { CanonicalValue } from "./types.ts";

const IDENTITY_FIELDS = ["kind", "name", "version"] as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MEMORY_LIMIT_MB = 128;
const MAX_TIMEOUT_MS = 60_000;
const MIN_MEMORY_LIMIT_MB = 16;
const MAX_MEMORY_LIMIT_MB = 1_024;
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;
const MAX_MODULE_BYTES = 512 * 1024;
const SANDBOX_PROFILE = "node-vm-policy-sandbox/v1";
const SHA256 = /^[0-9a-f]{64}$/;

export type PolicyPluginInput = ProjectionPolicyInput | AdoptionPolicyInput;
export type PolicyPluginResult = ProjectionDraft | AdoptionDecision;

export interface PolicyPluginIdentityV1 {
  readonly kind: "projection" | "adoption";
  readonly name: string;
  readonly version: string;
}

export interface PolicyPluginV1 {
  readonly version: "policy-plugin/v1";
  readonly identity: PolicyPluginIdentityV1;
  readonly module: string;
  readonly sourceSha256: string;
  readonly exportName?: string;
  readonly timeoutMs?: number;
  readonly memoryLimitMb?: number;
}

export interface NormalizedPolicyPluginV1 {
  readonly version: "policy-plugin/v1";
  readonly identity: PolicyPluginIdentityV1;
  readonly module: string;
  readonly sourceSha256: string;
  readonly exportName: string | null;
  readonly timeoutMs: number;
  readonly memoryLimitMb: number;
}

export interface PolicyPluginPairV1 {
  readonly projection: PolicyPluginV1;
  readonly adoption: PolicyPluginV1;
}

export interface NormalizedPolicyPluginPairV1 {
  readonly projection: NormalizedPolicyPluginV1;
  readonly adoption: NormalizedPolicyPluginV1;
}

interface SandboxRequest {
  readonly version: "policy-sandbox-request/v1";
  readonly profile: string;
  readonly identity: PolicyPluginIdentityV1 & { readonly exportName?: string };
  readonly sourceSha256: string;
  readonly moduleSourceBase64: string;
  readonly input: CanonicalValue;
}

interface SandboxResponse {
  readonly version: "policy-sandbox-response/v1";
  readonly ok: boolean;
  readonly result?: CanonicalValue;
  readonly error?: {
    readonly code?: string;
    readonly message: string;
  };
}

const SANDBOX_RUNNER = String.raw`
import { createHash } from "node:crypto";
import { createContext, runInContext, SourceTextModule } from "node:vm";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalExit = process.exit.bind(process);
const respond = (response) => {
  let encoded;
  try {
    encoded = JSON.stringify(response);
  } catch (error) {
    encoded = JSON.stringify({
      version: "policy-sandbox-response/v1",
      ok: false,
      error: {
        code: "PLUGIN_RESULT_SERIALIZATION",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
  originalStdoutWrite(encoded, () => originalExit(0));
};
const codedError = (code, message) => Object.assign(new Error(message), { code });

try {
  let protocolSource = "";
  for await (const chunk of process.stdin) protocolSource += chunk;
  const request = JSON.parse(protocolSource);
  if (
    !request ||
    request.version !== "policy-sandbox-request/v1" ||
    request.profile !== "${SANDBOX_PROFILE}" ||
    typeof request.moduleSourceBase64 !== "string" ||
    typeof request.sourceSha256 !== "string"
  ) {
    throw codedError("SANDBOX_REQUEST_VERSION", "unsupported sandbox request");
  }
  const moduleBytes = Buffer.from(request.moduleSourceBase64, "base64");
  if (
    moduleBytes.length > ${MAX_MODULE_BYTES} ||
    moduleBytes.toString("base64") !== request.moduleSourceBase64
  ) {
    throw codedError("PLUGIN_SOURCE_INVALID", "plugin source encoding or size is invalid");
  }
  const digest = createHash("sha256").update(moduleBytes).digest("hex");
  if (digest !== request.sourceSha256) {
    throw codedError("PLUGIN_SOURCE_HASH", "plugin source hash does not match request");
  }
  let moduleSource;
  try {
    moduleSource = new TextDecoder("utf-8", { fatal: true }).decode(moduleBytes);
  } catch {
    throw codedError("PLUGIN_SOURCE_ENCODING", "plugin source must be valid UTF-8");
  }

  const sandbox = Object.create(null);
  Object.defineProperty(sandbox, "__policyInputJson", {
    value: JSON.stringify(request.input),
    configurable: true,
    enumerable: false,
    writable: false,
  });
  const context = createContext(sandbox, {
    name: "axiomatic-policy-plugin",
    codeGeneration: { strings: false, wasm: false },
  });
  runInContext(
    '"use strict";\n' +
    'const deny = () => { const error = new Error("sandbox nondeterminism denied"); error.code = "ERR_ACCESS_DENIED"; throw error; };\n' +
    'const NativeDate = Date;\n' +
    'class PolicyDate extends NativeDate { constructor(...args) { if (args.length === 0) deny(); super(...args); } static now() { return deny(); } }\n' +
    'Object.freeze(PolicyDate.prototype); Object.freeze(PolicyDate);\n' +
    'Object.defineProperty(globalThis, "Date", { value: PolicyDate, configurable: false, writable: false });\n' +
    'Object.defineProperty(Math, "random", { value: deny, configurable: false, writable: false }); Object.freeze(Math);\n' +
    'for (const name of ["process", "require", "module", "exports", "Buffer", "fetch", "WebSocket", "EventSource", "Worker", "BroadcastChannel", "MessageChannel", "MessagePort", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "performance", "crypto", "Intl", "Atomics", "SharedArrayBuffer", "WeakRef", "FinalizationRegistry", "WebAssembly", "console"]) Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });\n' +
    'const input = JSON.parse(globalThis.__policyInputJson); delete globalThis.__policyInputJson;\n' +
    'const pending = [input]; const seen = new Set(); while (pending.length > 0) { const value = pending.pop(); if (value && typeof value === "object" && !seen.has(value)) { seen.add(value); for (const key of Reflect.ownKeys(value)) pending.push(value[key]); Object.freeze(value); } }\n' +
    'Object.defineProperty(globalThis, "__policyInput", { value: input, configurable: false, enumerable: false, writable: false });',
    context,
  );
  const policyModule = new SourceTextModule(moduleSource, {
    context,
    identifier: "axiomatic-policy-plugin:sha256:" + request.sourceSha256,
    importModuleDynamically() {
      throw codedError("PLUGIN_IMPORT_DENIED", "policy plugin imports are not allowed");
    },
  });
  await policyModule.link(() => {
    throw codedError("PLUGIN_IMPORT_DENIED", "policy plugin imports are not allowed");
  });
  await policyModule.evaluate();
  const exportName = request.identity && request.identity.exportName;
  const candidate = exportName
    ? policyModule.namespace[exportName]
    : policyModule.namespace.default ?? policyModule.namespace.policy;
  if (typeof candidate !== "function") {
    throw codedError("PLUGIN_EXPORT_INVALID", "plugin must export a function");
  }
  const policyInput = runInContext("globalThis.__policyInput", context);
  const result = candidate(policyInput);
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof result.then === "function"
  ) {
    throw codedError("PLUGIN_ASYNC_POLICY", "policy plugin must return a synchronous value");
  }
  respond({ version: "policy-sandbox-response/v1", ok: true, result });
} catch (error) {
  respond({
    version: "policy-sandbox-response/v1",
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : "PLUGIN_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}
`;

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", `${label} must be an object`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", `${label} has an unexpected field set`);
  }
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", `${label} must be non-empty`);
  }
}

function copy<T extends CanonicalValue>(value: T): T {
  return immutableCanonicalCopy(value);
}

function normalizeIdentity(
  value: PolicyPluginIdentityV1,
  expectedKind: PolicyPluginIdentityV1["kind"],
): PolicyPluginIdentityV1 {
  canonicalize(value as unknown as CanonicalValue);
  assertObject(value, "plugin.identity");
  assertExactKeys(value, IDENTITY_FIELDS, "plugin.identity");
  if (value.kind !== "projection" && value.kind !== "adoption") {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "plugin identity kind is not supported");
  }
  if (value.kind !== expectedKind) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "plugin identity kind does not match its slot");
  }
  nonEmpty(value.name, "plugin.identity.name");
  nonEmpty(value.version, "plugin.identity.version");
  return Object.freeze({ kind: value.kind, name: value.name, version: value.version });
}

function moduleBytes(path: string): Buffer {
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_MODULE_BYTES) {
      fail(
        "AXIOMATIC_POLICY_SANDBOX_MODULE_LIMIT",
        `policy plugin module exceeds ${MAX_MODULE_BYTES} bytes`,
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof SemanticError) throw error;
    fail(
      "AXIOMATIC_POLICY_SANDBOX_MODULE_UNREADABLE",
      `cannot read policy plugin module: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function moduleDigest(path: string): string {
  return createHash("sha256").update(moduleBytes(path)).digest("hex");
}

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizePolicyPlugin(
  value: PolicyPluginV1,
  expectedKind: PolicyPluginIdentityV1["kind"],
): NormalizedPolicyPluginV1 {
  canonicalize(value as unknown as CanonicalValue);
  assertObject(value, "policyPlugin");
  const expectedKeys = [
    "version",
    "identity",
    "module",
    "sourceSha256",
    ...(value.exportName === undefined ? [] : ["exportName"]),
    ...(value.timeoutMs === undefined ? [] : ["timeoutMs"]),
    ...(value.memoryLimitMb === undefined ? [] : ["memoryLimitMb"]),
  ];
  assertExactKeys(value, expectedKeys, "policyPlugin");
  if (value.version !== "policy-plugin/v1") {
    fail("AXIOMATIC_POLICY_SANDBOX_UNSUPPORTED_VERSION", "policyPlugin.version is not supported");
  }
  const identity = normalizeIdentity(value.identity, expectedKind);
  nonEmpty(value.module, "policyPlugin.module");
  if (!isAbsolute(value.module)) {
    fail(
      "AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC",
      "policyPlugin.module must be an absolute path",
    );
  }
  const module = resolve(value.module);
  if (!/\.(?:mjs|js)$/i.test(module)) {
    fail(
      "AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC",
      "policyPlugin.module must resolve to an absolute .mjs or .js file",
    );
  }
  if (typeof value.sourceSha256 !== "string" || !SHA256.test(value.sourceSha256)) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "sourceSha256 must be lowercase SHA-256 hex");
  }
  if (moduleDigest(module) !== value.sourceSha256) {
    fail(
      "AXIOMATIC_POLICY_SANDBOX_MODULE_HASH",
      "policy plugin module content does not match sourceSha256",
    );
  }
  const exportName = value.exportName === undefined ? null : value.exportName;
  if (exportName !== null) nonEmpty(exportName, "policyPlugin.exportName");
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryLimitMb = value.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "timeoutMs is outside the supported range");
  }
  if (
    !Number.isSafeInteger(memoryLimitMb) ||
    memoryLimitMb < MIN_MEMORY_LIMIT_MB ||
    memoryLimitMb > MAX_MEMORY_LIMIT_MB
  ) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "memoryLimitMb is outside the supported range");
  }
  return Object.freeze({
    version: "policy-plugin/v1",
    identity,
    module,
    sourceSha256: value.sourceSha256,
    exportName,
    timeoutMs,
    memoryLimitMb,
  });
}

export function normalizePolicyPluginPair(
  value: PolicyPluginPairV1,
): NormalizedPolicyPluginPairV1 {
  canonicalize(value as unknown as CanonicalValue);
  assertObject(value, "policyPlugins");
  assertExactKeys(value, ["projection", "adoption"], "policyPlugins");
  return Object.freeze({
    projection: normalizePolicyPlugin(value.projection, "projection"),
    adoption: normalizePolicyPlugin(value.adoption, "adoption"),
  });
}

export function effectivePolicyIdentity(plugin: NormalizedPolicyPluginV1): PolicyIdentity {
  return Object.freeze({
    kind: plugin.identity.kind,
    name: plugin.identity.name,
    version:
      `${plugin.identity.version}@sandbox=${SANDBOX_PROFILE}` +
      `@sha256:${plugin.sourceSha256}` +
      `@export=${plugin.exportName ?? "default"}` +
      `@timeout=${plugin.timeoutMs}@memory=${plugin.memoryLimitMb}`,
  });
}

function validateNormalizedPlugin(plugin: NormalizedPolicyPluginV1): Buffer {
  canonicalize(plugin as unknown as CanonicalValue);
  assertObject(plugin, "normalized policyPlugin");
  assertExactKeys(
    plugin,
    ["version", "identity", "module", "sourceSha256", "exportName", "timeoutMs", "memoryLimitMb"],
    "normalized policyPlugin",
  );
  if (plugin.version !== "policy-plugin/v1") {
    fail("AXIOMATIC_POLICY_SANDBOX_UNSUPPORTED_VERSION", "policyPlugin.version is not supported");
  }
  normalizeIdentity(plugin.identity, plugin.identity.kind);
  nonEmpty(plugin.module, "policyPlugin.module");
  if (!isAbsolute(plugin.module)) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "policyPlugin.module must be an absolute path");
  }
  const module = resolve(plugin.module);
  if (!/\.(?:mjs|js)$/i.test(module)) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "policyPlugin.module must resolve to .mjs or .js");
  }
  if (typeof plugin.sourceSha256 !== "string" || !SHA256.test(plugin.sourceSha256)) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "sourceSha256 must be lowercase SHA-256 hex");
  }
  if (plugin.exportName !== null) nonEmpty(plugin.exportName, "policyPlugin.exportName");
  if (!Number.isSafeInteger(plugin.timeoutMs) || plugin.timeoutMs < 1 || plugin.timeoutMs > MAX_TIMEOUT_MS) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "timeoutMs is outside the supported range");
  }
  if (
    !Number.isSafeInteger(plugin.memoryLimitMb) ||
    plugin.memoryLimitMb < MIN_MEMORY_LIMIT_MB ||
    plugin.memoryLimitMb > MAX_MEMORY_LIMIT_MB
  ) {
    fail("AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC", "memoryLimitMb is outside the supported range");
  }
  const bytes = moduleBytes(module);
  if (digestBytes(bytes) !== plugin.sourceSha256) {
    fail("AXIOMATIC_POLICY_SANDBOX_MODULE_HASH", "policy plugin module content does not match sourceSha256");
  }
  return bytes;
}

function sandboxRequest(
  plugin: NormalizedPolicyPluginV1,
  input: PolicyPluginInput,
  moduleSourceBase64: string,
): SandboxRequest {
  return {
    version: "policy-sandbox-request/v1",
    profile: SANDBOX_PROFILE,
    identity: {
      ...plugin.identity,
      ...(plugin.exportName === null ? {} : { exportName: plugin.exportName }),
    } as PolicyPluginIdentityV1,
    sourceSha256: plugin.sourceSha256,
    moduleSourceBase64,
    input: copy(input as unknown as CanonicalValue),
  };
}

function sandboxError(code: string, message: string): SemanticError {
  return new SemanticError(code, message);
}

export async function executePolicyPlugin(
  plugin: NormalizedPolicyPluginV1,
  input: PolicyPluginInput,
  signal?: AbortSignal,
): Promise<PolicyPluginResult> {
  if (signal?.aborted) {
    throw sandboxError(
      "AXIOMATIC_POLICY_SANDBOX_ABORTED",
      "policy sandbox execution was aborted",
    );
  }
  let bytes: Buffer;
  try {
    bytes = validateNormalizedPlugin(plugin);
  } catch (error) {
    if (error instanceof SemanticError) throw error;
    throw sandboxError(
      "AXIOMATIC_POLICY_SANDBOX_INVALID_SPEC",
      error instanceof Error ? error.message : String(error),
    );
  }
  const request = sandboxRequest(plugin, input, bytes.toString("base64"));
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROTOCOL_BYTES) {
    throw sandboxError(
      "AXIOMATIC_POLICY_SANDBOX_INPUT_LIMIT",
      "policy sandbox input exceeds the protocol limit",
    );
  }
  const args = [
    "--experimental-permission",
    "--experimental-vm-modules",
    "--disallow-code-generation-from-strings",
    "--disable-proto=throw",
    "--no-addons",
    `--max-old-space-size=${plugin.memoryLimitMb}`,
    "--input-type=module",
    "--eval",
    SANDBOX_RUNNER,
  ];
  return await new Promise<PolicyPluginResult>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, args, {
      env: {
        NODE_ENV: "agent-runtime-policy-sandbox",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError: SemanticError | undefined;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const terminate = (error: SemanticError): void => {
      if (settled || terminationError !== undefined) return;
      terminationError = error;
      cleanup();
      child.stdin.destroy();
      try {
        child.kill("SIGKILL");
      } catch {
        // A spawn error still reaches the close/error lifecycle below.
      }
    };
    const onAbort = (): void => {
      terminate(
        sandboxError(
          "AXIOMATIC_POLICY_SANDBOX_ABORTED",
          "policy sandbox execution was aborted",
        ),
      );
    };

    timer = setTimeout(() => {
      terminate(
        sandboxError(
          "AXIOMATIC_POLICY_SANDBOX_TIMEOUT",
          `policy sandbox exceeded ${plugin.timeoutMs}ms`,
        ),
      );
    }, plugin.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_PROTOCOL_BYTES) {
        terminate(
          sandboxError(
            "AXIOMATIC_POLICY_SANDBOX_OUTPUT_LIMIT",
            "policy sandbox output exceeds the protocol limit",
          ),
        );
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") < 16 * 1024) stderr += chunk;
    });
    child.on("error", (error) => {
      terminate(
        sandboxError(
          "AXIOMATIC_POLICY_SANDBOX_SPAWN",
          `cannot start policy sandbox: ${error.message}`,
        ),
      );
    });
    child.on("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminationError !== undefined) {
        rejectResult(terminationError);
        return;
      }
      if (code !== 0) {
        const permission = stderr.includes("ERR_ACCESS_DENIED") || stderr.includes("permission");
        rejectResult(
          sandboxError(
            permission
              ? "AXIOMATIC_POLICY_SANDBOX_PERMISSION"
              : "AXIOMATIC_POLICY_SANDBOX_EXIT",
            `policy sandbox exited with ${exitSignal ?? `code ${code}`}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      let response: SandboxResponse;
      try {
        response = JSON.parse(stdout) as SandboxResponse;
        canonicalize(response as unknown as CanonicalValue);
      } catch (error) {
        rejectResult(
          sandboxError(
            "AXIOMATIC_POLICY_SANDBOX_PROTOCOL",
            `policy sandbox returned invalid JSON${error instanceof Error ? `: ${error.message}` : ""}`,
          ),
        );
        return;
      }
      if (
        response.version !== "policy-sandbox-response/v1" ||
        typeof response.ok !== "boolean"
      ) {
        rejectResult(
          sandboxError("AXIOMATIC_POLICY_SANDBOX_PROTOCOL", "invalid policy sandbox response envelope"),
        );
        return;
      }
      if (!response.ok) {
        rejectResult(
          sandboxError(
            response.error?.code === "ERR_ACCESS_DENIED"
              ? "AXIOMATIC_POLICY_SANDBOX_PERMISSION"
              : "AXIOMATIC_POLICY_SANDBOX_PLUGIN_ERROR",
            response.error?.message ?? "policy plugin failed without a message",
          ),
        );
        return;
      }
      if (response.result === undefined) {
        rejectResult(
          sandboxError("AXIOMATIC_POLICY_SANDBOX_RESULT", "policy plugin returned undefined"),
        );
        return;
      }
      try {
        canonicalize(response.result as unknown as CanonicalValue);
      } catch (error) {
        rejectResult(
          sandboxError(
            "AXIOMATIC_POLICY_SANDBOX_RESULT",
            `policy plugin returned a non-canonical result${error instanceof Error ? `: ${error.message}` : ""}`,
          ),
        );
        return;
      }
      resolveResult(response.result as unknown as PolicyPluginResult);
    });
    child.stdin.on("error", (error) => {
      if (!settled && terminationError === undefined) {
        terminate(
          sandboxError("AXIOMATIC_POLICY_SANDBOX_PROTOCOL", `cannot write policy request: ${error.message}`),
        );
      }
    });
    child.stdin.end(serialized);
  });
}
