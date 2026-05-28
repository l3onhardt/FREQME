import type { AudioResolver } from "../services/audioResolver.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { NeteaseService } from "../services/neteaseService.js";
import type { ListeningIntent, SelectionReason, TasteProfile, Track, UserSettings } from "../types.js";
import { normalizeMatchText } from "../utils/text.js";

const fallbackPlaylist: Track[] = [
  { id: "186016", name: "晴天", artist: "周杰伦", source: "fallback" },
  { id: "186001", name: "夜曲", artist: "周杰伦", source: "fallback" },
  { id: "108236", name: "七里香", artist: "周杰伦", source: "fallback" },
  { id: "5252772", name: "年少有为", artist: "李荣浩", source: "fallback" },
  { id: "36892407", name: "戒烟", artist: "李荣浩", source: "fallback" },
  { id: "27867139", name: "成都", artist: "赵雷", source: "fallback" },
  { id: "437856743", name: "消愁", artist: "毛不易", source: "fallback" },
  { id: "523776350", name: "像我这样的人", artist: "毛不易", source: "fallback" },
  { id: "26092806", name: "平凡之路", artist: "朴树", source: "fallback" },
  { id: "504686131", name: "后来", artist: "刘若英", source: "fallback" },
];

export interface SchedulerSessionState {
  playedSongIds: Set<string>;
  artistNames: string[];
  pickCount: number;
  activeIntent?: ListeningIntent;
}

export class StreamScheduler {
  private fallbackQueue: Track[] = [];

  constructor(
    private readonly netease: NeteaseService,
    private readonly store: MemoryStore,
    private readonly audioResolver: AudioResolver,
  ) {}

  newSessionState(): SchedulerSessionState {
    return {
      playedSongIds: new Set<string>(),
      artistNames: [],
      pickCount: 0,
    };
  }

  applyListeningIntent(state: SchedulerSessionState, intent: ListeningIntent, userSettings: Partial<UserSettings>): void {
    state.activeIntent = intent;
    userSettings.listeningIntent = intent;
  }

  async pickNext(args: {
    currentSongId?: string | null;
    profile: TasteProfile | null;
    userSettings: Partial<UserSettings>;
    sessionState: SchedulerSessionState;
    uid: string | null;
  }): Promise<Track | null> {
    const state = args.sessionState;
    const recent = new Set([...this.store.getRecentTrackIds(args.uid, 200), ...state.playedSongIds]);
    if (args.currentSongId) recent.add(args.currentSongId);
    const recentArtists = new Set([...state.artistNames.slice(-6), ...(args.profile?.recentTracks || []).slice(0, 10).map((track) => track.artist)]);
    const avoid = this.avoidMatchers(args.profile, args.userSettings, state);

    const activePick = await this.pickFromActiveIntent(args, recent, recentArtists, avoid);
    if (activePick) return activePick;

    if ((!args.currentSongId || state.pickCount % 4 === 0) && args.profile?.anchorTracks.length) {
      const anchor = this.chooseCandidate(args.profile.anchorTracks, recent, recentArtists, avoid, args.uid);
      if (anchor) return this.select(anchor, state, "familiar_anchor", `${anchor.name} 是熟悉的锚点，先把电台拉回亲近的听感。`);
    }

    if (args.currentSongId) {
      const similar = await this.netease.similarSongs(args.currentSongId);
      const picked = this.chooseCandidate(similar, recent, recentArtists, avoid, args.uid);
      if (picked) return this.select(picked, state, "discovery_similar", "顺着上一首的气质往外走一步。");
    }

    const daily = await this.netease.recommendSongs();
    this.shuffle(daily);
    const dailyPick = this.chooseCandidate(daily, recent, recentArtists, avoid, args.uid);
    if (dailyPick) return this.select(dailyPick, state, "daily_personal", "来自今天的私人推荐，和此刻的听感比较贴近。");

    const fm = await this.netease.personalFm();
    const fmPick = this.chooseCandidate(fm, recent, recentArtists, avoid, args.uid);
    if (fmPick) return this.select(fmPick, state, "personal_fm", "来自私人 FM，像熟悉口味里的一个新转角。");

    if (!this.fallbackQueue.length) this.fallbackQueue = this.shuffle([...fallbackPlaylist]);
    const fallback = this.chooseCandidate(this.fallbackQueue, recent, recentArtists, avoid, args.uid) || this.fallbackQueue[0];
    if (fallback) {
      this.fallbackQueue = this.fallbackQueue.filter((track) => track.id !== fallback.id);
      return this.select(fallback, state, "fallback", "先用一首稳妥的歌把电台接住。");
    }
    return null;
  }

