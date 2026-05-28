import type { NeteaseService } from "../services/neteaseService.js";
import type { LLMRouter } from "../services/llmRouter.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { TasteProfile, Track, UserSettings } from "../types.js";
import { asStringList, compactText, extractJsonObject } from "../utils/text.js";

function defaultProfile(uid: string, settings: Partial<UserSettings>, anchors: Track[], recent: Track[], liked: string[]): TasteProfile {
  const anchorNames = anchors.slice(0, 4).map((track) => track.name).filter(Boolean);
  const notes = compactText(settings.musicNotes || "", 200);
  return {
    uid,
    musicDna: {
      genres: {},
      languageBias: {},
      energyLevel: "中",
      vocalPreference: "未知",
    },
    personality: {
      traits: notes ? ["有明确听歌备注"] : [],
      emotionalResonance: "音乐陪伴",
    },
    radioInsights: {
      tasteSummary: anchorNames.length
        ? `用户常回到 ${anchorNames.join("、")} 这类熟悉旋律，电台应先从可靠的私人歌单锚点出发。`
        : "用户画像还在建立中，先保持温暖、克制、不过度打扰的私人电台感。",
      comfortZone: anchorNames.length ? anchorNames : ["熟悉旋律", "自然人声", "稳定情绪"],
      discoveryDirection: ["从熟悉歌曲延伸到气质相近的新歌", "避免为了新鲜而突然跳到很吵或很口水的方向"],
      emotionalHooks: recent.slice(0, 4).map((track) => track.name).filter(Boolean),
      djTalkingPoints: ["说声音质感和情绪落点，不讲算法。"],
    },
    anchorTracks: anchors,
    recentTracks: recent,
    likedTrackIds: liked,
    learned: {
      avoidedLanguages: [],
      avoidedStyles: [],
      skippedTrackIds: [],
      negativeFeedbackCount: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}

export class ProfileEngine {
  constructor(
    private readonly netease: NeteaseService,
    private readonly llm: LLMRouter,
    private readonly store: MemoryStore,
  ) {}

  async analyze(uid: string): Promise<TasteProfile> {
    const settings = this.store.getUserSettings(uid) || {
      voicePreset: "warm_female",
      displayName: "",
      musicNotes: "",
      currentMode: "陪伴",
    };
    const playlists = await this.netease.userPlaylist(uid);
    const playlistTracks: Track[] = [];
    for (const playlist of playlists.slice(0, 6)) {
      const id = playlist.id;
      if (!id) continue;
      const detail = await this.netease.playlistDetail(String(id));
      const playlistData = detail.playlist;
      const tracks =
        playlistData && typeof playlistData === "object" && !Array.isArray(playlistData)
          ? (playlistData as Record<string, unknown>).tracks
          : [];
      if (Array.isArray(tracks)) {
        playlistTracks.push(
          ...tracks.slice(0, 40).map((song) => this.netease.normalizeTrack(song as Record<string, unknown>, "playlist")),
        );
      }
    }
    const records = await this.netease.userRecord(uid);
    const weekData = Array.isArray(records.weekData) ? (records.weekData as Array<Record<string, unknown>>) : [];
    const recentTracks = weekData
      .slice(0, 50)
      .map((item) => (item.song && typeof item.song === "object" ? this.netease.normalizeTrack(item.song as Record<string, unknown>, "recent") : null))
      .filter((track): track is Track => Boolean(track?.id))
      .slice(0, 30);
    const liked = await this.netease.likeList(uid);
    const anchors = playlistTracks.filter((track) => track.id).slice(0, 40);
    let profile = defaultProfile(uid, settings, anchors, recentTracks, liked.slice(0, 500));

    if (anchors.length || recentTracks.length || settings.musicNotes) {
      const generated = await this.generateProfile(uid, settings, anchors, recentTracks).catch(() => ({}));
      profile = this.mergeGeneratedProfile(profile, generated);
    }

    this.store.saveProfile(uid, profile);
    return profile;
  }

  private async generateProfile(
    uid: string,
    settings: Partial<UserSettings>,
    anchors: Track[],
    recent: Track[],
  ): Promise<Record<string, unknown>> {
    const sample = [...anchors.slice(0, 120), ...recent.slice(0, 40)]
      .map((track) => `- ${track.name} - ${track.artist}`)
      .join("\n")
      .slice(0, 3600);
    const prompt = `请根据这个用户的网易云歌单/最近播放样本，生成私人 AI 电台可执行的听歌画像。不要写废话，只返回 JSON。

歌曲样本：
${sample}

用户备注：
${compactText(settings.musicNotes || "", 500)}

返回 JSON：
{
  "genres": {"风格": 0.0},
  "language_bias": {"语种": 0.0},
  "energy_level": "低|中|高",
  "vocal_preference": "",
  "traits": ["短标签"],
  "taste_summary": "一句电台主播能理解的听感判断",
  "comfort_zone": ["熟悉听感"],
  "discovery_direction": ["适合扩展方向"],
  "emotional_hooks": ["情绪线索"],
  "dj_talking_points": ["主播可自然提到的观察"]
}`;
    const response = await this.llm.chat(prompt, {
      maxTokens: 800,
      system: "你是音乐画像蒸馏器，只返回有效 JSON。",
      responseFormat: { type: "json_object" },
    });
    return extractJsonObject(response);
  }

  private mergeGeneratedProfile(profile: TasteProfile, generated: Record<string, unknown>): TasteProfile {
    const musicDna = {
      genres:
        generated.genres && typeof generated.genres === "object" && !Array.isArray(generated.genres)
          ? (generated.genres as Record<string, number>)
          : profile.musicDna.genres,
      languageBias:
        generated.language_bias && typeof generated.language_bias === "object" && !Array.isArray(generated.language_bias)
          ? (generated.language_bias as Record<string, number>)
          : profile.musicDna.languageBias,
      energyLevel: compactText(generated.energy_level || profile.musicDna.energyLevel, 20),
      vocalPreference: compactText(generated.vocal_preference || profile.musicDna.vocalPreference, 80),
    };
    return {
      ...profile,
      musicDna,
      personality: {
        traits: asStringList(generated.traits, 8),
        emotionalResonance: profile.personality.emotionalResonance,
      },
      radioInsights: {
        tasteSummary: compactText(generated.taste_summary || profile.radioInsights.tasteSummary, 400),
        comfortZone: asStringList(generated.comfort_zone, 8).length
          ? asStringList(generated.comfort_zone, 8)
          : profile.radioInsights.comfortZone,
        discoveryDirection: asStringList(generated.discovery_direction, 8).length
          ? asStringList(generated.discovery_direction, 8)
          : profile.radioInsights.discoveryDirection,
        emotionalHooks: asStringList(generated.emotional_hooks, 8).length
          ? asStringList(generated.emotional_hooks, 8)
          : profile.radioInsights.emotionalHooks,
        djTalkingPoints: asStringList(generated.dj_talking_points, 8).length
          ? asStringList(generated.dj_talking_points, 8)
          : profile.radioInsights.djTalkingPoints,
      },
      updatedAt: new Date().toISOString(),
    };
  }
}

