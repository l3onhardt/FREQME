import type { TasteProfile, Track } from "../types.js";
import type { RadioLibraryTrack } from "./types.js";

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
  avoidArtists?: Set<string>;
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
      if (!id || args.avoidTrackIds.has(id) || artistIsAvoided(track.artist, args.avoidArtists) || seen.has(id) || !String(track.name || "").trim()) {
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

export function likedOpeningTracks(args: {
  uid: string | null;
  profile: TasteProfile | null;
  libraryTracks: RadioLibraryTrack[];
}): Track[] {
  const likedIds = new Set((args.profile?.likedTrackIds || []).map((id) => String(id || "").trim()).filter(Boolean));
  if (!likedIds.size) return [];
  const candidates: Track[] = [
    ...(args.profile?.anchorTracks || []),
    ...(args.profile?.recentTracks || []),
    ...args.libraryTracks
      .filter((track) => !args.uid || track.uid === args.uid)
      .map((track) => ({
        id: track.songId,
        name: track.songName,
        artist: track.artist,
        album: track.album,
        source: `library:${track.playlistId}`,
      })),
  ];
  const seen = new Set<string>();
  return candidates.filter((track) => {
    const id = String(track.id || "").trim();
    if (!id || seen.has(id) || !likedIds.has(id) || !String(track.name || "").trim()) return false;
    seen.add(id);
    return true;
  });
}

function artistIsAvoided(artist: string | undefined, avoidArtists: Set<string> | undefined): boolean {
  if (!avoidArtists?.size) return false;
  const normalized = String(artist || "").trim().toLowerCase();
  return Boolean(normalized && avoidArtists.has(normalized));
}
