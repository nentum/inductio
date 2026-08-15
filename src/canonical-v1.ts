import { createHash } from "node:crypto";

import { SemanticError } from "./errors.ts";
import type { CanonicalValue } from "./types.ts";

interface BuildCapability {
  readonly name: string;
  readonly description: string;
  readonly parameters: CanonicalValue;
}

interface BuildIdentity {
  readonly fixedSystemPrompt: string;
  readonly capabilities: readonly BuildCapability[];
}

const BUILD_FIELDS = ["fixedSystemPrompt", "capabilities"] as const;
const CAPABILITY_FIELDS = ["name", "description", "parameters"] as const;
const DENSE_INDEX = /^(0|[1-9][0-9]*)$/;

function fail(code: string, message: string): never {
  throw new SemanticError(code, message);
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("UNPAIRED_SURROGATE", `${label} 不能包含孤立的高代理项`);
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("UNPAIRED_SURROGATE", `${label} 不能包含孤立的低代理项`);
    }
  }
}

function assertEnumerableDataProperty(target: object, key: PropertyKey): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    fail("NON_CANONICAL_PROPERTY", `字段 ${String(key)} 必须是可枚举的自有数据属性`);
  }
}

function writeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      assertUnicodeScalarString(value, "规范字符串");
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        fail("NON_FINITE_NUMBER", "规范值不接受 NaN 或无穷数");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      fail("UNSUPPORTED_CANONICAL_VALUE", `不支持 ${typeof value} 类型进入规范值`);
  }

  if (ancestors.has(value)) {
    fail("CYCLIC_CANONICAL_VALUE", "规范值不能包含循环引用");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        const index =
          typeof key === "string" && DENSE_INDEX.test(key) ? Number(key) : Number.NaN;
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
          fail("NON_CANONICAL_ARRAY_PROPERTY", "规范数组不能包含有效范围索引以外的自有属性");
        }
        assertEnumerableDataProperty(value, key);
      }

      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          fail("SPARSE_ARRAY", "规范数组不能包含空洞");
        }
        parts.push(writeCanonical(value[index], ancestors));
      }
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("NON_CANONICAL_OBJECT", "只接受普通对象或无原型对象");
    }

    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        fail("SYMBOL_FIELD", "规范对象不能包含 Symbol 字段");
      }
      assertUnicodeScalarString(key, "规范对象键");
      assertEnumerableDataProperty(value, key);
      keys.push(key);
    }
    keys.sort();

    const record = value as Record<string, unknown>;
    const fields = keys.map((key) => {
      const field = record[key];
      if (field === undefined) {
        fail("UNDEFINED_FIELD", `字段 ${key} 的值为 undefined`);
      }
      return `${JSON.stringify(key)}:${writeCanonical(field, ancestors)}`;
    });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalize(value: unknown): string {
  return writeCanonical(value, new Set());
}

export function contentRefFromCanonicalBytes(domain: string, canonicalBytes: string): string {
  if (!domain || domain.includes("\0")) {
    fail("INVALID_DOMAIN", "哈希域必须非空且不能包含 NUL");
  }
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalBytes, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function contentRef(domain: string, value: unknown): string {
  return contentRefFromCanonicalBytes(domain, canonicalize(value));
}

export function immutableCanonicalCopy<T extends CanonicalValue>(value: T): T {
  canonicalize(value);
  const clone = structuredClone(value);
  const freeze = (current: CanonicalValue): void => {
    if (current && typeof current === "object") {
      if (Array.isArray(current)) {
        for (const entry of current) freeze(entry);
      } else {
        for (const entry of Object.values(current)) freeze(entry);
      }
      Object.freeze(current);
    }
  };
  freeze(clone);
  return clone;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeBuildValue(value: CanonicalValue): CanonicalValue {
  if (typeof value === "string") return normalizeNewlines(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeBuildValue(entry));
  if (value && typeof value === "object") {
    const normalized = Object.create(null) as Record<string, CanonicalValue>;
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = normalizeNewlines(key);
      if (Object.hasOwn(normalized, normalizedKey)) {
        fail(
          "BUILD_KEY_NORMALIZATION_COLLISION",
          `构建字段 ${key} 在换行规范化后发生键冲突`,
        );
      }
      normalized[normalizedKey] = normalizeBuildValue(entry);
    }
    return normalized;
  }
  return value;
}

function assertExactFields(value: object, expected: readonly string[], kind: string): void {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (canonicalize(actual) !== canonicalize(wanted)) {
    fail("UNKNOWN_BUILD_FIELD", `${kind} 字段必须恰为 ${wanted.join(", ")}`);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

/** Internal normalization used by the v2 Root identity. */
export function normalizeBuild(spec: BuildIdentity): CanonicalValue {
  canonicalize(spec as unknown as CanonicalValue);
  if (
    !spec ||
    typeof spec !== "object" ||
    typeof spec.fixedSystemPrompt !== "string" ||
    !Array.isArray(spec.capabilities)
  ) {
    fail("INVALID_BUILD", "构建必须包含字符串系统提示词和能力数组");
  }
  assertExactFields(spec, BUILD_FIELDS, "构建");

  const capabilities = spec.capabilities.map((capability) => {
    if (
      !capability ||
      typeof capability !== "object" ||
      typeof capability.name !== "string" ||
      typeof capability.description !== "string"
    ) {
      fail("INVALID_CAPABILITY", "能力必须包含名称、描述和参数模式");
    }
    assertExactFields(capability, CAPABILITY_FIELDS, "能力");
    canonicalize(capability.parameters);
    return {
      name: normalizeNewlines(capability.name),
      description: normalizeNewlines(capability.description),
      parameters: normalizeBuildValue(capability.parameters),
    } satisfies BuildCapability;
  });
  capabilities.sort((left, right) => compareUtf8(left.name, right.name));

  for (const [index, capability] of capabilities.entries()) {
    if (capability.name === "") {
      fail("EMPTY_CAPABILITY_NAME", "能力名称不能为空");
    }
    if (index > 0 && capabilities[index - 1]!.name === capability.name) {
      fail("DUPLICATE_CAPABILITY", `能力 ${capability.name} 重复`);
    }
  }

  return {
    fixedSystemPrompt: normalizeNewlines(spec.fixedSystemPrompt),
    capabilities,
  };
}
