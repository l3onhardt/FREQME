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

test("rejects pure ambient electronic bridges inside an explicit R&B contract", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Jon Hopkins ambient electronic deep",
    candidate: song("A Drifting Down", "Jon Hopkins"),
    fallbackLevel: "episode_backup",
    itemStyle: "ambient electronic",
  });

  assert.equal(decision.status, "reject_off_contract");
});

test("rejects modern classical instrumental fallbacks inside an explicit R&B contract", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Max Richter On the Nature of Daylight",
    candidate: song("On the Nature of Daylight", "Max Richter"),
    fallbackLevel: "episode_backup",
    itemStyle: "modern classical instrumental",
  });

  assert.equal(decision.status, "reject_off_contract");
});

test("rejects unlabeled electronic remixes inside an explicit R&B contract", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Crave You Adventure Club Remix",
    candidate: song("Crave You (Adventure Club Remix)", "Flight Facilities"),
    fallbackLevel: "episode_primary",
    itemStyle: "late-night crossover",
  });

  assert.equal(decision.status, "reject_off_contract");
});

test("rejects generic electronic bridges while R&B is the active contract", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "soft electronic interlude",
    candidate: song("Open Eye Signal", "Jon Hopkins"),
    fallbackLevel: "episode_backup",
    itemStyle: "electronic",
  });

  assert.equal(decision.status, "reject_off_contract");
});

test("rejects piano ambient continuations inside an explicit R&B contract", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract,
    query: "Nils Frahm Says",
    candidate: song("Says", "Nils Frahm"),
    fallbackLevel: "episode_primary",
    itemStyle: "piano ambient",
  });

  assert.equal(decision.status, "reject_off_contract");
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

  assert.equal(decision.status, "reject_off_contract");
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

test("generic station contracts reject explicitly blocked styles", () => {
  const guard = new BoundaryGuard();
  const decision = guard.evaluate({
    contract: {
      ...contract,
      id: "folk-contract",
      mainDirection: "quiet late-night folk",
      rawUserText: "play quiet folk",
      allowedAdjacent: ["soft indie folk", "acoustic singer-songwriter"],
      disallowed: ["high-energy EDM", "festival drops"],
      positiveSeeds: ["quiet folk"],
      negativeConstraints: ["high-energy EDM", "festival drops"],
    },
    query: "Martin Garrix Animals",
    candidate: song("Animals", "Martin Garrix"),
    fallbackLevel: "scheduler",
    itemStyle: "high-energy EDM",
  });

  assert.equal(decision.status, "reject_off_contract");
});

test("generic jazz station contracts reject unrelated recent-playable fallbacks", () => {
  const guard = new BoundaryGuard();
  const quietJazzContract = {
    ...contract,
    id: "quiet-jazz-contract",
    mainDirection: "quiet jazz for reading",
    rawUserText: "play quiet jazz for reading",
    allowedAdjacent: ["soft jazz piano", "ambient jazz instrumentals", "light acoustic jazz"],
    disallowed: ["upbeat jazz", "vocal jazz", "electronic remixes", "dance tracks"],
    positiveSeeds: ["quiet jazz for reading"],
    negativeConstraints: ["upbeat jazz", "vocal jazz", "electronic remixes", "dance tracks"],
  };

  const rejected = guard.evaluate({
    contract: quietJazzContract,
    query: "recent playable fallback",
    candidate: song("飞飞飞", "LegoG"),
    fallbackLevel: "recent_verified",
  });
  const accepted = guard.evaluate({
    contract: quietJazzContract,
    query: "quiet jazz piano for reading",
    candidate: song("Italian Dinner Background Music", "Jazz Piano Bar Academy"),
    fallbackLevel: "recent_verified",
    itemStyle: "soft jazz piano",
  });

  assert.equal(rejected.status, "reject_off_contract");
  assert.equal(accepted.status, "accept_as_adjacent");
});

test("generic jazz station contracts do not let quiet-jazz query text launder off-contract tracks", () => {
  const guard = new BoundaryGuard();
  const quietJazzContract = {
    ...contract,
    id: "quiet-jazz-contract",
    mainDirection: "quiet jazz for reading",
    rawUserText: "play quiet jazz for reading",
    allowedAdjacent: ["soft jazz piano", "ambient jazz instrumentals", "light acoustic jazz"],
    disallowed: ["electronic remixes", "dance tracks"],
    positiveSeeds: ["quiet jazz for reading"],
    negativeConstraints: ["electronic remixes", "dance tracks"],
  };

  const altRnb = guard.evaluate({
    contract: quietJazzContract,
    query: "quiet jazz continuation",
    candidate: song("Frank Ocean - White Ferrari (MyClosest remake)", "MyClosest"),
    fallbackLevel: "recent_verified",
    itemStyle: "quiet jazz continuation",
  });
  const melodicElectronic = guard.evaluate({
    contract: quietJazzContract,
    query: "quiet jazz continuation",
    candidate: song("Beyond Beliefs (Cold Blue Rework)", "Ben Bohmer"),
    fallbackLevel: "recent_verified",
    itemStyle: "quiet jazz continuation",
  });

  assert.equal(altRnb.status, "reject_off_contract");
  assert.equal(melodicElectronic.status, "reject_off_contract");
});

test("generic jazz station contracts do not let search source text launder off-contract tracks", () => {
  const guard = new BoundaryGuard();
  const quietJazzContract = {
    ...contract,
    id: "quiet-jazz-contract",
    mainDirection: "quiet jazz for reading",
    rawUserText: "play quiet jazz for reading",
    allowedAdjacent: ["soft jazz piano", "ambient jazz instrumentals", "light acoustic jazz"],
    disallowed: ["electronic remixes", "dance tracks"],
    positiveSeeds: ["quiet jazz for reading"],
    negativeConstraints: ["electronic remixes", "dance tracks"],
  };

  const decision = guard.evaluate({
    contract: quietJazzContract,
    query: "recent playable fallback",
    candidate: {
      ...song("Frank Ocean - White Ferrari (MyClosest remake)", "MyClosest"),
      source: "quiet jazz for reading",
    },
    fallbackLevel: "recent_verified",
  });

  assert.equal(decision.status, "reject_off_contract");
});
