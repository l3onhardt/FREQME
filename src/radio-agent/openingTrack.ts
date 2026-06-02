import type { Track } from "../types.js";

export type OpeningTrackReasonType =
  | "radio_agent_opening_recent"
  | "radio_agent_opening_profile_anchor"
  | "radio_agent_opening_liked"
  | "radio_agent_opening_fallback";

export interface OpeningTrackArgs {
  recentPlayableTracks: Track[];
  profileAnchorTracks: Track[];
  likedTracks: Track[];
  fallbackTracks: Track[];
  avoidTrackIds: Set<string>;
}

export interface OpeningTrackPick {
  track: Track;
  reason: {
    type: OpeningTrackReasonType;
    sourceRank: number;
  };
}

export function chooseOpeningTrack(args: OpeningTrackArgs): OpeningTrackPick | null {
  const seen = new Set<string>();
  const sources: Array<{ type: OpeningTrackReasonType; tracks: Track[] }> = [
    { type: "radio_agent_opening_recent", tracks: args.recentPlayableTracks },
    { type: "radio_agent_opening_profile_anchor", tracks: args.profileAnchorTracks },
    { type: "radio_agent_opening_liked", tracks: args.likedTracks },
    { type: "radio_agent_opening_fallback", tracks: args.fallbackTracks },
  ];

  for (const [index, source] of sources.entries()) {
    for (const track of source.tracks) {
      const id = String(track.id || "").trim();
      if (!id || args.avoidTrackIds.has(id) || seen.has(id) || !String(track.name || "").trim()) {
        if (id) seen.add(id);
        continue;
      }
      seen.add(id);
      return {
        track: { ...track, id },
        reason: {
          type: source.type,
          sourceRank: index + 1,
        },
      };
    }
  }

  return null;
}
