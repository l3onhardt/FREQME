import assert from "node:assert/strict";
import test from "node:test";

import { ContractController } from "../../src/radio-agent/contractController.js";
import type { AgentSessionContract } from "../../src/radio-agent/contractController.js";
import type { RadioAgentProgramWindow } from "../../src/radio-agent/types.js";

const NOW = "2026-06-16T00:00:00.000Z";

test("explicit listener direction creates a session contract immediately", () => {
  const controller = new ContractController({ now: () => NOW });
  const contract = controller.fromUserDirection({
    uid: null,
    sessionId: -1,
    text: "play quiet jazz for reading",
    sourceEventId: "event-1",
  });

  assert.equal(contract.rawUserText, "play quiet jazz for reading");
  assert.match(contract.stationBrief, /quiet jazz/i);
  assert.equal(contract.sourceEventId, "event-1");
});

test("not-found does not clear active contract", () => {
  const controller = new ContractController({ now: () => NOW });
  const contract = controller.fromUserDirection({ uid: null, sessionId: -1, text: "play rnb", sourceEventId: "event-1" });

  const retained = controller.recordNotFound(contract, { searchedQueries: ["Daniel Caesar Japanese Denim"] });

  assert.equal(retained.id, contract.id);
  assert.equal(retained.status, "active");
});

test("correction replaces incompatible contract and records repair reason", () => {
  const controller = new ContractController({ now: () => NOW });
  const contract = controller.fromUserDirection({
    uid: "42",
    sessionId: 7,
    text: "play quiet jazz for reading",
    sourceEventId: "event-1",
  });

  const repaired = controller.repairFromCorrection(contract, {
    text: "actually make it late-night R&B",
    sourceEventId: "event-2",
    reason: "listener changed from quiet jazz to late-night R&B",
  });

  assert.notEqual(repaired.id, contract.id);
  assert.equal(repaired.repairedFrom, contract.id);
  assert.equal(repaired.status, "active");
  assert.equal(repaired.rawUserText, "actually make it late-night R&B");
  assert.match(repaired.stationBrief, /R&B/i);
  assert.deepEqual(repaired.positiveAnchors, ["R&B", "alt-R&B", "neo-soul", "soul"]);
  assert.equal(contract.status, "active");
});

test("contract markdown round-trips fields used by runtime artifacts", () => {
  const controller = new ContractController({ now: () => NOW });
  const contract: AgentSessionContract = {
    id: "contract-1",
    uid: "42",
    sessionId: 7,
    rawUserText: "play quiet jazz for reading",
    stationBrief: "Quiet jazz for reading.",
    positiveAnchors: ["jazz", "soft jazz piano", "light acoustic jazz"],
    disallowed: ["festival EDM", "hard rock"],
    allowedAdjacent: ["cool jazz", "soft vocal jazz"],
    bridgeBudget: 1,
    returnRequirement: "Return to quiet jazz after one adjacent step.",
    sourceEventId: "event-1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };

  const roundTripped = controller.fromMarkdown(controller.toProgramContractMarkdown(contract));

  assert.equal(roundTripped.id, contract.id);
  assert.equal(roundTripped.uid, contract.uid);
  assert.equal(roundTripped.sessionId, contract.sessionId);
  assert.equal(roundTripped.sourceEventId, contract.sourceEventId);
  assert.equal(roundTripped.createdAt, contract.createdAt);
  assert.equal(roundTripped.updatedAt, contract.updatedAt);
  assert.equal(roundTripped.status, contract.status);
  assert.equal(roundTripped.rawUserText, contract.rawUserText);
  assert.equal(roundTripped.stationBrief, contract.stationBrief);
  assert.deepEqual(roundTripped.positiveAnchors, contract.positiveAnchors);
  assert.deepEqual(roundTripped.disallowed, contract.disallowed);
  assert.deepEqual(roundTripped.allowedAdjacent, contract.allowedAdjacent);
  assert.equal(roundTripped.bridgeBudget, contract.bridgeBudget);
  assert.equal(roundTripped.returnRequirement, contract.returnRequirement);
});

test("program window can seed a session contract", () => {
  const controller = new ContractController({ now: () => NOW });

  const contract = controller.fromProgramWindow(radioWindow({ id: "window-1", sourceEventId: undefined }));

  assert.equal(contract.id, "window-1");
  assert.equal(contract.sourceEventId, "window-1");
  assert.equal(contract.rawUserText, "quiet jazz for reading");
  assert.equal(contract.stationBrief, "Quiet jazz for reading.");
  assert.deepEqual(contract.allowedAdjacent, ["cool jazz"]);
  assert.deepEqual(contract.disallowed, ["festival EDM"]);
  assert.equal(contract.bridgeBudget, 1);
  assert.equal(contract.returnRequirement, "Return to quiet jazz after one bridge.");
});

function radioWindow(
  overrides: Partial<RadioAgentProgramWindow> & { sourceEventId?: string | undefined },
): RadioAgentProgramWindow & { sourceEventId?: string | undefined } {
  return {
    id: "window-1",
    uid: "42",
    sessionId: 7,
    stationBrief: "Quiet jazz for reading.",
    mainDirection: "quiet jazz for reading",
    allowedAdjacent: ["cool jazz"],
    bridgeBudget: 1,
    disallowed: ["festival EDM"],
    returnRequirement: "Return to quiet jazz after one bridge.",
    candidateTasks: [],
    hostIntent: { shouldSpeak: false, event: "silent", reason: "test", text: "" },
    traceBasis: { profile: "", now: "", contract: "", eventType: "user_text" },
    source: "model",
    createdAt: NOW,
    ...overrides,
  };
}
