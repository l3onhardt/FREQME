import assert from "node:assert/strict";
import test from "node:test";

import { agentContractForGovernor } from "../../src/radio-agent/legacyContract.js";
import type { StationContract } from "../../src/radio/radioBrainTypes.js";

test("agentContractForGovernor preserves active station contract constraints for fallback governance", () => {
  const stationContract: StationContract = {
    id: "station-contract-1",
    mainDirection: "late-night R&B vocals",
    rawUserText: "play rnb",
    allowedAdjacent: ["neo-soul"],
    softBridge: ["quiet vocal pop"],
    disallowed: ["classical chamber drift"],
    positiveSeeds: ["R&B", "alt-R&B"],
    negativeConstraints: ["festival EDM"],
    driftBudget: 1,
    bridgeCount: 0,
    mustReturnToContract: true,
    hostStyle: "standard",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:01:00.000Z",
  };

  const contract = agentContractForGovernor(stationContract, { uid: "u1", sessionId: 9 });

  assert.equal(contract?.id, "station-contract-1");
  assert.equal(contract?.uid, "u1");
  assert.equal(contract?.sessionId, 9);
  assert.equal(contract?.rawUserText, "play rnb");
  assert.equal(contract?.stationBrief, "late-night R&B vocals");
  assert.deepEqual(contract?.positiveAnchors, ["R&B", "alt-R&B"]);
  assert.deepEqual(contract?.allowedAdjacent, ["neo-soul", "quiet vocal pop"]);
  assert.deepEqual(contract?.disallowed, ["classical chamber drift", "festival EDM"]);
  assert.equal(contract?.bridgeBudget, 1);
  assert.equal(contract?.returnRequirement, "Return to late-night R&B vocals after any adjacent step.");
});
