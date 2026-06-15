import type { Track } from "../types.js";
import { dedupe, normalizeMatchText } from "../utils/text.js";
import { trackKey } from "./playbackGovernor.js";

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
    const normalized = normalizeMatchText(text);
    return this.styleDefinitions.find((definition) =>
      definition.markers.some((marker) => markerMatches(marker, text, normalized)),
    ) || null;
  }

  queriesFor(text: string, recentTracks: Track[] = []): string[] {
    const definition = this.match(text);
    if (!definition) return [];
    const recentKeys = recentTracks.map((track) => trackKey(track));
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
      "Jhene Aiko While We're Young",
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
      "\u665a\u4e0a\u5b89\u9759",
      "\u5b89\u9759\u4e00\u70b9",
      "\u653e\u70b9\u665a\u4e0a",
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
];

function markerMatches(marker: string, original: string, normalized: string): boolean {
  if (marker.includes(".*")) return new RegExp(marker, "u").test(original);
  const normalizedMarker = normalizeMatchText(marker);
  if (!normalizedMarker) return false;
  return normalized.includes(normalizedMarker);
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
