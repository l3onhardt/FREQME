import type {
  RadioAgentCandidateTask,
  RadioAgentContextSnapshot,
  RadioAgentHostIntent,
  RadioAgentMemory,
  RadioAgentProgramWindow,
} from "./types.js";
import { defaultStyleSeedRegistry } from "./styleSeedRegistry.js";

export interface ProgramPlanningModel {
  chat(
    prompt: string,
    options?: {
      responseFormat?: Record<string, unknown>;
      maxTokens?: number;
      system?: string;
      timeoutMs?: number;
    },
  ): Promise<string>;
}

type ProgramWindowSource = RadioAgentProgramWindow["source"];

const MAX_CANDIDATE_TASKS = 5;
const HOST_TEXT_LIMIT = 140;
const PROGRAM_DIRECTOR_MAX_TOKENS = 1100;
const PROGRAM_DIRECTOR_TIMEOUT_MS = 14000;
const EXPLICIT_CONTINUATION_MODEL_TIMEOUT_MS = 120;
const PROGRAM_DIRECTOR_SYSTEM =
  "You are FREQME's personal AI radio program director. Return only valid JSON. Never mention models, prompts, traces, verification, tool calls, or internal systems.";
const DEFAULT_FALLBACK_QUERY = "warm vocal radio discovery";
const INTERNAL_HOST_TERMS =
  /\b(model|json|candidate|trace|prompt|verification|shadow mode|tool call|deterministic|contract)\b/i;
const AWKWARD_HOST_TERMS = /旁边|质感|当前电台方向|继续保持这个感觉|主线还是/u;
const MOJIBAKE_HOST_TERMS = /[�]|閹|閵|娑|缁|淇|檤|闁|濞|鐢|鍙|姘|鎴|鍏|涓|杩|俙|銆/u;
const RAW_MEMORY_EVIDENCE_TERMS = /listener has|library evidence|playlist titles repeatedly/i;
const RAW_COMMAND_QUERY = /^\s*(please\s+)?(play|put on|queue|find|search|give me|can you|could you|i want|i need)\b/i;
const UTILITY_AUDIO_QUERY = /\b(playlist|study|studying|sleep|lofi|lo-fi|white noise|brown noise|pink noise|rain sounds|timer|meditation|focus music|ambient sounds)\b/i;
const HOST_EVENTS: RadioAgentHostIntent["event"][] = [
  "station_open",
  "request_ack",
  "bridge_entered",
  "return_to_contract",
  "explanation",
  "correction",
  "recovery",
  "silent",
];
const STYLE_SEEDS = defaultStyleSeedRegistry();
const RADIO_AGENT_DEBUG = process.env.FREQME_RADIO_AGENT_DEBUG === "1";

