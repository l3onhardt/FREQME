import { compactText, dedupe } from "../utils/text.js";
import type { ListeningIntentDecision, StationContract } from "./radioBrainTypes.js";

export interface StationContractManagerOptions {
  now?: () => string;
  idFactory?: (intent: ListeningIntentDecision, mainDirection: string, now: string) => string;
}

export class StationContractManager {
  constructor(private readonly options: StationContractManagerOptions = {}) {}

  update(existing: StationContract | null | undefined, intent: ListeningIntentDecision): StationContract {
    const now = this.now();
    const mainDirection = this.mainDirection(existing, intent);
    const startsFresh = !existing || intent.type === "music_direction_request";
    const isRnb = /\br\s*&?\s*b\b|\brnb\b|节奏布鲁斯/iu.test(
      [mainDirection, ...intent.positiveSeeds].join(" "),
    );
    const base: StationContract = startsFresh ? {
      id: this.id(intent, mainDirection, now),
      mainDirection,
      rawUserText: intent.rawText,
      allowedAdjacent: [],
      softBridge: [],
      disallowed: [],
      positiveSeeds: [],
      negativeConstraints: [],
      driftBudget: 1,
      bridgeCount: 0,
      mustReturnToContract: false,
      hostStyle: "standard",
      createdAt: now,
      updatedAt: now,
    } : existing;

    return {
      ...base,
      mainDirection,
      rawUserText: startsFresh ? intent.rawText || base.rawUserText : base.rawUserText,
      allowedAdjacent: dedupe([
        ...(isRnb ? ["alt-R&B", "neo-soul", "soft vocal", "downtempo", "R&B-adjacent electronic"] : []),
        ...base.allowedAdjacent,
      ]),
      softBridge: dedupe([...(isRnb ? ["ambient electronic", "piano ambient"] : []), ...base.softBridge]),
      disallowed: dedupe([
        ...base.disallowed,
        ...(isRnb
          ? ["classical chamber music", "pure classical piano", "high-energy EDM", "utility audio", "playlist"]
          : []),
        ...intent.negativeConstraints,
      ]),
      positiveSeeds: dedupe([...base.positiveSeeds, ...intent.positiveSeeds]),
      negativeConstraints: dedupe([...base.negativeConstraints, ...intent.negativeConstraints]),
      updatedAt: now,
    };
  }

  private mainDirection(existing: StationContract | null | undefined, intent: ListeningIntentDecision): string {
    if (existing?.mainDirection && intent.type !== "music_direction_request") return existing.mainDirection;
    return compactText(
      intent.positiveSeeds.join(" / ") || intent.query || intent.rawText || existing?.mainDirection || "AI radio",
      120,
    );
  }

  private now(): string {
    return this.options.now?.() || new Date().toISOString();
  }

  private id(intent: ListeningIntentDecision, mainDirection: string, now: string): string {
    return this.options.idFactory?.(intent, mainDirection, now) || `station-contract-${this.stableHash([
      mainDirection,
      intent.rawText,
      intent.query,
      intent.positiveSeeds.join("|"),
      intent.negativeConstraints.join("|"),
    ].join("::"))}`;
  }

  private stableHash(value: string): string {
    let hash = 2166136261;
    const normalized = compactText(value, 500).toLowerCase().normalize("NFKC");
    for (let index = 0; index < normalized.length; index += 1) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
}
