import assert from "node:assert/strict";
import test from "node:test";

import { runtimeStatus } from "../../src/runtimeStatus.js";

test("runtime status reports readiness without exposing secret values", () => {
  const status = runtimeStatus();
  const serialized = JSON.stringify(status);

  assert.match(status.status, /^(ready|degraded)$/);
  assert.equal(status.checks.database, "ok");
  assert.equal(status.checks.netease, "lazy");
  assert.equal(serialized.includes("tp-"), false);
});