export class RadioAgentProgramDirector {
  constructor(
    private readonly model: ProgramPlanningModel | null,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async plan(context: RadioAgentContextSnapshot): Promise<RadioAgentProgramWindow> {
    const createdAt = this.now();
    if (shouldExecuteExplicitDirectionImmediately(context)) return buildFallbackWindow(context, createdAt);
    const explicitContinuation = shouldUseFastExplicitContinuation(context);

    if (this.model) {
      try {
        const prompt = buildPrompt(context, createdAt);
        const raw = await withPlanningTimeout(
          this.model.chat(prompt, {
            maxTokens: PROGRAM_DIRECTOR_MAX_TOKENS,
            system: PROGRAM_DIRECTOR_SYSTEM,
            responseFormat: { type: "json_object" },
            timeoutMs: explicitContinuation ? EXPLICIT_CONTINUATION_MODEL_TIMEOUT_MS : PROGRAM_DIRECTOR_TIMEOUT_MS,
          }),
          explicitContinuation ? EXPLICIT_CONTINUATION_MODEL_TIMEOUT_MS : 0,
        );
        const parsed = parseJsonObject(raw);
        const window = buildWindowFromParsed(context, parsed, createdAt, "model");
        if (window.candidateTasks.length > 0) return window;
      } catch (error) {
        debugProgramDirector("model_plan_failed", { reason: error instanceof Error ? error.message : String(error) });
        // The agent can keep programming from durable context when planning fails.
      }
    }

    return buildFallbackWindow(context, createdAt);
  }
}

function shouldExecuteExplicitDirectionImmediately(context: RadioAgentContextSnapshot): boolean {
  return context.eventType === "user_text" && Boolean(latestExplicitUserDirection(context));
}

function shouldUseFastExplicitContinuation(context: RadioAgentContextSnapshot): boolean {
  if (context.eventType !== "queue_low" && context.eventType !== "track_completed") return false;
  return Boolean(latestExplicitUserDirection(context));
}

function buildPrompt(context: RadioAgentContextSnapshot, createdAt: string): string {
  return [
    "You are the program director for an assisted personal radio station.",
    "Return JSON only. Do not include markdown or prose outside JSON.",
    "Create an agent-owned radio window with station_brief, main_direction, allowed_adjacent, bridge_budget, disallowed, return_requirement, candidate_tasks, host_intent, and trace_basis.",
    "Candidate tasks must be music search directions, not raw user commands, playlists, study audio, sleep audio, or utility audio.",
    `Planning time: ${createdAt}`,
    section("Profile", context.profile),
    section("Station Now", context.now),
    section("Program Contract", context.contract),
    section("Listener Session", context.session),
    section("Session Reflection", context.reflection),
    section("Agent Repair", context.repair),
    section("Memory Facts", context.memoryFacts.map(formatMemory).join("\n")),
    section("Memory Hypotheses", context.memoryHypotheses.map(formatMemory).join("\n")),
    section("Session Evidence", context.sessionEvidence.map(formatMemory).join("\n")),
    section("Recent Events", JSON.stringify(context.recentEvents)),
    section("Current Track", JSON.stringify(context.currentTrack)),
    section("Ready Queue", JSON.stringify(context.readyQueue)),
  ].join("\n\n");
}

function buildWindowFromParsed(
  context: RadioAgentContextSnapshot,
  parsed: Record<string, unknown>,
  createdAt: string,
  source: ProgramWindowSource,
): RadioAgentProgramWindow {
  const explicitDirectionTasks = explicitDirectionCandidateTasks(
    latestExplicitUserDirection(context),
    fallbackNegativeConstraints(context),
    recentPlaybackTracks(context),
  );
  const parsedCandidateTasks = arrayValue(valueFor(parsed, "candidateTasks"))
    .map(toCandidateTask)
    .filter((task): task is RadioAgentCandidateTask => task !== null);
  const candidatePool = dedupeCandidateTasks([...explicitDirectionTasks, ...parsedCandidateTasks]);
  const safeModelTasks = candidatePool
    .filter((task) => !queryWasRecentlyFailed(task.query, repairFailedQueries(context.repair)))
    .filter((task) => !taskMatchesAvoids(task, fallbackNegativeConstraints(context)))
    .filter((task) => taskFitsContract(context, task))
    .slice(0, MAX_CANDIDATE_TASKS);
  const candidateTasks =
    safeModelTasks.length > 0 || !hasExecutionRepair(context.repair) || parsedCandidateTasks.length === 0
      ? safeModelTasks
      : fallbackCandidateTasks(context).slice(0, MAX_CANDIDATE_TASKS);
  const stationBrief = stringValue(valueFor(parsed, "stationBrief")) || fallbackStationBrief(context);
  const mainDirection = stringValue(valueFor(parsed, "mainDirection")) || fallbackMainDirection(context);
  const allowedAdjacent = stringArray(valueFor(parsed, "allowedAdjacent"));
  const returnRequirement = stringValue(valueFor(parsed, "returnRequirement")) || "Return to the station brief after adjacent exploration.";
  const hostIntent = toHostIntent(valueFor(parsed, "hostIntent"));

  return {
    id: makeWindowId(context, createdAt),
    uid: context.uid,
    sessionId: context.sessionId,
    stationBrief: sanitizeWindowTextForContract(context, stationBrief, "brief", candidateTasks),
    mainDirection: sanitizeWindowTextForContract(context, mainDirection, "direction", candidateTasks),
    allowedAdjacent: sanitizeAllowedAdjacentForContract(context, allowedAdjacent),
    bridgeBudget: numberValue(valueFor(parsed, "bridgeBudget"), 1),
    disallowed: uniqueStrings([...stringArray(valueFor(parsed, "disallowed")), ...contractBlockedMoves(context.contract)]),
    returnRequirement: sanitizeWindowTextForContract(context, returnRequirement, "return", candidateTasks),
    candidateTasks,
    hostIntent: sanitizeHostIntentForContract(context, hostIntent, candidateTasks),
    currentTrack: context.currentTrack,
    recentTracks: recentPlaybackTracks(context),
    readyQueue: context.readyQueue,
    traceBasis: traceBasisFromContext(context),
    source,
    createdAt,
  };
}

function buildFallbackWindow(context: RadioAgentContextSnapshot, createdAt: string): RadioAgentProgramWindow {
  const candidateTasks = fallbackCandidateTasks(context);
  return {
    id: makeWindowId(context, createdAt),
    uid: context.uid,
    sessionId: context.sessionId,
    stationBrief: fallbackStationBrief(context),
    mainDirection: fallbackMainDirection(context),
    allowedAdjacent: [],
    bridgeBudget: 1,
    disallowed: extractDisallowed(context.contract),
    returnRequirement: "Return to the main radio mood after one adjacent bridge.",
    candidateTasks,
    hostIntent: fallbackHostIntent(context),
    currentTrack: context.currentTrack,
    recentTracks: recentPlaybackTracks(context),
    readyQueue: context.readyQueue,
    traceBasis: traceBasisFromContext(context),
    source: "deterministic_fallback",
    createdAt,
  };
}

function recentPlaybackTracks(context: RadioAgentContextSnapshot): RadioAgentProgramWindow["recentTracks"] {
  const eventTracks = context.recentEvents
    .filter((event) => event.type === "playback_started")
    .map((event) => extractEventTrack(event.payload.track))
    .filter((track): track is NonNullable<RadioAgentProgramWindow["currentTrack"]> => Boolean(track));
  const tracks = [
    context.currentTrack,
    ...context.recentTracks,
    ...eventTracks,
    ...context.readyQueue,
  ].filter((track): track is NonNullable<RadioAgentProgramWindow["currentTrack"]> => Boolean(track));
  const seen = new Set<string>();
  const unique: NonNullable<RadioAgentProgramWindow["recentTracks"]> = [];
  for (const track of tracks) {
    const key = trackIdentityKey(track);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(track);
  }
  return unique.slice(0, 8);
}

function trackIdentityKey(track: NonNullable<RadioAgentProgramWindow["currentTrack"]>): string {
  const name = (track.name || "").toLowerCase().replace(/\s+/gu, " ").trim();
  const artist = (track.artist || "").toLowerCase().replace(/\s+/gu, " ").trim();
  if (name || artist) return `${artist}:${name}`;
  return track.id || "";
}

function extractEventTrack(value: unknown): NonNullable<RadioAgentProgramWindow["currentTrack"]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id : "";
  const name = typeof source.name === "string" ? source.name : "";
  const artist = typeof source.artist === "string" ? source.artist : "";
  if (!id && !name) return null;
  return { id, name, artist };
}

function fallbackCandidateTasks(context: RadioAgentContextSnapshot): RadioAgentCandidateTask[] {
  const contract = contractAnchor(context.contract);
  const failedQueries = repairFailedQueries(context.repair);
  const avoids = fallbackNegativeConstraints(context);
  const explicitDirection = latestExplicitUserDirection(context);
  const recentTracks = recentPlaybackTracks(context);
  const explicitDirectionTasks = explicitDirectionCandidateTasks(explicitDirection, avoids, recentTracks);
  const explicitContractQueries = explicitContractFallbackQueries(context);
  const continuityAnchors = explicitDirection
    ? []
    : [
        ...explicitContractQueries,
        ...reflectionCompletedArtists(context.reflection),
        ...reflectionPositiveAnchors(context.reflection),
        ...context.memoryHypotheses.map(memoryAnchor),
        ...context.memoryFacts.map(memoryAnchor),
        ...profileAnchors(context.profile),
        context.currentTrack?.artist,
        ...context.readyQueue.map((track) => track.artist),
        ...contractDefaultQueries(contract),
        ...(explicitContractQueries.length ? [] : [contract]),
        DEFAULT_FALLBACK_QUERY,
      ];
  const anchors = continuityAnchors
    .filter((anchor): anchor is string => Boolean(anchor?.trim()))
    .map((anchor) => anchor.trim())
    .filter((anchor) => !queryMatchesAvoids(anchor, avoids));

  const uniqueAnchors = Array.from(new Set(anchors));
  const tasks = [
    ...explicitDirectionTasks,
    ...uniqueAnchors.map((anchor) => ({
      query: anchor,
      reason: "This stays close to known taste while keeping the current radio mood coherent.",
      style: styleFromContract(context.contract),
      negativeConstraints: fallbackNegativeConstraints(context),
    })),
  ];

  return dedupeCandidateTasks(tasks)
    .filter(isAllowedCandidateTask)
    .filter((task) => !queryWasRecentlyFailed(task.query, failedQueries))
    .filter((task) => !queryMatchesAvoids(task.query, avoids))
    .filter((task) => taskFitsContract(context, task))
    .slice(0, MAX_CANDIDATE_TASKS);
}

