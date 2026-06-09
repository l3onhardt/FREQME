import assert from "node:assert/strict";
import test from "node:test";

import { HostNarrationLayer } from "../../src/radio/hostNarrationLayer.js";
import type { BoundaryDecision, StationContract } from "../../src/radio/radioBrainTypes.js";

const contract: StationContract = {
  id: "contract-1",
  mainDirection: "late-night R&B",
  rawUserText: "放点深夜听的 rnb",
  allowedAdjacent: ["alt-R&B"],
  softBridge: ["ambient electronic"],
  disallowed: ["classical chamber music"],
  positiveSeeds: ["R&B"],
  negativeConstraints: [],
  driftBudget: 1,
  bridgeCount: 0,
  mustReturnToContract: false,
  hostStyle: "standard",
  createdAt: "2026-06-02T00:00:00.000Z",
  updatedAt: "2026-06-02T00:00:00.000Z",
};

const vagueContinuationContract: StationContract = {
  ...contract,
  id: "contract-vague",
  mainDirection: "继续保持这个感觉",
  rawUserText: "继续保持这个感觉",
  positiveSeeds: ["继续保持这个感觉"],
};

const internalTerms =
  /profile|algorithm|model|candidate|trace|JSON|verification|boundary|contract|边界|合约|候选|画像|算法|模型|验证|轨迹/i;
const awkwardNarrationTerms = /旁边|质感|空间感|贴近|主线还是|继续保持这个感觉|当前电台方向/;
const mojibakeTerms = /鎴|杩|銆|鐨|鍚|涓|浣|绾|俙|紝/;
const awkwardChineseSpacing = /\u300b\s+[\u4e00-\u9fff]/u;

test("narrates bridge entry in listener-facing language", async () => {
  const layer = new HostNarrationLayer();
  const boundary: BoundaryDecision = { status: "accept_as_bridge", reason: "Allowed bridge", contractId: contract.id };
  const result = await layer.forQueueItem({
    stationContract: contract,
    boundaryDecision: boundary,
    track: { id: "jon", name: "A Drifting Down", artist: "Jon Hopkins" },
    reason: "ambient electronic bridge",
    recentNarrationCount: 0,
  });

  assert.equal(result.shouldSpeak, true);
  assert.equal(result.event, "bridge_entered");
  assert.match(result.text, /过渡|拉回|R&B/i);
  assert.doesNotMatch(result.text, internalTerms);
  assert.doesNotMatch(result.text, awkwardNarrationTerms);
  assert.doesNotMatch(result.text, mojibakeTerms);
});

test("suppresses ordinary on-contract continuations", async () => {
  const layer = new HostNarrationLayer();
  const result = await layer.forQueueItem({
    stationContract: contract,
    boundaryDecision: { status: "accept", reason: "fits", contractId: contract.id },
    track: { id: "rnb", name: "Pink + White", artist: "Frank Ocean" },
    reason: "fits contract",
    recentNarrationCount: 1,
  });

  assert.equal(result.shouldSpeak, false);
  assert.equal(result.text, "");
});

test("narrates adjacent moves sparingly", async () => {
  const layer = new HostNarrationLayer();
  const result = await layer.forQueueItem({
    stationContract: contract,
    boundaryDecision: { status: "accept_as_adjacent", reason: "nearby texture", contractId: contract.id },
    track: { id: "adjacent", name: "Softly", artist: "Adjacent Artist" },
    reason: "nearby texture",
    recentNarrationCount: 0,
  });

  assert.equal(result.shouldSpeak, true);
  assert.equal(result.event, "direction_changed");
  assert.match(result.text, /late-night R&B/i);
  assert.doesNotMatch(result.text, internalTerms);
  assert.doesNotMatch(result.text, awkwardNarrationTerms);
  assert.doesNotMatch(result.text, mojibakeTerms);
});

test("narrates adjacent moves naturally when no concrete direction is available", async () => {
  const layer = new HostNarrationLayer();
  const result = await layer.forQueueItem({
    stationContract: null,
    boundaryDecision: { status: "accept_as_adjacent", reason: "nearby texture", contractId: contract.id },
    track: { id: "adjacent-empty-direction", name: "Says", artist: "Nils Frahm" },
    reason: "nearby texture",
    recentNarrationCount: 0,
  });

  assert.equal(result.shouldSpeak, true);
  assert.equal(result.event, "direction_changed");
  assert.match(result.text, /Nils Frahm|Says/);
  assert.doesNotMatch(result.text, internalTerms);
  assert.doesNotMatch(result.text, awkwardNarrationTerms);
  assert.doesNotMatch(result.text, mojibakeTerms);
  assert.doesNotMatch(result.text, awkwardChineseSpacing);
});

test("does not read vague continuation text aloud as the station direction", async () => {
  const layer = new HostNarrationLayer();
  const result = await layer.forQueueItem({
    stationContract: vagueContinuationContract,
    boundaryDecision: { status: "accept_as_adjacent", reason: "nearby texture", contractId: vagueContinuationContract.id },
    track: { id: "adjacent", name: "Says", artist: "Nils Frahm" },
    reason: "nearby texture",
    recentNarrationCount: 0,
  });

  assert.equal(result.shouldSpeak, true);
  assert.equal(result.event, "direction_changed");
  assert.doesNotMatch(result.text, /继续保持这个感觉|主线还是|当前电台方向/);
  assert.doesNotMatch(result.text, internalTerms);
  assert.doesNotMatch(result.text, mojibakeTerms);
});

test("acknowledges station direction without internal terms", () => {
  const layer = new HostNarrationLayer();
  const text = layer.requestAck(contract);

  assert.match(text, /late-night R&B/i);
  assert.match(text, /守住|避开|人声|律动/);
  assert.doesNotMatch(text, internalTerms);
  assert.doesNotMatch(text, awkwardNarrationTerms);
  assert.doesNotMatch(text, mojibakeTerms);
  assert.ok(text.length <= 120);
});
