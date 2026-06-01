import assert from "node:assert/strict";
import test from "node:test";

import { assessProfileQuality } from "../../src/radio/profileQuality.js";
import type { TasteProfile } from "../../src/types.js";

function profile(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return {
    uid: "42",
    musicDna: { genres: {}, languageBias: {}, energyLevel: "中", vocalPreference: "未知" },
    personality: { traits: [], emotionalResonance: "音乐陪伴" },
    radioInsights: {
      tasteSummary: "用户画像还在建立中。",
      comfortZone: [],
      discoveryDirection: [],
      emotionalHooks: [],
      djTalkingPoints: [],
    },
    anchorTracks: [],
    recentTracks: [],
    likedTrackIds: [],
    learned: { avoidedLanguages: [], avoidedStyles: [], skippedTrackIds: [], negativeFeedbackCount: 0 },
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

test("shallow profile is marked low confidence", () => {
  const quality = assessProfileQuality(profile());
  assert.equal(quality.level, "low_confidence");
  assert.ok(quality.reasons.includes("missing_genres"));
  assert.ok(quality.reasons.includes("unknown_vocal_preference"));
});

test("rich profile is marked strong", () => {
  const quality = assessProfileQuality(profile({
    musicDna: { genres: { ambient: 0.8, classical: 0.6 }, languageBias: { instrumental: 0.7 }, energyLevel: "低", vocalPreference: "偏无人声" },
    radioInsights: {
      tasteSummary: "偏低能量、器乐、古典和氛围电子。",
      comfortZone: ["Nils Frahm", "Max Richter"],
      discoveryDirection: ["Olafur Arnalds"],
      emotionalHooks: ["Says"],
      djTalkingPoints: ["少说话"],
    },
    anchorTracks: [{ id: "1", name: "Says", artist: "Nils Frahm" }],
    recentTracks: [{ id: "2", name: "Near Light", artist: "Olafur Arnalds" }],
  }));
  assert.equal(quality.level, "strong");
  assert.ok(quality.score >= 0.75);
});