function latestExplicitUserDirection(context: RadioAgentContextSnapshot): string {
  let latest: { direction: string; createdAtMs: number; id: number; index: number } | null = null;
  for (const [index, event] of context.recentEvents.entries()) {
    if (event.type !== "user_text") continue;
    const direction = explicitDirectionFromUserText(stringValue(event.payload.text));
    if (!direction) continue;
    const createdAtMs = Date.parse(event.createdAt);
    const candidate = {
      direction,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Number.NEGATIVE_INFINITY,
      id: typeof event.id === "number" && Number.isFinite(event.id) ? event.id : Number.NEGATIVE_INFINITY,
      index,
    };
    if (!latest || isNewerExplicitDirection(candidate, latest)) latest = candidate;
  }
  return latest?.direction || "";
}

function isNewerExplicitDirection(
  candidate: { createdAtMs: number; id: number; index: number },
  current: { createdAtMs: number; id: number; index: number },
): boolean {
  if (candidate.createdAtMs !== current.createdAtMs) return candidate.createdAtMs > current.createdAtMs;
  if (candidate.id !== current.id) return candidate.id > current.id;
  if (candidate.createdAtMs === Number.NEGATIVE_INFINITY && candidate.id === Number.NEGATIVE_INFINITY) {
    return candidate.index < current.index;
  }
  return candidate.index > current.index;
}

function explicitDirectionFromUserText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (isExplanationLikeUserText(compact)) return "";

  const hasDirectionCue = hasExplicitDirectionCue(compact);
  const hasMusicSignal = hasMusicDirectionSignal(compact);
  if (!hasDirectionCue && !hasMusicSignal) return "";

  let direction = replacementDirectionFromCorrection(compact) || compact;
  if (isNegativeDirectionText(direction)) return "";

  direction = direction
    .replace(/^\s*(?:please|pls|can you|could you|would you)\s+/iu, "")
    .replace(
      /^\s*(?:play|put on|queue|find|search|give me|i want|i need|want|need|switch to|change to|more of|more)\s+(?:some\s+|more\s+|me\s+)?/iu,
      "",
    )
    .replace(/^\s*(?:播放|放点|播点|来点|听点|想听|换成|换点|给我来点|给我放点)\s*/u, "")
    .replace(/\b(?:please|pls|now|next|tonight|today)\b[.!?。！？，,]*$/iu, "")
    .replace(/[.!?。！？，,]+$/u, "")
    .trim();

  if (!direction || direction.length < 2) return "";
  if (RAW_COMMAND_QUERY.test(direction) || UTILITY_AUDIO_QUERY.test(direction)) return "";
  if (isExplanationLikeUserText(direction) || isNegativeDirectionText(direction)) return "";
  if (/^(?:continue|keep going|whatever|anything|surprise me|same vibe)$/iu.test(direction)) return "";
  return direction.slice(0, 120).trim();
}

function replacementDirectionFromCorrection(text: string): string {
  const patterns = [
    /\b(?:switch|change|move|turn)\s+(?:it\s+)?(?:to|into)\s+(.+)$/iu,
    /\b(?:replace|swap)\s+(?:it\s+)?(?:with|to)\s+(.+)$/iu,
    /(?:换成|换到|换回|换点|改成|改到|转成|转到|切到|切成|来点|放点)\s*(.+)$/u,
  ];
  for (const pattern of patterns) {
    const candidate = text.match(pattern)?.[1]?.trim() || "";
    if (!candidate) continue;
    const cleaned = candidate
      .replace(/[。！？!?，,]+$/u, "")
      .replace(/^(?:some|more|一点|一些|点)\s+/iu, "")
      .trim();
    if (cleaned && hasMusicDirectionSignal(cleaned)) return cleaned;
  }
  return "";
}

function explicitDirectionCandidateTasks(
  direction: string,
  avoids: string[],
  recentTracks: RadioAgentProgramWindow["recentTracks"] = [],
): RadioAgentCandidateTask[] {
  if (!direction) return [];
  const style = styleFromDirection(direction);
  return directionFallbackQueries(direction, recentTracks).map((query) => ({
    query,
    reason: explicitDirectionReason(direction),
    style,
    negativeConstraints: avoids,
  }));
}

function explicitDirectionReason(direction: string): string {
  if (isQuietJazzText(direction)) return "\u6309\u4f60\u8bf4\u7684\u5b89\u9759\u7235\u58eb\u9605\u8bfb\u6c1b\u56f4\uff0c\u5148\u627e\u4e00\u9996\u80fd\u7a33\u5b9a\u64ad\u653e\u7684\u3002";
  if (isRnbText(direction)) return "\u6309\u4f60\u8bf4\u7684 R&B \u65b9\u5411\uff0c\u5148\u627e\u4e00\u9996\u4eba\u58f0\u548c\u5f8b\u52a8\u90fd\u7a33\u7684\u3002";
  return `\u6309\u4f60\u8bf4\u7684 ${direction} \u65b9\u5411\uff0c\u5148\u627e\u4e00\u9996\u80fd\u7a33\u5b9a\u64ad\u653e\u7684\u3002`;
}

function directionFallbackQueries(direction: string, recentTracks: RadioAgentProgramWindow["recentTracks"] = []): string[] {
  const normalized = direction.toLowerCase();
  if (/\bjazz\b|爵士/u.test(normalized)) {
    if (/\b(quiet|calm|soft|mellow|reading|read|late|night|study|studying)\b|安静|阅读/u.test(normalized)) {
      return [
        direction,
        "quiet jazz piano for reading",
        "soft instrumental jazz for reading",
        "Miles Davis Blue in Green",
        "Bill Evans Peace Piece",
        "Chet Baker Almost Blue",
      ];
    }
    return [
      direction,
      "Miles Davis So What",
      "John Coltrane Naima",
      "Bill Evans Waltz for Debby",
      "Chet Baker My Funny Valentine",
    ];
  }
  if (isRnbText(direction)) {
    return uniqueStrings([direction, ...rnbContractQueries(recentTracks)]);
  }
  if (/\bneo[-\s]?soul\b|\bsoul\b|灵魂/u.test(normalized)) {
    return [
      "Erykah Badu On & On",
      "D'Angelo Untitled",
      "Jill Scott A Long Walk",
      "Maxwell Ascension",
      direction,
    ];
  }
  if (/\bhip[-\s]?hop\b|\brap\b|说唱/u.test(normalized)) {
    return [
      "A Tribe Called Quest Electric Relaxation",
      "Nujabes Feather",
      "J Dilla Time The Donut of the Heart",
      direction,
    ];
  }
  if (/\bcity\s*pop\b|城市流行/u.test(normalized)) {
    return [
      "Mariya Takeuchi Plastic Love",
      "Anri Remember Summer Days",
      "Taeko Ohnuki 4:00 AM",
      direction,
    ];
  }
  return [direction];
}

