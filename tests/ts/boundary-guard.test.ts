import assert from "node:assert/strict";
import test from "node:test";

import { BoundaryGuard } from "../../src/radio/boundaryGuard.js";
import type { StationContract } from "../../src/radio/radioBrainTypes.js";
import type { Track } from "../../src/types.js";

const contract: StationContract = {
  id: "contract-1",
  mainDirection: "late-night R&B",
  rawUserText: "放点深夜听的rnb",
  allowedAdjacent: ["alt-R&B", "neo-soul", "soft vocal", "downtempo", "R&B-adjacent electronic"],
  softBridge: ["ambient electronic", "piano ambient"],
  disallowed: ["classical chamber music", "pure classical piano", "high-energy EDM"],
  positiveSeeds: ["R&B", "深夜"],
  negativeConstraints: [],
  driftBudget: 1,
  bridgeCount: 0,
  mustReturnToContract: false,
  hostStyle: "standard",
  createdAt: "2026-06-02T00:00:00.000Z",
  updatedAt: "2026-06-02T00:00:00.000Z",
};

function song(name: string, artist: string): Track {
  return { id: `${artist}-${name}`, name, artist };
}

test("rejects classical chamber music inside late-night R&B contract", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Max Richter piano ambient instrumental",
    candidate: song("Piano Quintet No. 2 in C Minor, Op. 64:II. Vivace (Live)", "Sviatoslav Richter"),
    fallbackLevel: "episode_backup",
    itemStyle: "piano ambient",
  });

  assert.equal(decision.status, "reject_entity_mismatch");
});

test("allows one ambient electronic bridge", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Jon Hopkins ambient electronic deep",
    candidate: song("A Drifting Down", "Jon Hopkins"),
    fallbackLevel: "episode_backup",
    itemStyle: "ambient electronic",
  });

  assert.equal(decision.status, "accept_as_bridge");
});

test("allows generic electronic bridges while budget remains", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "soft electronic interlude",
    candidate: song("Open Eye Signal", "Jon Hopkins"),
    fallbackLevel: "episode_backup",
    itemStyle: "electronic",
  });

  assert.equal(decision.status, "accept_as_bridge");
});

test("rejects generic piano bridges after bridge budget is used", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract: { ...contract, bridgeCount: 1, driftBudget: 1 },
    query: "soft piano interlude",
    candidate: song("Near Light", "Olafur Arnalds"),
    fallbackLevel: "episode_backup",
    itemStyle: "piano",
  });

  assert.equal(decision.status, "reject_off_contract");
});

test("keeps electronic R&B on contract after bridge budget is used", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract: { ...contract, bridgeCount: 1, driftBudget: 1 },
    query: "SZA electronic R&B",
    candidate: song("Good Days", "SZA"),
    fallbackLevel: "episode_primary",
    itemStyle: "electronic R&B",
  });

  assert.equal(decision.status, "accept");
});

test("does not let R&B query text make an off-contract candidate return to contract", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract: { ...contract, bridgeCount: 1, driftBudget: 1, mustReturnToContract: true },
    query: "SZA electronic R&B",
    candidate: song("Open Eye Signal", "Jon Hopkins"),
    fallbackLevel: "episode_backup",
    itemStyle: "electronic R&B",
  });

  assert.equal(decision.status, "reject_off_contract");
});

test("does not treat unrelated words containing her as H.E.R.", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Other Lives quiet indie",
    candidate: song("For 12", "Other Lives"),
    fallbackLevel: "episode_primary",
    itemStyle: "indie folk",
  });

  assert.notEqual(decision.status, "accept");
});

test("requires return to R&B while mustReturnToContract is active", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract: { ...contract, bridgeCount: 1, mustReturnToContract: true },
    query: "quiet adjacent indie soul",
    candidate: song("For 12", "Other Lives"),
    fallbackLevel: "episode_backup",
    itemStyle: "indie folk",
  });

  assert.equal(decision.status, "reject_off_contract");
});
