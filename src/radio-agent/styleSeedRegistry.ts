import type { Track } from "../types.js";
import { dedupe, normalizeMatchText } from "../utils/text.js";

export interface StyleSeedDefinition {
  id: string;
  markers: string[];
  concreteQueries: string[];
  blockedTerms: string[];
  allowedAdjacent: string[];
  seedGroups: Array<{ id: string; queryKeys: string[]; cooldownTracks: number }>;
  exhaustion: "honest_not_found" | "widen_with_contract" | "legacy_with_label";
}

export class StyleSeedRegistry {
  constructor(private readonly styleDefinitions: StyleSeedDefinition[]) {}

  definitions(): StyleSeedDefinition[] {
    return this.styleDefinitions.map((definition) => cloneDefinition(definition));
  }

  match(text: string): StyleSeedDefinition | null {
    return this.matches(text)[0] || null;
  }

  matches(text: string): StyleSeedDefinition[] {
    const normalized = normalizeMatchText(text);
    return this.styleDefinitions
      .map((definition) => ({
        definition,
        score: Math.max(
          0,
          ...definition.markers
            .filter((marker) => markerMatches(marker, text, normalized))
            .map((marker) => markerScore(marker)),
        ),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((item) => item.definition);
  }

  queriesFor(text: string, recentTracks: Track[] = []): string[] {
    const definition = this.match(text);
    if (!definition) return [];
    return this.queriesForDefinition(definition, recentTracks);
  }

  queriesForDefinition(definition: StyleSeedDefinition, recentTracks: Track[] = []): string[] {
    const recentKeys = recentTracks.map((track) => styleTrackKey(track));
    const recentKeySet = new Set(recentKeys.map((key) => normalizeMatchText(key)));
    const exhaustedGroups = new Set(
      definition.seedGroups
        .filter((group) => isSeedGroupExhausted(definition, group.id, recentKeys))
        .map((group) => group.id),
    );
    const blockedQueryKeys = new Set<string>();
    for (const group of definition.seedGroups) {
      if (!exhaustedGroups.has(group.id)) continue;
      for (const key of group.queryKeys) blockedQueryKeys.add(normalizeMatchText(key));
    }
    return definition.concreteQueries.filter((query) => {
      const seedKey = normalizeMatchText(seedKeyForQuery(definition, query));
      return !recentKeySet.has(seedKey) && !blockedQueryKeys.has(seedKey);
    });
  }

  blockedTermsFor(text: string): string[] {
    return this.match(text)?.blockedTerms.slice() || [];
  }
}

export function defaultStyleSeedRegistry(definitions: StyleSeedDefinition[] = DEFAULT_STYLE_DEFINITIONS): StyleSeedRegistry {
  return new StyleSeedRegistry(definitions.map((definition) => cloneDefinition(definition)));
}

export function isSeedGroupExhausted(
  definition: StyleSeedDefinition,
  groupId: string,
  recentTrackKeys: string[],
): boolean {
  const group = definition.seedGroups.find((item) => item.id === groupId);
  if (!group) return false;
  const recent = new Set(recentTrackKeys.slice(0, group.cooldownTracks).map((key) => normalizeMatchText(key)));
  return group.queryKeys.every((key) => recent.has(normalizeMatchText(key)));
}

export function queryKey(query: string): string {
  const normalized = normalizeMatchText(query);
  const known = KNOWN_QUERY_TRACK_KEYS[normalized];
  if (known) return known;
  const tokens = query.match(/[A-Za-z0-9][A-Za-z0-9'.+&-]*|[\u4e00-\u9fff]+/gu) || [];
  if (tokens.length >= 2) {
    return normalizeMatchText(`${tokens[0]}::${tokens.slice(1).join(" ")}`);
  }
  return normalized;
}

function seedKeyForQuery(definition: StyleSeedDefinition, query: string): string {
  const normalizedQuery = normalizeMatchText(query);
  return definition.seedGroups
    .flatMap((group) => group.queryKeys)
    .find((key) => normalizeMatchText(key) === normalizedQuery || normalizedQuery.includes(normalizeMatchText(key)))
    || queryKey(query);
}

const KNOWN_QUERY_TRACK_KEYS: Record<string, string> = {
  [normalizeMatchText("jazz piano bar academy quiet")]: "jazzpianobaracademy::italiandinnerbackgroundmusic",
  [normalizeMatchText("jazz piano bar academy reading")]: "jazzpianobaracademy::magicalpiano",
  [normalizeMatchText("Jazz Piano Bar Academy Piano Instrumental Music")]: "jazzpianobaracademy::pianoinstrumentalmusic",
};

const DEFAULT_STYLE_DEFINITIONS: StyleSeedDefinition[] = [
  {
    id: "rnb",
    markers: ["rnb", "r&b", "R&B", "alt-r&b", "neo-soul", "late-night R&B"],
    concreteQueries: [
      "frank ocean pinkpuss",
      "Daniel Caesar Japanese Denim",
      "Frank Ocean Pink + White",
      "SZA Broken Clocks",
      "Summer Walker Session 32",
      "Jhené Aiko While We're Young",
      "H.E.R. Focus",
      "Kelela LMK",
      "Brent Faiyaz Clouded",
      "SZA Snooze",
    ],
    blockedTerms: ["classical chamber drift", "high energy EDM", "pure classical piano", "festival EDM"],
    allowedAdjacent: ["soul", "neo-soul", "quiet vocal pop"],
    seedGroups: [
      {
        id: "rnb-core",
        queryKeys: [
          queryKey("Daniel Caesar Japanese Denim"),
          queryKey("Frank Ocean Pink + White"),
          queryKey("SZA Broken Clocks"),
          queryKey("Summer Walker Session 32"),
          queryKey("Jhené Aiko While We're Young"),
          queryKey("H.E.R. Focus"),
          queryKey("Kelela LMK"),
          queryKey("Brent Faiyaz Clouded"),
          queryKey("SZA Snooze"),
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "widen_with_contract",
  },
  {
    id: "quiet_jazz",
    markers: ["quiet jazz", "soft jazz", "jazz for reading", "reading jazz"],
    concreteQueries: [
      "jazz piano bar academy quiet",
      "jazz piano bar academy reading",
      "Bill Evans Waltz for Debby",
      "Chet Baker I Fall In Love Too Easily",
      "Chet Baker Almost Blue",
      "Miles Davis Blue in Green",
      "Jazz Piano Bar Academy Piano Instrumental Music",
    ],
    blockedTerms: ["electronic remixes", "dance tracks", "festival EDM", "hard rock"],
    allowedAdjacent: ["cool jazz", "soft vocal jazz", "small-combo jazz"],
    seedGroups: [
      {
        id: "local-quiet-jazz",
        queryKeys: [
          "jazzpianobaracademy::italiandinnerbackgroundmusic",
          "jazzpianobaracademy::magicalpiano",
          "jazzpianobaracademy::pianoinstrumentalmusic",
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "honest_not_found",
  },
  {
    id: "quiet_focus",
    markers: ["quiet focus", "focus music", "reading music", "study music", "soft focus"],
    concreteQueries: [
      "Nils Frahm Ambre",
      "Olafur Arnalds Near Light",
      "Max Richter Dream 3",
      "Hania Rani Glass",
      "Dustin O'Halloran Opus 23",
      "Goldmund Threnody",
    ],
    blockedTerms: ["high energy EDM", "festival drops", "hard rock", "club tracks"],
    allowedAdjacent: ["minimal piano", "soft acoustic", "low-key instrumental"],
    seedGroups: [
      {
        id: "quiet-focus-core",
        queryKeys: [
          queryKey("Nils Frahm Ambre"),
          queryKey("Olafur Arnalds Near Light"),
          queryKey("Max Richter Dream 3"),
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "widen_with_contract",
  },
  {
    id: "chinese_quiet_mood",
    markers: [
      "\u665a\u4e0a.*\u5b89\u9759",
      "\u5b89\u9759.*\u6b4c",
    ],
    concreteQueries: [
      "Deca Joins 海浪",
      "告五人 带我去找夜生活",
      "陈绮贞 旅行的意义",
      "房东的猫 云烟成雨",
      "焦迈奇 我的名字",
      "椅子乐团 Rollin' On",
    ],
    blockedTerms: ["high energy EDM", "festival drops", "hard rock", "\u55e8\u6b4c"],
    allowedAdjacent: ["quiet mandopop", "soft indie", "late-night vocal"],
    seedGroups: [
      {
        id: "chinese-quiet-core",
        queryKeys: [
          queryKey("Deca Joins 海浪"),
          queryKey("告五人 带我去找夜生活"),
          queryKey("陈绮贞 旅行的意义"),
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "widen_with_contract",
  },
  {
    id: "emo",
    markers: ["emo", "sad alt", "sad indie", "melancholy", "heartbreak", "\u5fe7\u90c1", "\u6df1\u6c89"],
    concreteQueries: [
      "Phoebe Bridgers Funeral",
      "Mitski I Bet on Losing Dogs",
      "Lord Huron The Night We Met",
      "Cigarettes After Sex Apocalypse",
      "Bon Iver Skinny Love",
      "Billie Eilish when the party's over",
      "Daughter Youth",
      "The 1975 About You",
    ],
    blockedTerms: ["EDM", "Dubstep", "high energy EDM"],
    allowedAdjacent: ["sad indie", "low-key vocal", "melancholy folk"],
    seedGroups: [
      {
        id: "emo-core",
        queryKeys: [
          queryKey("Phoebe Bridgers Funeral"),
          queryKey("Mitski I Bet on Losing Dogs"),
          queryKey("Lord Huron The Night We Met"),
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "widen_with_contract",
  },
  {
    id: "future_bass",
    markers: ["future bass", "futurebass", "melodic future bass", "melodicfuturebass"],
    concreteQueries: [
      "Seven Lions Rush Over Me",
      "ILLENIUM Good Things Fall Apart",
      "San Holo Light",
      "Flume Never Be Like You",
      "Porter Robinson Shelter",
      "Said The Sky All I Got",
    ],
    blockedTerms: ["utility audio", "playlist"],
    allowedAdjacent: ["melodic bass", "cinematic electronic"],
    seedGroups: [
      {
        id: "future-bass-core",
        queryKeys: [
          queryKey("Seven Lions Rush Over Me"),
          queryKey("ILLENIUM Good Things Fall Apart"),
          queryKey("San Holo Light"),
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "widen_with_contract",
  },
  {
    id: "organic_house",
    markers: ["organic house", "organichouse", "chillout", "ambient", "\u8212\u7f13", "\u8212\u670d", "\u653e\u677e"],
    concreteQueries: [
      "Ben Bohmer Beyond Beliefs",
      "Nora En Pure Come With Me",
      "Lane 8 Atlas",
      "Bonobo Kerala",
      "Tycho Awake",
      "Kiasmos Looped",
    ],
    blockedTerms: ["high energy EDM", "dubstep"],
    allowedAdjacent: ["downtempo", "chillout", "soft electronic"],
    seedGroups: [
      {
        id: "organic-house-core",
        queryKeys: [
          queryKey("Ben Bohmer Beyond Beliefs"),
          queryKey("Nora En Pure Come With Me"),
          queryKey("Lane 8 Atlas"),
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "widen_with_contract",
  },
  {
    id: "citypop",
    markers: ["city pop", "citypop"],
    concreteQueries: ["Mariya Takeuchi Plastic Love", "Anri Last Summer Whisper", "Taeko Ohnuki 4:00 AM"],
    blockedTerms: ["playlist"],
    allowedAdjacent: ["japanese pop", "retro pop"],
    seedGroups: [
      {
        id: "citypop-core",
        queryKeys: [
          queryKey("Mariya Takeuchi Plastic Love"),
          queryKey("Anri Last Summer Whisper"),
          queryKey("Taeko Ohnuki 4:00 AM"),
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "widen_with_contract",
  },
  {
    id: "shoegaze",
    markers: ["shoegaze"],
    concreteQueries: ["Slowdive Sugar for the Pill", "my bloody valentine When You Sleep", "Ride Vapour Trail"],
    blockedTerms: ["playlist"],
    allowedAdjacent: ["dream pop", "soft noise pop"],
    seedGroups: [
      {
        id: "shoegaze-core",
        queryKeys: [
          queryKey("Slowdive Sugar for the Pill"),
          queryKey("my bloody valentine When You Sleep"),
          queryKey("Ride Vapour Trail"),
        ],
        cooldownTracks: 8,
      },
    ],
    exhaustion: "widen_with_contract",
  },
];

function markerMatches(marker: string, original: string, normalized: string): boolean {
  if (marker.includes(".*")) return new RegExp(marker, "u").test(original);
  if (original.includes(marker)) return true;
  const normalizedMarker = normalizeMatchText(marker);
  if (!normalizedMarker) return false;
  return normalized.includes(normalizedMarker);
}

function markerScore(marker: string): number {
  const normalized = normalizeMatchText(marker);
  if (normalized) return normalized.length;
  return marker.replace(/\.\*/g, "").replace(/\s+/g, "").length;
}

function cloneDefinition(definition: StyleSeedDefinition): StyleSeedDefinition {
  return {
    ...definition,
    markers: definition.markers.slice(),
    concreteQueries: dedupe(definition.concreteQueries),
    blockedTerms: definition.blockedTerms.slice(),
    allowedAdjacent: definition.allowedAdjacent.slice(),
    seedGroups: definition.seedGroups.map((group) => ({
      id: group.id,
      queryKeys: group.queryKeys.slice(),
      cooldownTracks: group.cooldownTracks,
    })),
  };
}

function styleTrackKey(track: Track): string {
  const artist = normalizeMatchText(track.artist);
  const title = normalizeMatchText(track.name);
  return `${artist || "unknown"}::${title || normalizeMatchText(track.id) || "unknown"}`;
}