function styleFromDirection(direction: string): string {
  if (/\bjazz\b|爵士/iu.test(direction)) return /\bquiet|calm|soft|mellow|reading|read\b|安静|阅读/iu.test(direction) ? "quiet jazz" : "jazz";
  if (isRnbText(direction)) return "R&B";
  if (/\bneo[-\s]?soul\b|\bsoul\b|灵魂/iu.test(direction)) return "soul";
  if (/\bhip[-\s]?hop\b|\brap\b|说唱/iu.test(direction)) return "hip-hop";
  if (/\bcity\s*pop\b|城市流行/iu.test(direction)) return "city pop";
  return direction;
}

function isQuietJazzText(text: string): boolean {
  return /\bjazz\b|爵士/iu.test(text) && /\bquiet|calm|soft|mellow|reading|read\b|安静|阅读/iu.test(text);
}

function taskFitsExplicitDirection(direction: string, task: RadioAgentCandidateTask): boolean {
  const taskText = normalizeQueryForRepair([task.query, task.reason, task.style].join(" "));
  const keywords = explicitDirectionKeywords(direction);
  if (!keywords.length) return true;
  return keywords.some((keyword) => taskText.includes(keyword));
}

function explicitDirectionKeywords(direction: string): string[] {
  const normalized = normalizeQueryForRepair(direction);
  const keywords: string[] = [];
  if (/\bjazz\b|爵士/iu.test(direction)) keywords.push("jazz");
  if (isRnbText(direction)) keywords.push("r&b", "rnb", "soul", "vocal");
  if (/\bneo[-\s]?soul\b|\bsoul\b|灵魂/iu.test(direction)) keywords.push("soul");
  if (/\bhip[-\s]?hop\b|\brap\b|说唱/iu.test(direction)) keywords.push("hip hop", "rap");
  keywords.push(
    ...normalized
      .split(/\s+/u)
      .filter((token) => token.length >= 3)
      .filter((token) => !/^(?:play|put|queue|give|want|need|some|more|music|song|songs|track|tracks|for|with|the|and|please|now|next|today|tonight)$/u.test(token)),
  );
  return uniqueStrings(keywords.map(normalizeQueryForRepair)).slice(0, 8);
}

function hasExplicitDirectionCue(text: string): boolean {
  return /^\s*(?:please\s+|pls\s+)?(?:play|put on|queue|give me|i want|i need|want|need|switch to|change to|more of|more)\b|^\s*(?:播放|放点|播点|来点|听点|想听|换成|换点|给我来点|给我放点)/iu.test(text);
}

function hasMusicDirectionSignal(text: string): boolean {
  return /\br\s*&?\s*b\b|\brnb\b|\bjazz\b|\bhip[-\s]?hop\b|\bsoul\b|\bpop\b|\brock\b|\bambient\b|\bclassical\b|\belectronic\b|\bcity\s*pop\b|爵士|古典|电子|氛围|民谣|摇滚|流行|说唱|灵魂|人声|律动/iu.test(text);
}

function isExplanationLikeUserText(text: string): boolean {
  return /\bwhy\b|\breason\b|\bexplain\b|为什么|为啥|理由|原因/iu.test(text);
}