  async prepareTrack(track: Track, uid: string | null): Promise<{ track: Track; url: string } | null> {
    const resolved = await this.audioResolver.resolveWithCandidates(track, uid);
    if (!resolved.ok) return null;
    return {
      track: { ...track, id: resolved.songId || track.id },
      url: resolved.proxyUrl,
    };
  }

  private async pickFromActiveIntent(
    args: {
      profile: TasteProfile | null;
      userSettings: Partial<UserSettings>;
      sessionState: SchedulerSessionState;
      uid: string | null;
    },
    recent: Set<string>,
    recentArtists: Set<string>,
    avoid: (track: Track) => boolean,
  ): Promise<Track | null> {
    const intent = args.sessionState.activeIntent || args.userSettings.listeningIntent;
    if (!intent || intent.expiresAfterTracks <= 0) return null;
    const candidates = [
      ...(args.profile?.anchorTracks || []),
      ...(args.profile?.recentTracks || []),
    ];
    const profilePick = this.chooseCandidate(
      candidates.filter((track) => this.matchesIntent(track, intent)),
      recent,
      recentArtists,
      avoid,
      args.uid,
    );
    if (profilePick) {
      intent.expiresAfterTracks -= 1;
      return this.select(profilePick, args.sessionState, "active_mode_profile", `继续沿着 ${intent.label} 走。`);
    }
    const query = [
      ...(intent.seedTask?.searchGoals || []),
      intent.label,
    ].find(Boolean);
    if (query) {
      const found = await this.netease.search(query, 8);
      const searchPick = this.chooseCandidate(found, recent, recentArtists, avoid, args.uid);
      if (searchPick) {
        intent.expiresAfterTracks -= 1;
        return this.select(searchPick, args.sessionState, "active_mode_search", `继续沿着 ${intent.label} 找一首贴近的。`);
      }
    }
    return null;
  }

  private chooseCandidate(
    tracks: Track[],
    recentIds: Set<string>,
    recentArtists: Set<string>,
    avoid: (track: Track) => boolean,
    uid: string | null,
  ): Track | null {
    const good = tracks.filter((track) => {
      if (!track?.id || recentIds.has(track.id)) return false;
      if (avoid(track)) return false;
      if (this.store.wasTrackRecentlyFailed(track.id, uid)) return false;
      return true;
    });
    if (!good.length) return null;
    return good.find((track) => !track.artist || !recentArtists.has(track.artist)) || good[0] || null;
  }

  private select(track: Track, state: SchedulerSessionState, reasonType: string, text: string): Track {
    const reason: SelectionReason = { type: reasonType, text };
    const selected = { ...track, selectionReason: reason };
    state.playedSongIds.add(selected.id);
    if (selected.artist) state.artistNames = [...state.artistNames, selected.artist].slice(-12);
    state.pickCount += 1;
    return selected;
  }

  private avoidMatchers(
    profile: TasteProfile | null,
    settings: Partial<UserSettings>,
    state: SchedulerSessionState,
  ): (track: Track) => boolean {
    const constraints = [
      ...(profile?.learned.avoidedStyles || []),
      ...(profile?.learned.avoidedLanguages || []),
      ...(settings.listeningIntent?.constraints || []),
      ...(state.activeIntent?.constraints || []),
    ].map(normalizeMatchText);
    const skipped = new Set(profile?.learned.skippedTrackIds || []);
    return (track) => {
      if (skipped.has(track.id)) return true;
      const text = normalizeMatchText(`${track.name} ${track.artist} ${track.album || ""} ${track.language || ""}`);
      return constraints.some((constraint) => constraint && text.includes(constraint));
    };
  }

  private matchesIntent(track: Track, intent: ListeningIntent): boolean {
    const text = normalizeMatchText(`${track.name} ${track.artist} ${track.album || ""}`);
    const tokens = [
      intent.label,
      intent.rawText,
      ...(intent.seedTask?.primaryEntities.map((entity) => entity.name) || []),
      intent.seedTask?.styleHint || "",
      intent.seedTask?.workHint || "",
    ].map(normalizeMatchText).filter(Boolean);
    if (!tokens.length) return true;
    return tokens.some((token) => text.includes(token) || token.includes(text));
  }

  private shuffle<T>(items: T[]): T[] {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [items[index], items[swap]] = [items[swap], items[index]];
    }
    return items;
  }
}

