import assert from "node:assert/strict";

import { SemanticError } from "../../src/errors.ts";

export function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SemanticError, "必须抛出 SemanticError");
    assert.equal(error.code, code);
    return true;
  });
}