function isNegativeDirectionText(text: string): boolean {
  return /^\s*(?:less|avoid|skip|no|don't|dont|do not|dislike)\b|不要|别放|别播|不想听|少来点/u.test(text);
}

function dedupeCandidateTasks(tasks: RadioAgentCandidateTask[]): RadioAgentCandidateTask[] {
  const seen = new Set<string>();
  const result: RadioAgentCandidateTask[] = [];
  for (const task of tasks) {
    const key = normalizeQueryForRepair(task.query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(task);
  }
  return result;
}

function toCandidateTask(value: unknown): RadioAgentCandidateTask | null {
  if (!isRecord(value)) return null;
  const task: RadioAgentCandidateTask = {
    query: stringValue(valueFor(value, "query")),
    reason: stringValue(valueFor(value, "reason")) || "This fits the current radio direction.",
    style: stringValue(valueFor(value, "style")),
    negativeConstraints: stringArray(valueFor(value, "negativeConstraints")),
  };
  return isAllowedCandidateTask(task) ? task : null;
}

function isAllowedCandidateTask(task: RadioAgentCandidateTask): boolean {
  const query = task.query.trim();
  if (!query) return false;
  if (RAW_COMMAND_QUERY.test(query)) return false;
  if (UTILITY_AUDIO_QUERY.test(query)) return false;
  return true;
}

function taskFitsContract(context: RadioAgentContextSnapshot, task: RadioAgentCandidateTask): boolean {
  const goal = contractAnchor(context.contract);
  const explicitDirection = latestExplicitUserDirection(context);
  if (explicitDirection) return taskFitsExplicitDirection(explicitDirection, task);
  if (taskMatchesContractMoves(task, [...contractBlockedMoves(context.contract), ...contractBridgeOnlyMoves(context.contract)])) return false;
  if (!isRnbContractGoal(goal)) return true;

  const taskText = [
    task.query,
    task.reason,
    task.style,
  ].join(" ");
  if (isOffContractForRnb(taskText)) {
    return false;
  }
  return queryFitsRnbContract(taskText);
}

function isOffContractForRnb(text: string): boolean {
  return /\b(anyma|innellea|colyn|martin garrix|meduza|edm|techno|trance|festival|classical|modern classical|concerto|sonata|quartet|ambient|piano ambient|piano interlude|ambient electronic|pure ambient|instrumental|glenn gould|nils frahm|max richter|jon hopkins|sakamoto|olafur)\b|电子|古典|氛围|钢琴/u.test(text);
}

function sanitizeWindowTextForContract(
  context: RadioAgentContextSnapshot,
  text: string,
  field: "brief" | "direction" | "return",
  tasks: RadioAgentCandidateTask[],
): string {
  const contract = contractAnchor(context.contract);
  if (!isRnbContractGoal(contract) || !isOffContractForRnb(text)) return text;

  const anchor = listenerFacingTaskAnchor(tasks[0]);
  if (field === "brief") return "Keep the current R&B radio focused on vocals, groove, and close soul textures.";
  if (field === "direction") {
    return anchor
      ? `Stay in the R&B lane with ${anchor} as the next safe anchor.`
      : "Stay in the R&B lane with vocal and groove-forward choices.";
  }
  return "Stay in R&B until the listener asks to move elsewhere.";
}

function sanitizeAllowedAdjacentForContract(context: RadioAgentContextSnapshot, moves: string[]): string[] {
  const contract = contractAnchor(context.contract);
  if (!isRnbContractGoal(contract)) return moves;
  return moves.filter((move) => !isOffContractForRnb(move));
}

function sanitizeHostIntentForContract(
  context: RadioAgentContextSnapshot,
  hostIntent: RadioAgentHostIntent,
  tasks: RadioAgentCandidateTask[],
): RadioAgentHostIntent {
  const explicitDirection = latestExplicitUserDirection(context);
  if (explicitDirection && context.eventType === "user_text") {
    return explicitDirectionHostIntent(explicitDirection);
  }

  const contract = contractAnchor(context.contract);
  if (hostIntent.event === "silent" && hostIntent.reason === "unsafe_model_host_text") {
    return safeReplacementHostIntent(context, tasks, "replaced unsafe model host text");
  }
  if (!isRnbContractGoal(contract) || !hostIntent.shouldSpeak || !isOffContractForRnb(hostIntent.text)) return hostIntent;

  const anchor = listenerFacingTaskAnchor(tasks[0]);
  return {
    shouldSpeak: true,
    event: "return_to_contract",
    reason: "keeps explicit R&B request in bounds",
    text: sanitizeHostText(anchor ? `我把方向收回 R&B，下一首先用 ${anchor} 稳住人声和律动。` : "我把方向收回 R&B，先守住人声和律动。"),
  };
}

function listenerFacingTaskAnchor(task: RadioAgentCandidateTask | undefined): string {
  return task?.query?.trim() || "";
}

function safeReplacementHostIntent(
  context: RadioAgentContextSnapshot,
  tasks: RadioAgentCandidateTask[],
  reason: string,
): RadioAgentHostIntent {
  const anchor = listenerFacingTaskAnchor(tasks[0]);
  const isRnb = isRnbContractGoal(contractAnchor(context.contract));
  const text = sanitizeHostText(
    isRnb
      ? anchor
        ? `我把方向收回 R&B，下一首用 ${anchor} 稳住人声和律动。`
        : "我把方向收回 R&B，先守住人声和律动。"
      : anchor
        ? `我先接一首 ${anchor}，把电台稳住。`
        : "我先接一首稳一点的，把电台续上。",
  );
  return text
    ? { shouldSpeak: true, event: "return_to_contract", reason, text }
    : silentHostIntent("safe_replacement_host_text_filtered");
}

function toHostIntent(value: unknown): RadioAgentHostIntent {
  if (!isRecord(value)) return silentHostIntent("missing_host_intent");

  const shouldSpeak = valueFor(value, "shouldSpeak") === true;
  const event = hostEventValue(valueFor(value, "event"));
  const reason = stringValue(valueFor(value, "reason"));
  const rawText = stringValue(valueFor(value, "text"));
  const text = sanitizeHostText(rawText);

  if (shouldSpeak && event !== "silent" && rawText && !text) {
    return silentHostIntent(INTERNAL_HOST_TERMS.test(rawText) ? "unsafe_internal_host_text" : "unsafe_model_host_text");
  }
  if (!shouldSpeak || event === "silent" || !text) return silentHostIntent(reason || "silent");
  return { shouldSpeak: true, event, reason, text };
}

function sanitizeHostText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (INTERNAL_HOST_TERMS.test(compact)) return "";
  if (AWKWARD_HOST_TERMS.test(compact) || MOJIBAKE_HOST_TERMS.test(compact)) return "";
  return compact.length <= HOST_TEXT_LIMIT ? compact : compact.slice(0, HOST_TEXT_LIMIT).trim();
}

function silentHostIntent(reason: string): RadioAgentHostIntent {
  return { shouldSpeak: false, event: "silent", reason, text: "" };
}

function explicitDirectionHostIntent(direction: string): RadioAgentHostIntent {
  const text = sanitizeHostText(explicitDirectionHostText(direction));
  return text
    ? {
        shouldSpeak: true,
        event: "request_ack",
        reason: "listener changed the active music direction",
        text,
      }
    : silentHostIntent("explicit_direction_host_text_filtered");
}

function explicitDirectionHostText(direction: string): string {
  if (isQuietJazzText(direction)) return "\u597d\uff0c\u63a5\u4e0b\u6765\u6536\u8fdb\u5b89\u9759\u7235\u58eb\uff0c\u9002\u5408\u9605\u8bfb\uff0c\u6211\u5148\u7ed9\u4f60\u627e\u4e00\u9996\u7a33\u7684\u3002";
  if (isRnbText(direction)) return "\u597d\uff0c\u63a5\u4e0b\u6765\u6536\u8fdb R&B\uff0c\u6211\u5148\u627e\u4e00\u9996\u4eba\u58f0\u548c\u5f8b\u52a8\u90fd\u7a33\u7684\u3002";
  return `\u597d\uff0c\u63a5\u4e0b\u6765\u6309 ${direction} \u8d70\uff0c\u6211\u5148\u627e\u4e00\u9996\u7a33\u7684\u3002`;
}

function fallbackHostIntent(context: RadioAgentContextSnapshot): RadioAgentHostIntent {
  const explicitDirection = latestExplicitUserDirection(context);
  if (explicitDirection && context.eventType === "user_text") {
    return explicitDirectionHostIntent(explicitDirection);
  }

  if (!shouldFallbackHostSpeak(context)) return silentHostIntent("fallback_low_interruption");

  if (hasExecutionRepair(context.repair)) {
    const text = recoveryHostText(context);
    if (text) {
      return {
        shouldSpeak: true,
        event: "recovery",
        reason: "recovering from the last failed queue attempt",
        text,
      };
    }
  }

  const anchor = fallbackHostAnchor(context);
  const text = sanitizeHostText(
    anchor
      ? `我先顺着 ${anchor} 的方向接一首，把电台稳住。`
      : "我先接一首稳一点的，把电台续上。",
  );
  if (!text) return silentHostIntent("fallback_host_text_filtered");

  return {
    shouldSpeak: true,
    event: "return_to_contract",
    reason: "first queue pressure continuity handoff",
    text,
  };
}

function shouldFallbackHostSpeak(context: RadioAgentContextSnapshot): boolean {
  if (context.eventType !== "queue_low" && context.eventType !== "track_completed") return false;
  return !hasReadyAgentProgramItem(context);
}

function hasReadyAgentProgramItem(context: RadioAgentContextSnapshot): boolean {
  return context.readyQueue.some((track) => track.selectionReason?.type === "radio_agent_program");
}

function hasExecutionRepair(repair: string): boolean {
  return /\b(Execution could not prepare|Playback recovery could not continue|program_executor_no_track|queue_empty_after_all_recovery|trace_save_failed|assisted_queue_failed)\b/i.test(repair);
}

function recoveryHostText(context: RadioAgentContextSnapshot): string {
  const anchor = fallbackRecoveryAnchor(context);
  const direction = isRnbContractGoal(contractAnchor(context.contract)) ? "R&B" : "这个方向";
  return sanitizeHostText(
    anchor
      ? `刚才那一下没接稳，我换一首更稳的 ${anchor}，继续守住 ${direction}。`
      : `刚才那一下没接稳，我先换一首更稳的，继续守住 ${direction}。`,
  );
}

function fallbackRecoveryAnchor(context: RadioAgentContextSnapshot): string {
  const failedQueries = repairFailedQueries(context.repair);
  return fallbackCandidateTasks(context).find((task) => !queryWasRecentlyFailed(task.query, failedQueries))?.query || fallbackHostAnchor(context);
}

function fallbackHostAnchor(context: RadioAgentContextSnapshot): string {
  const explicitDirection = latestExplicitUserDirection(context);
  if (explicitDirection) return explicitDirection;

  const contract = contractAnchor(context.contract);
  const explicitContract = explicitContractFallbackQueries(context)[0] || "";
  if (explicitContract && isRnbContractGoal(contract)) return listenerFacingContractAnchor(contract);
  const avoids = fallbackNegativeConstraints(context);
  const anchor = [
    ...reflectionCompletedArtists(context.reflection),
    ...reflectionPositiveAnchors(context.reflection),
    ...context.memoryHypotheses.map(memoryAnchor),
    ...context.memoryFacts.map(memoryAnchor),
    ...profileAnchors(context.profile),
    context.currentTrack?.artist,
    ...context.readyQueue.map((track) => track.artist),
  ].find((candidate) => candidate && !queryMatchesAvoids(candidate, avoids) && (!contract || anchorFitsContract(contract, candidate)));
  if (anchor) return anchor;
  if (isRnbContractGoal(contract)) return "R&B";
  return contract;
}

function explicitContractFallbackQueries(context: RadioAgentContextSnapshot): string[] {
  const explicitArtist = explicitArtistSessionAnchor(context);
  if (explicitArtist) return [explicitArtist];

  const contract = contractAnchor(context.contract);
  if (!contract || isGenericContractGoal(contract)) return [];

  if (isRnbContractGoal(contract)) {
    return uniqueStrings([
      listenerFacingContractAnchor(contract),
      ...rnbContractQueries(recentPlaybackTracks(context)),
    ]);
  }

  return [contract];
}

function explicitArtistSessionAnchor(context: RadioAgentContextSnapshot): string {
  const sessionAnchor = context.session.match(/^active_request:\s*(.+)$/imu)?.[1]?.trim() || "";
  const contractAnchorText =
    context.contract.match(/\bcentered on\s+(.+?)\s+until\b/iu)?.[1]?.trim() ||
    context.contract.match(/\bUse\s+(.+?)\s+as the primary session anchor\b/iu)?.[1]?.trim() ||
    "";
  const anchor = cleanSessionAnchor(sessionAnchor || contractAnchorText);
  if (!anchor || isGenericContractGoal(anchor) || isBroadStyleSessionAnchor(anchor)) return "";
  return anchor;
}

function cleanSessionAnchor(value: string): string {
  if (/^\s*(?:avoid|less|skip|no|don't|dont|do not|dislike)\b/i.test(value)) return "";
  return value
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
}

function isBroadStyleSessionAnchor(value: string): boolean {
  return /^(?:r\s*&?\s*b|rnb|alt[-\s]?r\s*&?\s*b|neo[-\s]?soul|soul|pop|rock|jazz|edm|electronic|ambient|classical)$/i.test(value.trim());
}

function listenerFacingContractAnchor(contractGoal: string): string {
  const compact = contractGoal.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (isRnbContractGoal(compact)) {
    if (/\bafternoon\b/i.test(compact) || /下午/.test(compact)) return "afternoon relaxed R&B vocals";
    if (/\blate[-\s]?night\b/i.test(compact) || /深夜|夜/.test(compact)) return "late-night R&B vocals";
    if (/\bvocal|vocals|人声/i.test(compact)) return "R&B vocals";
    return "relaxed R&B groove";
  }
  return compact;
}

function traceBasisFromContext(context: RadioAgentContextSnapshot): RadioAgentProgramWindow["traceBasis"] {
  return {
    profile: context.profile,
    now: context.now,
    contract: context.contract,
    session: context.session,
    reflection: context.reflection,
    eventType: context.eventType,
  };
}

function repairFailedQueries(repair: string): string[] {
  return [
    ...repairSectionLines(repair, "Evidence"),
    ...repairSectionLines(repair, "Failed Queries"),
  ]
    .map((line) => line.replace(/\s+\([^)]*\)\s*$/u, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function repairSectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  const result: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      inSection = line.replace(/^##\s+/u, "").trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = line.replace(/^\s*-\s*/u, "").trim();
    if (item && item.toLowerCase() !== "none") result.push(item);
  }
  return result;
}

function queryWasRecentlyFailed(query: string, failedQueries: string[]): boolean {
  const normalizedQuery = normalizeQueryForRepair(query);
  if (!normalizedQuery) return false;
  return failedQueries.some((failed) => {
    const normalizedFailed = normalizeQueryForRepair(failed);
    return normalizedFailed === normalizedQuery;
  });
}

function queryMatchesAvoids(query: string, avoids: string[]): boolean {
  const normalizedQuery = normalizeQueryForRepair(query);
  if (!normalizedQuery) return false;
  return avoids.some((avoid) => {
    const normalizedAvoid = normalizeQueryForRepair(avoid);
    return Boolean(
      normalizedAvoid &&
        (normalizedAvoid === normalizedQuery ||
          normalizedQuery.includes(normalizedAvoid) ||
          normalizedAvoid.includes(normalizedQuery)),
    );
  });
}

function taskMatchesAvoids(task: RadioAgentCandidateTask, avoids: string[]): boolean {
  return queryMatchesAvoids([task.query, task.reason, task.style].join(" "), avoids);
}

function taskMatchesContractMoves(task: RadioAgentCandidateTask, moves: string[]): boolean {
  return queryMatchesAvoids([task.query, task.reason, task.style].join(" "), moves);
}

function normalizeQueryForRepair(query: string): string {
  return query
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}&.+ ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed: unknown = JSON.parse(withoutFence);
  if (!isRecord(parsed)) throw new Error("program plan JSON must be an object");
  return parsed;
}

function valueFor(record: Record<string, unknown>, camelKey: string): unknown {
  return record[camelKey] ?? record[toSnakeCase(camelKey)];
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function fallbackStationBrief(context: RadioAgentContextSnapshot): string {
  const explicitDirection = latestExplicitUserDirection(context);
  if (explicitDirection) return explicitDirection;

  const contractGoal = normalizedContractGoal(firstContractLine(context.contract, "station_goal"));
  const profileGoal = listenerFacingProfileGoal(context.profile);
  if (contractGoal && profileGoal && isGenericContractGoal(contractGoal)) {
    return `${contractGoal}; keep it close to ${profileGoal}.`;
  }
  return listenerFacingGoal(contractGoal, [...context.memoryHypotheses, ...context.memoryFacts]) || profileGoal || "Keep the current personal radio session coherent.";
}

function fallbackMainDirection(context: RadioAgentContextSnapshot): string {
  const explicitDirection = latestExplicitUserDirection(context);
  if (explicitDirection) return explicitDirection;

  const contract = contractAnchor(context.contract);
  const explicitContract = explicitContractFallbackQueries(context)[0] || "";
  if (explicitContract) return explicitContract;
  const avoids = fallbackNegativeConstraints(context);
  const anchor = [
    ...reflectionCompletedArtists(context.reflection),
    ...reflectionPositiveAnchors(context.reflection),
    ...context.memoryHypotheses.map(memoryAnchor),
    ...context.memoryFacts.map(memoryAnchor),
    ...profileAnchors(context.profile),
    context.currentTrack?.artist,
    context.currentTrack?.name,
  ].find((candidate) => candidate && !queryMatchesAvoids(candidate, avoids));
  if (contract && (!anchor || !anchorFitsContract(contract, anchor))) return contract;
  return anchor ? `Stay close to ${anchor} and keep the current radio mood coherent.` : "Keep the current radio mood coherent.";
}

function firstContractLine(contract: string, key: string): string {
  const match = contract.match(new RegExp(`${key}\\s*:\\s*([^\\n]+)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function extractDisallowed(contract: string): string[] {
  const avoid = firstContractLine(contract, "avoid");
  return uniqueStrings([...avoid.split(",").map((item) => item.trim()).filter(Boolean), ...contractBlockedMoves(contract)]);
}

function fallbackNegativeConstraints(context: RadioAgentContextSnapshot): string[] {
  return uniqueStrings([
    ...extractDisallowed(context.contract),
    ...durableAvoids(context.memoryFacts),
    ...reflectionTemporaryAvoids(context.reflection),
    ...reflectionSkippedAvoids(context.reflection),
    ...sessionEvidenceAvoids(context.sessionEvidence),
  ]);
}

function durableAvoids(memories: RadioAgentMemory[]): string[] {
  return memories.map(durableAvoidAnchor).filter(Boolean);
}

function durableAvoidAnchor(memory: RadioAgentMemory | undefined): string {
  if (!memory || memory.kind !== "taste_fact") return "";
  if (memory.key.startsWith("avoid_artist:")) return memory.key.split(":").slice(1).join(":").trim();
  return "";
}

function contractBlockedMoves(contract: string): string[] {
  return reflectionSectionLines(contract, "Blocked Moves").filter(Boolean).slice(0, 12);
}

function contractBridgeOnlyMoves(contract: string): string[] {
  return reflectionSectionLines(contract, "Bridge-Only Moves").filter(Boolean).slice(0, 12);
}

function sessionEvidenceAvoids(memories: RadioAgentMemory[]): string[] {
  return memories.map(sessionAvoidAnchor).filter(Boolean);
}

function sessionAvoidAnchor(memory: RadioAgentMemory | undefined): string {
  if (!memory || memory.kind !== "session_evidence") return "";
  if (memory.key.startsWith("session_avoid_track:")) return trackAvoidAnchor(memory.value);
  if (memory.key.startsWith("session_avoid:")) return memory.key.split(":").slice(1).join(":").trim();
  const match = memory.value.match(/\bsession-only avoid of\s+([^.;]+)/i)?.[1]?.trim();
  return match || "";
}

function trackAvoidAnchor(value: string): string {
  const match = value.match(/\bskipped\s+([^.;]+?)(?:;\s*treat|\.\s*treat|$)/i)?.[1]?.trim() || "";
  if (!match) return "";
  const title = match.split(/\s+-\s+/u)[0]?.trim() || "";
  return title || match;
}

function reflectionPositiveAnchors(reflection: string): string[] {
  const anchors: string[] = [];
  for (const candidate of reflectionSectionLines(reflection, "Session Signals")) {
    const anchor = reflectionAnchorFromLine(candidate);
    if (anchor) anchors.push(anchor);
  }
  for (const candidate of reflectionSectionLines(reflection, "Long-Term Candidates")) {
    const anchor = reflectionAnchorFromLine(candidate);
    if (anchor) anchors.push(anchor);
  }
  return uniqueStrings(anchors).filter((anchor) => !reflectionAvoidLooksLikeOnlyConstraint(anchor)).slice(0, 4);
}

function reflectionCompletedArtists(reflection: string): string[] {
  return uniqueStrings(
    reflectionSectionLines(reflection, "Completed Tracks")
      .map(trackArtistFromReflectionLine)
      .filter(Boolean),
  ).slice(0, 4);
}

function reflectionSkippedAvoids(reflection: string): string[] {
  return uniqueStrings(
    reflectionSectionLines(reflection, "Skipped Tracks").flatMap((line) => [
      trackArtistFromReflectionLine(line),
      trackTitleFromReflectionLine(line),
    ].filter(Boolean)),
  ).slice(0, 8);
}

function reflectionTemporaryAvoids(reflection: string): string[] {
  return reflectionSectionLines(reflection, "Temporary Avoids").filter(Boolean).slice(0, 8);
}

function reflectionSessionAvoids(reflection: string): string[] {
  return uniqueStrings([...reflectionSkippedAvoids(reflection), ...reflectionTemporaryAvoids(reflection)]).slice(0, 12);
}

function reflectionSectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  const result: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      inSection = line.replace(/^##\s+/u, "").trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = line.replace(/^\s*-\s*/u, "").trim();
    if (item && item.toLowerCase() !== "none") result.push(item);
  }
  return result;
}

function trackArtistFromReflectionLine(line: string): string {
  const withoutId = line.replace(/\s+\([^)]*\)\s*$/u, "").trim();
  const parts = withoutId.split(/\s+-\s+/u).map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(1).join(" - ") : "";
}

function trackTitleFromReflectionLine(line: string): string {
  const withoutId = line.replace(/\s+\([^)]*\)\s*$/u, "").trim();
  const parts = withoutId.split(/\s+-\s+/u).map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[0] || "" : "";
}

function reflectionAnchorFromLine(line: string): string {
  const key = line.split(":")[0]?.trim() || "";
  if (/^(session_)?artist:/i.test(line)) {
    const afterPrefix = line.replace(/^(?:session_)?artist:/i, "").split(":")[0]?.trim();
    if (afterPrefix) return afterPrefix;
  }
  if (/^(session_)?artist$/i.test(key)) {
    const firstValue = line.split(":").slice(1).join(":").split(/[.;]/u)[0]?.trim();
    if (firstValue) return firstValue;
  }
  const repeatedArtist = line.match(/\brepeatedly returned to\s+([^.;]+)/i)?.[1]?.trim();
  if (repeatedArtist) return repeatedArtist;
  return "";
}

function reflectionAvoidLooksLikeOnlyConstraint(value: string): boolean {
  return /generic|electronic|edm|classical|ambient|piano|bad-track|skip/i.test(value);
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function styleFromContract(contract: string): string {
  const goal = normalizedContractGoal(firstContractLine(contract, "station_goal"));
  return RAW_MEMORY_EVIDENCE_TERMS.test(goal) ? "" : goal;
}

function contractAnchor(contract: string): string {
  const goal = normalizedContractGoal(firstContractLine(contract, "station_goal"));
  if (!RAW_MEMORY_EVIDENCE_TERMS.test(goal)) return goal;
  return evidenceAnchorsFromText(goal)[0] ?? "";
}

function normalizedContractGoal(goal: string): string {
  let text = goal.replace(/\s+/gu, " ").trim();
  for (let index = 0; index < 4; index += 1) {
    const previous = text;
    text = text
      .replace(/^Stay with\s+/iu, "")
      .replace(/^Follow\s+/iu, "")
      .replace(/\s+as the active listener direction\.?$/iu, "")
      .replace(/\s+as the active station direction\.?$/iu, "")
      .replace(/[.。]+$/u, "")
      .trim();
    if (text === previous) break;
  }
  return text;
}

function anchorFitsContract(contractGoal: string, anchor: string): boolean {
  if (!isRnbContractGoal(contractGoal)) return true;
  return queryFitsRnbContract(anchor);
}

function isRnbContractGoal(goal: string): boolean {
  return isRnbText(goal);
}

function queryFitsRnbContract(query: string): boolean {
  if (isRnbText(query)) return true;
  return /\b(vocal|vocals|soul|slow jam|slow jams)\b/i.test(query);
}

function contractDefaultQueries(contractGoal: string): string[] {
  if (!isRnbContractGoal(contractGoal)) return [];
  return rnbContractQueries([]);
}

function rnbContractQueries(recentTracks: RadioAgentProgramWindow["recentTracks"] = []): string[] {
  return STYLE_SEEDS.queriesFor("R&B", recentTracks || []);
}

function isRnbText(text: string): boolean {
  return /\br\s*&?\s*b\b|\brnb\b|alt[-\s]?r\s*&?\s*b|neo[-\s]?soul|frank ocean|sza|daniel caesar|h\.?e\.?r\.?|brent faiyaz|jorja smith|kelela|ravyn lenae|snoh aalegra|giveon|summer walker|the weeknd|partynextdoor/i.test(text);
}

function memoryAnchor(memory: RadioAgentMemory | undefined): string {
  if (!memory) return "";
  if (/^avoid_/i.test(memory.key)) return "";
  const keyed = memory.key.includes(":") ? memory.key.split(":").slice(1).join(":") : memory.key;
  if (keyed.trim()) return keyed.trim();
  const artistMatch = memory.value.match(/\bfor\s+([A-Z][A-Za-z0-9 .+'&-]+)/);
  return artistMatch?.[1]?.replace(/\.$/, "").trim() ?? "";
}

function profileAnchors(profile: string): string[] {
  const anchors: string[] = [];
  for (const line of profileSectionLines(profile, "Stable Taste Facts")) {
    const anchor = profileAnchorFromLine(line);
    if (anchor) anchors.push(anchor);
  }
  for (const line of profileSectionLines(profile, "Hypotheses")) {
    const anchor = profileAnchorFromLine(line);
    if (anchor) anchors.push(anchor);
  }
  return uniqueStrings(anchors).slice(0, 6);
}

function profileSectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/u);
  const result: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      inSection = line.replace(/^##\s+/u, "").trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = line.replace(/^\s*-\s*/u, "").trim();
    if (item && item.toLowerCase() !== "none") result.push(item);
  }
  return result;
}

function profileAnchorFromLine(line: string): string {
  const keyMatch = line.match(/^(artist|album|theme):([^:]+):/i);
  if (keyMatch?.[2]?.trim()) return keyMatch[2].trim();

  const evidenceMatch = line.match(/\brepeated (?:library )?evidence for\s+([^.(;]+)/i)?.[1]?.trim();
  if (evidenceMatch) return evidenceMatch;

  const returnsMatch = line.match(/\breturns? to\s+([^.(;]+?)\s+for\b/i)?.[1]?.trim();
  if (returnsMatch) return returnsMatch;

  const suggestMatch = line.match(/\b(?:mention|suggest)\s+([^.(;]+)/i)?.[1]?.trim();
  if (suggestMatch) return suggestMatch;

  return "";
}

function listenerFacingGoal(goal: string, memories: RadioAgentMemory[]): string {
  const compact = goal.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (!RAW_MEMORY_EVIDENCE_TERMS.test(compact)) return compact;

  const anchors = Array.from(new Set([...evidenceAnchorsFromText(compact), ...memories.map(memoryAnchor)].filter(Boolean))).slice(0, 3);
  if (!anchors.length) return "Keep the current personal radio session coherent.";
  return `Keep the radio close to familiar anchors like ${humanList(anchors)}.`;
}

function listenerFacingProfileGoal(profile: string): string {
  const anchors = profileAnchors(profile).slice(0, 3);
  if (!anchors.length) return "";
  return `familiar anchors like ${humanList(anchors)}`;
}

function isGenericContractGoal(goal: string): boolean {
  return /\b(personal radio|mellow|coherent|current radio mood|radio session)\b/i.test(goal);
}

function evidenceAnchorsFromText(text: string): string[] {
  const anchors: string[] = [];
  for (const match of text.matchAll(/\b(?:for|from)\s+([^.;]+)/gi)) {
    const anchor = match[1]?.trim();
    if (anchor) anchors.push(anchor);
  }
  for (const match of text.matchAll(/\b(?:mention|suggest)\s+([^.;]+)/gi)) {
    const anchor = match[1]?.trim();
    if (anchor) anchors.push(anchor);
  }
  return anchors;
}

function humanList(items: string[]): string {
  const unique = Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
  if (unique.length <= 2) return unique.join(" and ");
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

function formatMemory(memory: RadioAgentMemory): string {
  return `- ${memory.key}: ${memory.value} confidence=${memory.confidence} evidence=${memory.evidenceCount}`;
}

function section(name: string, content: string): string {
  return `## ${name}\n${content || "(empty)"}`;
}

function makeWindowId(context: RadioAgentContextSnapshot, createdAt: string): string {
  const uidPart = context.uid ?? "anonymous";
  const sessionPart = context.sessionId ?? "sessionless";
  return `radio-window:${uidPart}:${sessionPart}:${createdAt}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hostEventValue(value: unknown): RadioAgentHostIntent["event"] {
  return typeof value === "string" && HOST_EVENTS.includes(value as RadioAgentHostIntent["event"])
    ? (value as RadioAgentHostIntent["event"])
    : "silent";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withPlanningTimeout(work: Promise<string>, timeoutMs: number): Promise<string> {
  if (timeoutMs <= 0) return await work;
  return await Promise.race([
    work,
    new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("program_director_model_timeout")), timeoutMs)),
  ]);
}

function debugProgramDirector(event: string, payload: Record<string, unknown>): void {
  if (!RADIO_AGENT_DEBUG) return;
  console.log(`[RADIO_AGENT_PROGRAM_DIRECTOR_DEBUG] ${event} ${JSON.stringify(payload)}`);
}
