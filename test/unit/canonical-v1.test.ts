import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalize,
  contentRef,
  immutableCanonicalCopy,
} from "../../src/canonical-v1.ts";
import { SemanticError } from "../../src/errors.ts";

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) =>
    error instanceof SemanticError && error.code === code);
}

test("canonical objects sort keys while arrays preserve order", () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.equal(canonicalize([2, 1]), "[2,1]");
  assert.equal(canonicalize(-0), "0");
  assert.equal(canonicalize("中文"), '"中文"');
});

test("content references use an explicit hash domain separated by one NUL", () => {
  const value = { z: [true, null, -0], a: "中文" };
  assert.equal(canonicalize(value), '{"a":"中文","z":[true,null,0]}');
  assert.equal(
    contentRef("example/v1", value),
    "sha256:303e3cb6d8a5b9c6a3c7510067c6ecd35b93c73408c07f5892eef24b17f6258c",
  );
  assert.equal(
    contentRef("example/v2", value),
    "sha256:6e59c5ce7ef8e0b893ab9ddab7975cc617642862e27af8dbd900bbc43165fd6f",
  );
  assert.notEqual(contentRef("example/v1", value), contentRef("example/v2", value));
  expectCode(() => contentRef("", value), "INVALID_DOMAIN");
  expectCode(() => contentRef("example\0v1", value), "INVALID_DOMAIN");
});

test("canonicalization rejects ambiguous or executable JavaScript shapes", () => {
  expectCode(() => canonicalize(Number.NaN), "NON_FINITE_NUMBER");
  expectCode(() => canonicalize(Number.POSITIVE_INFINITY), "NON_FINITE_NUMBER");
  expectCode(() => canonicalize(new Array(1)), "SPARSE_ARRAY");

  const namedArray = [1];
  Object.defineProperty(namedArray, "extra", { value: 2, enumerable: true });
  expectCode(() => canonicalize(namedArray), "NON_CANONICAL_ARRAY_PROPERTY");

  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  expectCode(() => canonicalize(accessor), "NON_CANONICAL_PROPERTY");

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expectCode(() => canonicalize(cyclic), "CYCLIC_CANONICAL_VALUE");
  expectCode(() => canonicalize({ [Symbol.for("x")]: 1 }), "SYMBOL_FIELD");
  expectCode(() => canonicalize(new Date(0)), "NON_CANONICAL_OBJECT");
  expectCode(() => canonicalize("\ud800"), "UNPAIRED_SURROGATE");
  expectCode(() => canonicalize(undefined), "UNSUPPORTED_CANONICAL_VALUE");
  expectCode(() => canonicalize({ value: undefined }), "UNDEFINED_FIELD");
});

test("repeated sibling objects are valid but ancestor cycles are not", () => {
  const child = { n: 1 };
  assert.equal(
    canonicalize({ left: child, right: child }),
    '{"left":{"n":1},"right":{"n":1}}',
  );
});

test("immutable canonical copies are deeply frozen and caller-isolated", () => {
  const original = { nested: { value: 1 } };
  const frozen = immutableCanonicalCopy(original);
  original.nested.value = 2;
  assert.equal(canonicalize(frozen), '{"nested":{"value":1}}');
  assert.throws(() => {
    (frozen as { nested: { value: number } }).nested.value = 3;
  }, TypeError);
});
