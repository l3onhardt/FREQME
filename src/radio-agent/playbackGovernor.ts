import type { BoundaryGuard } from "../radio/boundaryGuard.js";
import type { DecisionTrace, StationContract } from "../radio/radioBrainTypes.js";
import type { Track } from "../types.js";
import { normalizeMatchText } from "../utils/text.js";
import type { FallbackLevel } from "./agentActions.js";
import type { AgentSessionContract } from "./contractController.js";

export type { AgentSessionContract } from "./contractController.js";

export type PlaybackGovernanceDecision =
  | "direct_positive"
  | "registry_style"
  | "model_semantic"
  | "bridge_allowed"
  | "reject_hard_block"
  | "reject_off_contract"
  | "reject_duplicate_recent"
  | "reject_duplicate_ready"
  | "reject_stale_request"
  | "reject_seed_exhausted"
  | "reject_audio_unplayable"
  | "reject_host_text";

export interface PlaybackGovernanceTrace {
  status: "accepted" | "rejected";
  contractId: string | null;
  requestToken: number | null;
  candidateKey: string;
  decision: PlaybackGovernanceDecision;
  evidence: string[];
  fallbackLevel?: FallbackLevel;
}

export interface ModelSemanticFitEvaluator {
  evaluate(args: {
    contract: AgentSessionContract;
    candidate: Track;
    negativeConstraints: string[];
  }): Promise<{ accepted: boolean; evidence: string[] }>;
}

export interface SeedState {
  candidateSeedGroup?: string;
  exhaustedGroups?: string[];
}

export interface ReadyQueueItem {
  track: Track;
}

export interface PlaybackGovernorArgs {
  contract: AgentSessionContract | null;
  requestToken: number | null;
  activeRequestToken: number | null;
  candidate: Track;
  url: string;
  query?: string;
  currentTrack: Track | null;
  recentTracks: Track[];
  readyQueue: ReadyQueueItem[];
  seedState: SeedState;
  hostText?: string;
  fallbackLevel?: FallbackLevel;
  registryStyleEvidence?: string[];
}

export type PlaybackGovernorResult =
  | { status: "accepted"; track: Track; url: string; trace: PlaybackGovernanceTrace }
  | { status: "rejected"; reason: PlaybackGovernanceDecision; trace: PlaybackGovernanceTrace };

