import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const serverSource = readFileSync(path.resolve("src/server.ts"), "utf8");

test("server wires station contract manager and boundary guard into radio brain", () => {
  assert.match(serverSource, /import \{ StationContractManager \} from "\.\/radio\/stationContract\.js";/);
  assert.match(serverSource, /import \{ BoundaryGuard \} from "\.\/radio\/boundaryGuard\.js";/);
  assert.match(serverSource, /const stationContractManager = new StationContractManager\(\);/);
  assert.match(serverSource, /const boundaryGuard = new BoundaryGuard\(\);/);
  assert.match(serverSource, /const queueWarmer = new QueueWarmer\(searchVerifyAgent, traceStore, boundaryGuard(?:,\s*\w+)?\);/);
  assert.match(serverSource, /contractManager: stationContractManager,/);
});
