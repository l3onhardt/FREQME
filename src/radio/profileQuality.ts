import type { TasteProfile } from "../types.js";
import type { ProfileQuality } from "./radioBrainTypes.js";

export function assessProfileQuality(profile: TasteProfile | null): ProfileQuality {
  if (!profile) return { level: "low_confidence", score: 0, reasons: ["missing_profile"] };
  const reasons: string[] = [];
  let score = 0;

  if (Object.keys(profile.musicDna.genres || {}).length) score += 0.22;
  else reasons.push("missing_genres");
  if (Object.keys(profile.musicDna.languageBias || {}).length) score += 0.14;
  else reasons.push("missing_language_bias");
  if (profile.musicDna.vocalPreference && profile.musicDna.vocalPreference !== "未知") score += 0.14;
  else reasons.push("unknown_vocal_preference");
  if (profile.radioInsights.tasteSummary && !/还在建立|熟悉旋律/.test(profile.radioInsights.tasteSummary)) score += 0.16;
  else reasons.push("generic_taste_summary");
  if (profile.radioInsights.comfortZone.length >= 2) score += 0.12;
  else reasons.push("thin_comfort_zone");
  if (profile.radioInsights.discoveryDirection.length >= 1) score += 0.08;
  if (profile.anchorTracks.length >= 1) score += 0.08;
  if (profile.recentTracks.length >= 1) score += 0.06;

  const rounded = Math.min(1, Number(score.toFixed(2)));
  const level = rounded >= 0.75 ? "strong" : rounded >= 0.45 ? "usable" : "low_confidence";
  return { level, score: rounded, reasons };
}