export interface PlaybackGovernorOptions {
  boundaryGuard: Pick<BoundaryGuard, "evaluate">;
  resolveAudio: (args: { track: Track; url: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  semanticEvaluator?: ModelSemanticFitEvaluator;
}

type FitResult =
  | { status: "direct_positive"; evidence: string[] }
  | { status: "bridge_allowed"; evidence: string[] }
  | { status: "off_contract"; evidence: string[] };

const RECENT_DUPLICATE_WINDOW = 8;
const HOST_TEXT_UNSAFE =
  /\b(prompt|model|json|candidate|trace|contract|tool call|verification|pipeline|shadow mode|main line|texture beside it)\b|旁边|质感|�/iu;

export class PlaybackGovernor {
  constructor(private readonly options: PlaybackGovernorOptions) {}

  async evaluate(args: PlaybackGovernorArgs): Promise<PlaybackGovernorResult> {
    const baseTrace = this.baseTrace(args);

    if (!isCurrentRequest(args.requestToken, args.activeRequestToken)) {
      return rejected(baseTrace, "reject_stale_request", ["request token is no longer active"]);
    }

    if (recentDuplicate(args.candidate, args.currentTrack, args.recentTracks)) {
      return rejected(baseTrace, "reject_duplicate_recent", ["candidate matches current or recent playback"]);
    }

    if (readyDuplicate(args.candidate, args.readyQueue)) {
      return rejected(baseTrace, "reject_duplicate_ready", ["candidate is already in ready queue"]);
    }

    if (seedExhausted(args.seedState)) {
      return rejected(baseTrace, "reject_seed_exhausted", [`seed group exhausted: ${args.seedState.candidateSeedGroup}`]);
    }

    if (unsafeHostText(args.hostText)) {
      return rejected(baseTrace, "reject_host_text", ["host text contains internal or unsafe language"]);
    }

    const hardBlockEvidence = hardBlockEvidenceFor(args.contract, args.candidate);
    if (hardBlockEvidence.length) {
      return rejected(baseTrace, "reject_hard_block", hardBlockEvidence);
    }

    const audio = await this.options.resolveAudio({ track: args.candidate, url: args.url });
    if (!audio.ok) {
      return rejected(baseTrace, "reject_audio_unplayable", [`audio resolution failed: ${audio.reason}`]);
    }

    if (args.registryStyleEvidence?.length) {
      return accepted(baseTrace, args, "registry_style", [...args.registryStyleEvidence]);
    }

    const deterministicFit = this.deterministicFit(args);
    if (deterministicFit.status === "direct_positive") {
      return accepted(baseTrace, args, "direct_positive", deterministicFit.evidence);
    }
    if (deterministicFit.status === "bridge_allowed") {
      return accepted(baseTrace, args, "bridge_allowed", deterministicFit.evidence);
    }

    if (args.contract && this.options.semanticEvaluator) {
      const semantic = await this.options.semanticEvaluator.evaluate({
        contract: args.contract,
        candidate: args.candidate,
        negativeConstraints: [...args.contract.disallowed],
      });
      if (semantic.accepted) {
        return accepted(baseTrace, args, "model_semantic", semantic.evidence);
      }
      return rejected(baseTrace, "reject_off_contract", semantic.evidence.length ? semantic.evidence : ["semantic evaluator rejected candidate"]);
    }

    return rejected(baseTrace, "reject_off_contract", deterministicFit.evidence);
  }

  private baseTrace(args: PlaybackGovernorArgs): PlaybackGovernanceTrace {
    return {
      status: "rejected",
      contractId: args.contract?.id ?? null,
      requestToken: args.requestToken,
      candidateKey: trackKey(args.candidate),
      decision: "reject_off_contract",
      evidence: [],
      fallbackLevel: args.fallbackLevel,
    };
  }

  private deterministicFit(args: PlaybackGovernorArgs): FitResult {
    if (!args.contract) return { status: "direct_positive", evidence: ["no active contract"] };

    const stationContract = toStationContract(args.contract);
    const boundary = this.options.boundaryGuard.evaluate({
      contract: stationContract,
      query: args.query || "playback governor candidate",
      candidate: args.candidate,
      fallbackLevel: toDecisionTraceFallbackLevel(args.fallbackLevel),
      itemStyle: "",
    });

    if (boundary.status.startsWith("reject_")) {
      return { status: "off_contract", evidence: [boundary.reason] };
    }

    const bridgeEvidence = bridgeEvidenceFor(args.contract, args.candidate);
    if (bridgeEvidence.length && args.contract.bridgeBudget > 0) {
      return { status: "bridge_allowed", evidence: [`boundary: ${boundary.reason}`, ...bridgeEvidence, args.contract.returnRequirement] };
    }

    if (bridgeEvidence.length) {
      return { status: "off_contract", evidence: ["bridge budget exhausted", ...bridgeEvidence] };
    }

    const directEvidence = directPositiveEvidence(args.contract, args.candidate);
    if (directEvidence.length) {
      return { status: "direct_positive", evidence: [`boundary: ${boundary.reason}`, ...directEvidence] };
    }

    if (boundary.status === "accept") {
      return { status: "direct_positive", evidence: [`boundary: ${boundary.reason}`] };
    }

    return { status: "off_contract", evidence: ["candidate has no direct contract evidence"] };
  }
}

export function trackKey(track: Track): string {
  const artist = normalizeMatchText(track.artist);
  const title = normalizeMatchText(track.name);
  return `${artist || "unknown"}::${title || normalizeMatchText(track.id) || "unknown"}`;
}

export function sameTrack(left: Track | null | undefined, right: Track | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.id && right.id && left.id === right.id) return true;
  return trackKey(left) === trackKey(right);
}

export function recentDuplicate(
  candidate: Track,
  currentTrack: Track | null | undefined,
  recentTracks: Track[],
  windowSize = RECENT_DUPLICATE_WINDOW,
): boolean {
  return [currentTrack, ...recentTracks.slice(0, windowSize)].some((track) => sameTrack(candidate, track));
}

export function readyDuplicate(candidate: Track, readyQueue: ReadyQueueItem[]): boolean {
  return readyQueue.some((item) => sameTrack(candidate, item.track));
}

export function detectAlternatingLoop(promotedKeys: string[], windowSize = 6): boolean {
  const keys = promotedKeys.slice(-windowSize);
  if (keys.length < 4) return false;
  const [first, second] = keys;
  if (!first || !second || first === second) return false;
  return keys.every((key, index) => key === (index % 2 === 0 ? first : second));
}

function accepted(
  baseTrace: PlaybackGovernanceTrace,
  args: PlaybackGovernorArgs,
  decision: PlaybackGovernanceDecision,
  evidence: string[],
): PlaybackGovernorResult {
  return {
    status: "accepted",
    track: args.candidate,
    url: args.url,
    trace: {
      ...baseTrace,
      status: "accepted",
      decision,
      evidence,
    },
  };
}

function rejected(
  baseTrace: PlaybackGovernanceTrace,
  decision: PlaybackGovernanceDecision,
  evidence: string[],
): PlaybackGovernorResult {
  return {
    status: "rejected",
    reason: decision,
    trace: {
      ...baseTrace,
      status: "rejected",
      decision,
      evidence,
    },
  };
}

function isCurrentRequest(requestToken: number | null, activeRequestToken: number | null): boolean {
  return requestToken !== null && activeRequestToken !== null && requestToken === activeRequestToken;
}

function seedExhausted(seedState: SeedState): boolean {
  return Boolean(
    seedState.candidateSeedGroup &&
      (seedState.exhaustedGroups || []).includes(seedState.candidateSeedGroup),
  );
}

function unsafeHostText(hostText: string | undefined): boolean {
  return Boolean(hostText && HOST_TEXT_UNSAFE.test(hostText));
}

function directPositiveEvidence(contract: AgentSessionContract, candidate: Track): string[] {
  const candidateText = candidateEvidenceText(candidate);
  const evidence: string[] = [];
  for (const anchor of contract.positiveAnchors) {
    const normalizedAnchor = normalizeMatchText(anchor);
    if (normalizedAnchor && candidateText.includes(normalizedAnchor)) {
      evidence.push(`candidate metadata matches positive anchor: ${anchor}`);
    }
  }
  if (isKnownRnbArtist(contract, candidate.artist)) {
    evidence.push(`candidate artist is trusted R&B evidence: ${candidate.artist}`);
  }
  return evidence;
}

function bridgeEvidenceFor(contract: AgentSessionContract, candidate: Track): string[] {
  const candidateText = candidateEvidenceText(candidate);
  const evidence: string[] = [];
  for (const adjacent of contract.allowedAdjacent) {
    const normalizedAdjacent = normalizeMatchText(adjacent);
    if (normalizedAdjacent && candidateText.includes(normalizedAdjacent)) {
      evidence.push(`candidate metadata matches allowed adjacent: ${adjacent}`);
    }
  }
  return evidence;
}

function hardBlockEvidenceFor(contract: AgentSessionContract | null, candidate: Track): string[] {
  const candidateText = candidateEvidenceText(candidate);
  const evidence: string[] = [];
  for (const block of contract?.disallowed || []) {
    const normalized = normalizeMatchText(block);
    if (normalized && candidateText.includes(normalized)) {
      evidence.push(`candidate metadata matches disallowed move: ${block}`);
    }
  }
  if (/(karaoke|backingtrack|whitenoise|sleepstudy|studybeatsplaylist|playlist|highenergyedm|festivaledm|festivalproducer|festivaldrop)/.test(candidateText)) {
    evidence.push("candidate metadata matches global hard block");
  }
  return evidence;
}

function candidateEvidenceText(candidate: Track): string {
  return normalizeMatchText([
    candidate.name,
    candidate.artist,
    candidate.album,
    ...(candidate.aliases || []),
  ].join(" "));
}

function isKnownRnbArtist(contract: AgentSessionContract, artist: string): boolean {
  const contractText = normalizeMatchText([contract.stationBrief, contract.rawUserText, ...contract.positiveAnchors].join(" "));
  if (!/rnb|randb|neosoul|soul/.test(contractText)) return false;
  return /^(sza|frankocean|danielcaesar|brentfaiyaz|jorjasmith|kelela|ravynlenae|snohaalegra|giveon|summerwalker|theweeknd|partynextdoor|miguel|usher|dangelo|erykahbadu|theinternet|sonder|her|h\.e\.r\.?)$/i.test(artist.trim());
}

function toStationContract(contract: AgentSessionContract): StationContract {
  return {
    id: contract.id,
    mainDirection: contract.stationBrief,
    rawUserText: contract.rawUserText,
    allowedAdjacent: [...contract.allowedAdjacent],
    softBridge: [],
    disallowed: [...contract.disallowed],
    positiveSeeds: [...contract.positiveAnchors],
    negativeConstraints: [...contract.disallowed],
    driftBudget: contract.bridgeBudget,
    bridgeCount: 0,
    mustReturnToContract: contract.bridgeBudget <= 0,
    hostStyle: "standard",
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
  };
}

function toDecisionTraceFallbackLevel(fallbackLevel: FallbackLevel | undefined): DecisionTrace["fallbackLevel"] {
  if (fallbackLevel === "same_contract_recent_safe") return "recent_verified";
  if (fallbackLevel === "legacy_with_label") return "scheduler";
  if (fallbackLevel === "same_contract_verified") return "last_episode";
  return "episode_primary";
}
