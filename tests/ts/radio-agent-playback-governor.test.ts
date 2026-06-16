import assert from "node:assert/strict";
import test from "node:test";

import { BoundaryGuard } from "../../src/radio/boundaryGuard.js";
import { PlaybackGovernor, trackKey } from "../../src/radio-agent/playbackGovernor.js";
import type {
  AgentSessionContract,
  ModelSemanticFitEvaluator,
  PlaybackGovernorArgs,
  SeedState,
} from "../../src/radio-agent/playbackGovernor.js";
import type { Track } from "../../src/types.js";

const NOW = "2026-06-16T00:00:00.000Z";

function rnbContract(overrides: Partial<AgentSessionContract> = {}): AgentSessionContract {
  return {
    id: "contract-rnb",
    uid: "42",
    sessionId: 7,
    rawUserText: "play rnb",
    stationBrief: "late-night R&B.",
    positiveAnchors: ["R&B", "alt-R&B", "neo-soul", "soul"],
    disallowed: ["classical chamber drift", "high energy EDM"],
    allowedAdjacent: ["quiet vocal pop"],
    bridgeBudget: 1,
    returnRequirement: "Return to R&B after any adjacent step.",
    sourceEventId: "event-1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function jazzContract(overrides: Partial<AgentSessionContract> = {}): AgentSessionContract {
  return {
    id: "contract-jazz",
    uid: "42",
    sessionId: 7,
    rawUserText: "play quiet jazz for reading",
    stationBrief: "quiet jazz for reading.",
    positiveAnchors: ["jazz", "soft jazz piano", "light acoustic jazz"],
    disallowed: ["electronic remixes", "dance tracks"],
    allowedAdjacent: ["cool jazz", "small-combo jazz"],
    bridgeBudget: 1,
    returnRequirement: "Return to quiet jazz after one adjacent step.",
    sourceEventId: "event-1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function song(id: string, name: string, artist: string, extra: Partial<Track> = {}): Track {
  return { id, name, artist, ...extra };
}

function playableAudio(): Promise<{ ok: true }> {
  return Promise.resolve({ ok: true });
}

function unplayableAudio(): Promise<{ ok: false; reason: string }> {
  return Promise.resolve({ ok: false, reason: "404" });
}

function emptySeedState(overrides: Partial<SeedState> = {}): SeedState {
  return { ...overrides };
}

function governor(overrides: Partial<ConstructorParameters<typeof PlaybackGovernor>[0]> = {}): PlaybackGovernor {
  return new PlaybackGovernor({
    boundaryGuard: new BoundaryGuard(),
    resolveAudio: playableAudio,
    ...overrides,
  });
}

function baseArgs(overrides: Partial<PlaybackGovernorArgs> = {}): PlaybackGovernorArgs {
  return {
    contract: rnbContract(),
    requestToken: 1,
    activeRequestToken: 1,
    candidate: song("sza-good-days", "Good Days", "SZA"),
    url: "/api/radio/audio/sza-good-days",
    currentTrack: null,
    recentTracks: [],
    readyQueue: [],
    seedState: emptySeedState(),
    hostText: "I will keep this in R&B.",
    ...overrides,
  };
}

test("governor accepts direct positive evidence inside active contract", async () => {
  const result = await governor().evaluate(baseArgs());

  assert.equal(result.status, "accepted");
  assert.equal(result.trace.status, "accepted");
  assert.equal(result.trace.contractId, "contract-rnb");
  assert.equal(result.trace.candidateKey, "sza::gooddays");
  assert.equal(result.trace.decision, "direct_positive");
  assert.ok(result.trace.evidence.some((item) => /boundary/i.test(item)));
});

test("governor rejects stale request token before audio or model evaluation", async () => {
  let audioCalls = 0;
  let semanticCalls = 0;
  const semantic: ModelSemanticFitEvaluator = {
    async evaluate() {
      semanticCalls += 1;
      return { accepted: true, evidence: ["semantic fit"] };
    },
  };
  const result = await governor({
    resolveAudio: async () => {
      audioCalls += 1;
      return { ok: true };
    },
    semanticEvaluator: semantic,
  }).evaluate(baseArgs({ requestToken: 1, activeRequestToken: 2 }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_stale_request");
  assert.equal(audioCalls, 0);
  assert.equal(semanticCalls, 0);
});

test("governor rejects same current track id", async () => {
  const currentTrack = song("sza-good-days", "Good Days", "SZA");

  const result = await governor().evaluate(baseArgs({ currentTrack }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_duplicate_recent");
});

test("governor rejects normalized artist title duplicates in the recent window", async () => {
  const result = await governor().evaluate(baseArgs({
    candidate: song("alt-id", "Good Days", "SZA"),
    recentTracks: [
      song("old-1", "Other", "Artist"),
      song("old-2", "Good Days", "SZA"),
    ],
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_duplicate_recent");
});

test("governor rejects remix or remake metadata that repeats a recent original recording", async () => {
  const result = await governor().evaluate(baseArgs({
    candidate: song("489877341", "frank ocean - pinkpuss\uff08pink \uff0bwhite remix\uff09", "LegoG"),
    currentTrack: song("426194883", "Pink + White", "Frank Ocean"),
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_duplicate_recent");
});

test("governor rejects duplicate ready queue items", async () => {
  const result = await governor().evaluate(baseArgs({
    readyQueue: [
      { track: song("queued-alt", "Good Days", "SZA") },
    ],
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_duplicate_ready");
});

test("governor rejects off-contract candidate under active explicit contract", async () => {
  const result = await governor().evaluate(baseArgs({
    candidate: song("richter", "Piano Quintet No. 2 in C Minor, Op. 64:II. Vivace (Live)", "Sviatoslav Richter"),
    url: "/api/radio/audio/richter",
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_off_contract");
});

test("governor rejects explicit hard blocks before semantic evaluation", async () => {
  let semanticCalls = 0;
  const semantic: ModelSemanticFitEvaluator = {
    async evaluate() {
      semanticCalls += 1;
      return { accepted: true, evidence: ["semantic fit"] };
    },
  };

  const result = await governor({ semanticEvaluator: semantic }).evaluate(baseArgs({
    candidate: song("edm", "High Energy EDM Mix", "Festival Producer"),
    url: "/api/radio/audio/edm",
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_hard_block");
  assert.equal(semanticCalls, 0);
});

test("governor does not treat query or source provenance as positive fit evidence", async () => {
  const result = await governor().evaluate(baseArgs({
    contract: jazzContract(),
    candidate: song("frank-remake", "Frank Ocean - White Ferrari (MyClosest remake)", "MyClosest", {
      source: "quiet jazz for reading",
    }),
    query: "quiet jazz for reading continuation",
    url: "/api/radio/audio/frank-remake",
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_off_contract");
});

test("governor accepts explicit registry style evidence", async () => {
  const result = await governor().evaluate(baseArgs({
    candidate: song("registry-fit", "Velvet Late Night", "Obscure Singer"),
    url: "/api/radio/audio/registry-fit",
    registryStyleEvidence: ["style registry matched neo-soul marker"],
  }));

  assert.equal(result.status, "accepted");
  assert.equal(result.trace.decision, "registry_style");
  assert.deepEqual(result.trace.evidence, ["style registry matched neo-soul marker"]);
});

test("governor rejects audio resolution failure before semantic acceptance", async () => {
  let semanticCalls = 0;
  const semantic: ModelSemanticFitEvaluator = {
    async evaluate() {
      semanticCalls += 1;
      return { accepted: true, evidence: ["semantic fit"] };
    },
  };
  const result = await governor({ resolveAudio: unplayableAudio, semanticEvaluator: semantic }).evaluate(baseArgs({
    candidate: song("unknown-soul", "Unknown Soul Cut", "Unknown Artist"),
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_audio_unplayable");
  assert.equal(semanticCalls, 0);
});

test("governor rejects exhausted seed group", async () => {
  const result = await governor().evaluate(baseArgs({
    seedState: emptySeedState({ candidateSeedGroup: "rnb-core", exhaustedGroups: ["rnb-core"] }),
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_seed_exhausted");
});

test("governor rejects unsafe host text", async () => {
  const result = await governor().evaluate(baseArgs({
    hostText: "This candidate follows the contract trace and main line.",
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_host_text");
});

test("governor accepts allowed bridge only while bridge budget remains", async () => {
  const result = await governor().evaluate(baseArgs({
    contract: jazzContract(),
    candidate: song("cool-jazz", "Cool Jazz Reading Hour", "Small Combo", {
      album: "Cool Jazz Essentials",
    }),
    url: "/api/radio/audio/cool-jazz",
  }));

  assert.equal(result.status, "accepted");
  assert.equal(result.trace.decision, "bridge_allowed");
});

test("governor rejects allowed-adjacent bridge after bridge budget is exhausted", async () => {
  const result = await governor().evaluate(baseArgs({
    contract: jazzContract({ bridgeBudget: 0 }),
    candidate: song("cool-jazz", "Cool Jazz Reading Hour", "Small Combo", {
      album: "Cool Jazz Essentials",
    }),
    url: "/api/radio/audio/cool-jazz",
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_off_contract");
});

test("governor accepts model semantic fit when deterministic evidence is insufficient", async () => {
  let semanticCalls = 0;
  const semantic: ModelSemanticFitEvaluator = {
    async evaluate(args) {
      semanticCalls += 1;
      assert.equal(args.contract.id, "contract-rnb");
      assert.equal(args.candidate.id, "obscure");
      assert.ok(args.negativeConstraints.includes("classical chamber drift"));
      return { accepted: true, evidence: ["artist metadata says neo-soul"] };
    },
  };

  const result = await governor({ semanticEvaluator: semantic }).evaluate(baseArgs({
    candidate: song("obscure", "Velvet Late Night", "Obscure Singer"),
    url: "/api/radio/audio/obscure",
  }));

  assert.equal(result.status, "accepted");
  assert.equal(result.trace.decision, "model_semantic");
  assert.equal(semanticCalls, 1);
  assert.deepEqual(result.trace.evidence, ["artist metadata says neo-soul"]);
});

test("governor rejects semantic non-fit as off-contract", async () => {
  const semantic: ModelSemanticFitEvaluator = {
    async evaluate() {
      return { accepted: false, evidence: ["metadata is modern classical"] };
    },
  };

  const result = await governor({ semanticEvaluator: semantic }).evaluate(baseArgs({
    candidate: song("obscure", "Velvet Late Night", "Obscure Singer"),
    url: "/api/radio/audio/obscure",
  }));

  assert.equal(result.status, "rejected");
  assert.equal(result.trace.decision, "reject_off_contract");
  assert.deepEqual(result.trace.evidence, ["metadata is modern classical"]);
});

test("model semantic fit cannot override duplicate, seed, or host hard rejections", async () => {
  for (const overrides of [
    { currentTrack: song("sza-good-days", "Good Days", "SZA") },
    { readyQueue: [{ track: song("queued-alt", "Good Days", "SZA") }] },
    { seedState: emptySeedState({ candidateSeedGroup: "rnb-core", exhaustedGroups: ["rnb-core"] }) },
    { hostText: "This follows the candidate trace." },
  ] satisfies Array<Partial<PlaybackGovernorArgs>>) {
    let semanticCalls = 0;
    const semantic: ModelSemanticFitEvaluator = {
      async evaluate() {
        semanticCalls += 1;
        return { accepted: true, evidence: ["semantic fit"] };
      },
    };

    const result = await governor({ semanticEvaluator: semantic }).evaluate(baseArgs(overrides));

    assert.equal(result.status, "rejected");
    assert.equal(semanticCalls, 0);
  }
});

test("trackKey normalizes id-independent artist title identity", () => {
  assert.equal(trackKey(song("1", "Good Days!", "SZA")), trackKey(song("2", "good days", "sza")));
});
