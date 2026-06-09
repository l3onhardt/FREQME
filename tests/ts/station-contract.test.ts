import assert from "node:assert/strict";
import test from "node:test";

import { StationContractManager } from "../../src/radio/stationContract.js";
import type { ListeningIntentDecision } from "../../src/radio/radioBrainTypes.js";

function intent(overrides: Partial<ListeningIntentDecision> = {}): ListeningIntentDecision {
  return {
    type: "music_direction_request",
    rawText: "放点深夜听的rnb",
    query: "",
    positiveSeeds: ["R&B", "深夜"],
    negativeConstraints: [],
    shouldReplan: true,
    shouldClearQueue: true,
    shouldExplain: false,
    confidence: "high",
    ackText: "收到，我按这个方向重新排接下来的几首。",
    ...overrides,
  };
}

test("creates a late-night R&B station contract from direction intent", () => {
  const manager = new StationContractManager();
  const contract = manager.update(null, intent());

  assert.equal(contract.mainDirection.toLowerCase().includes("r&b"), true);
  assert.ok(contract.allowedAdjacent.some((item) => /alt|neo|soul|downtempo|electronic/i.test(item)));
  assert.ok(contract.disallowed.some((item) => /classical|古典/i.test(item)));
  assert.equal(contract.softBridge.some((item) => /ambient|piano/i.test(item)), false);
  assert.equal(contract.driftBudget, 1);
  assert.equal(contract.bridgeCount, 0);
  assert.equal(contract.mustReturnToContract, false);
});

test("correction merges negative constraints into the active contract", () => {
  const manager = new StationContractManager();
  const base = manager.update(null, intent());
  const updated = manager.update(
    base,
    intent({
      type: "correction",
      rawText: "不要古典，拉回人声rnb",
      positiveSeeds: ["人声R&B"],
      negativeConstraints: ["古典"],
      shouldClearQueue: true,
    }),
  );

  assert.ok(updated.negativeConstraints.includes("古典"));
  assert.ok(updated.disallowed.some((item) => item.includes("古典")));
  assert.match(updated.mainDirection, /R&B|r&b/i);
});

test("negative-only correction preserves active main direction", () => {
  const manager = new StationContractManager();
  const base = manager.update(null, intent());
  const updated = manager.update(
    base,
    intent({
      type: "correction",
      rawText: "不要古典",
      positiveSeeds: [],
      negativeConstraints: ["古典"],
      query: "",
      shouldClearQueue: true,
    }),
  );

  assert.equal(updated.mainDirection, base.mainDirection);
  assert.ok(updated.negativeConstraints.includes("古典"));
  assert.ok(updated.disallowed.some((item) => item.includes("古典")));
});

test("negative-only correction preserves active raw user text", () => {
  const manager = new StationContractManager();
  const base = manager.update(null, intent());
  const updated = manager.update(
    base,
    intent({
      type: "correction",
      rawText: "不要古典",
      positiveSeeds: [],
      negativeConstraints: ["古典"],
      query: "",
    }),
  );

  assert.equal(updated.rawUserText, base.rawUserText);
  assert.equal(updated.rawUserText, "放点深夜听的rnb");
});

test("new music direction request resets stale R&B contract rules", () => {
  const manager = new StationContractManager({
    now: () => "2026-06-02T00:00:00.000Z",
    idFactory: (_intent, mainDirection) => `station-${mainDirection}`,
  });
  const base = manager.update(null, intent());

  assert.ok(base.disallowed.includes("high-energy EDM"));

  const updated = manager.update(
    base,
    intent({
      type: "music_direction_request",
      rawText: "放点高能电子",
      positiveSeeds: ["高能量", "电子"],
      negativeConstraints: [],
    }),
  );

  assert.match(updated.mainDirection, /高能量|电子/);
  assert.equal(updated.disallowed.includes("high-energy EDM"), false);
  assert.equal(updated.allowedAdjacent.some((item) => /alt-R&B|neo-soul|R&B-adjacent electronic/i.test(item)), false);
  assert.equal(updated.positiveSeeds.includes("R&B"), false);
  assert.equal(updated.positiveSeeds.includes("深夜"), false);
  assert.deepEqual(updated.negativeConstraints, []);
});

test("negated R&B feedback does not add R&B adjacent defaults", () => {
  const manager = new StationContractManager({
    now: () => "2026-06-02T00:00:00.000Z",
    idFactory: (_intent, mainDirection) => `station-${mainDirection}`,
  });
  const base = manager.update(
    null,
    intent({
      type: "music_direction_request",
      rawText: "放点高能电子",
      positiveSeeds: ["高能量", "电子"],
      negativeConstraints: [],
    }),
  );

  const updated = manager.update(
    base,
    intent({
      type: "negative_feedback",
      rawText: "不要 R&B",
      positiveSeeds: [],
      negativeConstraints: ["R&B"],
    }),
  );

  assert.ok(updated.negativeConstraints.includes("R&B"));
  assert.ok(updated.disallowed.includes("R&B"));
  assert.equal(updated.allowedAdjacent.some((item) => /alt-R&B|neo-soul|R&B-adjacent electronic/i.test(item)), false);
  assert.equal(updated.softBridge.some((item) => /ambient electronic|piano ambient/i.test(item)), false);
});

test("default manager uses runtime timestamps rather than the epoch placeholder", () => {
  const manager = new StationContractManager();
  const contract = manager.update(null, intent());

  assert.notEqual(contract.createdAt, "1970-01-01T00:00:00.000Z");
  assert.match(contract.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("can produce stable contracts with deterministic dependencies", () => {
  const manager = new StationContractManager({
    now: () => "2026-06-02T00:00:00.000Z",
    idFactory: () => "station-contract-1",
  });

  const first = manager.update(null, intent());
  const second = manager.update(null, intent());

  assert.deepEqual(first, second);
  assert.equal(first.id, "station-contract-1");
  assert.equal(first.createdAt, "2026-06-02T00:00:00.000Z");
  assert.equal(first.updatedAt, "2026-06-02T00:00:00.000Z");
});

test("preserves createdAt and updates updatedAt with injected clock", () => {
  const times = ["2026-06-02T00:00:00.000Z", "2026-06-02T00:01:00.000Z"];
  const manager = new StationContractManager({
    now: () => times.shift() || "2026-06-02T00:02:00.000Z",
    idFactory: () => "station-contract-1",
  });

  const base = manager.update(null, intent());
  const updated = manager.update(
    base,
    intent({
      type: "negative_feedback",
      rawText: "不要古典",
      positiveSeeds: [],
      negativeConstraints: ["古典"],
    }),
  );

  assert.equal(updated.createdAt, "2026-06-02T00:00:00.000Z");
  assert.equal(updated.updatedAt, "2026-06-02T00:01:00.000Z");
});
