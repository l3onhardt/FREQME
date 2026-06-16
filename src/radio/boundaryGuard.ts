import type { Track } from "../types.js";
import { normalizeMatchText } from "../utils/text.js";
import type { BoundaryDecision, DecisionTrace, StationContract } from "./radioBrainTypes.js";

export interface BoundaryGuardArgs {
  contract?: StationContract | null;
  query: string;
  candidate: Track;
  fallbackLevel: DecisionTrace["fallbackLevel"];
  itemStyle?: string;
}

export class BoundaryGuard {
  evaluate(args: BoundaryGuardArgs): BoundaryDecision {
    if (!args.contract) return { status: "accept", reason: "No active station contract." };

    const candidateEvidence = normalizeMatchText([
      args.candidate.name,
      args.candidate.artist,
      args.candidate.album,
      ...(args.candidate.aliases || []),
    ].join(" "));
    const searchable = normalizeMatchText([args.query, args.itemStyle, args.candidate.source, candidateEvidence].join(" "));
    const query = normalizeMatchText(args.query);
    const artist = normalizeMatchText(args.candidate.artist);
    const name = normalizeMatchText(args.candidate.name);
    const candidateText = candidateEvidence || `${name}${artist}`;

    if (query.includes("maxrichter") && artist.includes("sviatoslavrichter")) {
      return {
        status: "reject_entity_mismatch",
        reason: "Query intended Max Richter but candidate is Sviatoslav Richter.",
        contractId: args.contract.id,
      };
    }

    if (this.isLateNightRnb(args.contract)) {
      if (/pianoquintet|symphony|concerto|quartet|sonata|sviatoslavrichter/.test(candidateText)) {
        return {
          status: "reject_off_contract",
          reason: "Classical chamber/performance result is outside the active R&B contract.",
          contractId: args.contract.id,
        };
      }

      if (this.isRnbFit(candidateText, artist)) {
        return { status: "accept", reason: "Candidate fits the active R&B contract.", contractId: args.contract.id };
      }

      if (args.contract.mustReturnToContract) {
        return {
          status: "reject_off_contract",
          reason: "Bridge already used; must return to the active R&B contract.",
          contractId: args.contract.id,
        };
      }

      if (/jonhopkins|nilsfrahm|maxrichter|onthenatureofdaylight|modernclassical|classical|instrumental|ambient|piano|electronic|olafur|sakamoto/.test(searchable)) {
        return {
          status: "reject_off_contract",
          reason: "Pure instrumental, classical, ambient, piano, or electronic bridge is outside the active R&B contract.",
          contractId: args.contract.id,
        };
      }

      return {
        status: "reject_off_contract",
        reason: "Candidate is not explicitly R&B, alt-R&B, neo-soul, or a trusted R&B artist under the active contract.",
        contractId: args.contract.id,
      };
    }

    const blockedMove = this.blockedMove(searchable, args.contract);
    if (blockedMove) {
      return {
        status: "reject_off_contract",
        reason: `Candidate matches blocked station move: ${blockedMove}.`,
        contractId: args.contract.id,
      };
    }

    if (this.requiresPositiveGenericFit(args.contract, args.fallbackLevel) && !this.genericContractFit(candidateText, args.contract)) {
      return {
        status: "reject_off_contract",
        reason: "Candidate has no clear evidence for the active station direction.",
        contractId: args.contract.id,
      };
    }

    return { status: "accept_as_adjacent", reason: "No deterministic boundary violation found.", contractId: args.contract.id };
  }

  private isLateNightRnb(contract: StationContract): boolean {
    return /r\s*&?\s*b|rnb/i.test([contract.mainDirection, ...contract.positiveSeeds].join(" "));
  }

  private isRnbFit(searchable: string, artist: string): boolean {
    if (/rnb|randb|neosoul|altsoul|soul|frankocean|sza|danielcaesar|brentfaiyaz|jorjasmith|kelela|ravynlenae|snohaalegra|giveon|summerwalker|theweeknd|partynextdoor|miguel|usher|dangelo|erykahbadu|theinternet|sonder/.test(searchable)) return true;
    return artist === "her" || artist === "h.e.r" || artist === "h.e.r.";
  }

  private blockedMove(searchable: string, contract: StationContract): string {
    for (const move of [...contract.disallowed, ...contract.negativeConstraints]) {
      const normalized = normalizeMatchText(move);
      if (normalized && searchable.includes(normalized)) return move;
    }
    return "";
  }

  private requiresPositiveGenericFit(contract: StationContract, fallbackLevel: DecisionTrace["fallbackLevel"]): boolean {
    if (fallbackLevel !== "recent_verified") return false;
    const text = normalizeMatchText([
      contract.mainDirection,
      contract.rawUserText,
      ...contract.positiveSeeds,
      ...contract.allowedAdjacent,
    ].join(" "));
    return text.length >= 4;
  }

  private genericContractFit(searchable: string, contract: StationContract): boolean {
    const anchors = [
      contract.mainDirection,
      contract.rawUserText,
      ...contract.positiveSeeds,
      ...contract.allowedAdjacent,
    ].flatMap((value) => this.anchorTokens(value));
    const unique = Array.from(new Set(anchors));
    return unique.some((token) => searchable.includes(token));
  }

  private anchorTokens(value: string): string[] {
    const normalized = normalizeMatchText(value);
    if (!normalized) return [];
    const rawTokens = value.match(/[A-Za-z0-9][A-Za-z0-9'.+&-]*|[\u4e00-\u9fff]+/gu) || [];
    const stop = new Set([
      "for",
      "the",
      "and",
      "with",
      "music",
      "song",
      "songs",
      "track",
      "tracks",
      "reading",
      "quiet",
      "soft",
      "light",
      "late",
      "night",
      "play",
      "put",
      "listen",
    ]);
    const tokens = rawTokens
      .map((token) => normalizeMatchText(token))
      .filter((token) => token.length >= 3 && !stop.has(token));
    return tokens.length ? tokens : [normalized].filter((token) => token.length >= 4);
  }
}
