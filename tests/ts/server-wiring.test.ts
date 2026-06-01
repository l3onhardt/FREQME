import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const serverSource = readFileSync(path.resolve("src/server.ts"), "utf8");

test("server wires station contract manager and boundary guard into radio brain", () => {
  assert.match(serverSource, /import \{ StationContractManager \} from "\.\/radio\/stationContract\.js";/);
  assert.match(serverSource, /import \{ BoundaryGuard \} from "\.\/radio\/boundaryGuard\.js";/);
  assert.match(serverSource, /import \{ HostNarrationLayer \} from "\.\/radio\/hostNarrationLayer\.js";/);
  assert.match(serverSource, /const stationContractManager = new StationContractManager\(\);/);
  assert.match(serverSource, /const boundaryGuard = new BoundaryGuard\(\);/);
  assert.match(serverSource, /const hostNarrationLayer = new HostNarrationLayer\(\);/);
  assert.match(serverSource, /const queueWarmer = new QueueWarmer\(searchVerifyAgent, traceStore, boundaryGuard, hostNarrationLayer\);/);
  assert.match(serverSource, /contractManager: stationContractManager,/);
});

test("server sends late TTS updates for segue narration without blocking promotion", () => {
  assert.match(serverSource, /const sendLateSegueTts = \(/);
  assert.match(serverSource, /send\(\{\s*type: "segue",\s*segue_id: segueId,\s*text,\s*tts_ready: true,\s*tts_hash: hash,/s);
  assert.match(serverSource, /if \(item\.segueText\) \{\s*const segueId = /s);
  assert.match(serverSource, /if \(!item\.ttsHash\) sendLateSegueTts\(segueId, item\.segueText, item\.track, item\.url\);/);
});
