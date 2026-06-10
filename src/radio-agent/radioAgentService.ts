import type { Track } from "../types.js";
import { chooseOpeningTrack as defaultChooseOpeningTrack, type OpeningTrackArgs, type OpeningTrackPick } from "./openingTrack.js";
import type { RadioAgentPreparedTrack } from "./types.js";

export interface RadioAgentSessionStartArgs extends OpeningTrackArgs {
  uid: string | null;
  sessionId: number | null;
}

export interface RadioAgentSessionStartResult {
  opening?: RadioAgentPreparedTrack;
  hostText?: string;
  backgroundStarted: boolean;
  fallbackReason?: string;
}

export interface RadioAgentServiceDeps {
  chooseOpeningTrack?: (args: OpeningTrackArgs) => OpeningTrackPick | null;
  prepareTrack: (track: Track, args: RadioAgentSessionStartArgs, pick: OpeningTrackPick) => Promise<RadioAgentPreparedTrack | null>;
  startBackgroundPlanning?: (args: RadioAgentSessionStartArgs, opening: RadioAgentPreparedTrack | null) => Promise<void> | void;
}

export class RadioAgentService {
  private readonly deps: Required<Pick<RadioAgentServiceDeps, "chooseOpeningTrack">> & Omit<RadioAgentServiceDeps, "chooseOpeningTrack">;

  constructor(deps: RadioAgentServiceDeps) {
    this.deps = {
      ...deps,
      chooseOpeningTrack: deps.chooseOpeningTrack ?? defaultChooseOpeningTrack,
    };
  }

  async startSession(args: RadioAgentSessionStartArgs): Promise<RadioAgentSessionStartResult> {
    const pick = this.deps.chooseOpeningTrack({
      recentPlayableTracks: args.recentPlayableTracks,
      profileAnchorTracks: args.profileAnchorTracks,
      likedTracks: args.likedTracks,
      fallbackTracks: args.fallbackTracks,
      avoidTrackIds: args.avoidTrackIds,
      avoidArtists: args.avoidArtists,
    });
    const opening = pick ? await this.deps.prepareTrack(pick.track, args, pick) : null;
    const backgroundStarted = this.startBackgroundPlanning(args, opening);

    if (opening) {
      return {
        opening,
        backgroundStarted,
      };
    }

    return {
      backgroundStarted,
      fallbackReason: pick ? "opening_track_prepare_failed" : "no_opening_track_candidate",
    };
  }

  private startBackgroundPlanning(args: RadioAgentSessionStartArgs, opening: RadioAgentPreparedTrack | null): boolean {
    if (!this.deps.startBackgroundPlanning) return false;
    void Promise.resolve(this.deps.startBackgroundPlanning(args, opening)).catch(() => undefined);
    return true;
  }
}
