import type {
  RadioAgentCandidateTask,
  RadioAgentContextSnapshot,
  RadioAgentHostIntent,
  RadioAgentMemory,
  RadioAgentProgramWindow,
} from "./types.js";

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
const PROGRAM_DIRECTOR_SYSTEM =
  "You are FREQME's personal AI radio program director. Return only valid JSON. Never mention models, prompts, traces, verification, tool calls, or internal systems.";
const DEFAULT_FALLBACK_QUERY = "warm vocal radio discovery";
const INTERNAL_HOST_TERMS =
  /\b(model|json|candidate|trace|prompt|verification|shadow mode|tool call|deterministic|contract)\b/i;
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

export class RadioAgentProgramDirector {
  constructor(
    private readonly model: ProgramPlanningModel | null,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async plan(context: RadioAgentContextSnapshot): Promise<RadioAgentProgramWindow> {
    const createdAt = this.now();

    if (this.model) {
      try {
        const prompt = buildPrompt(context, createdAt);
        const raw = await this.model.chat(prompt, {
          maxTokens: PROGRAM_DIRECTOR_MAX_TOKENS,
          system: PROGRAM_DIRECTOR_SYSTEM,
          responseFormat: { type: "json_object" },
          timeoutMs: PROGRAM_DIRECTOR_TIMEOUT_MS,
        });
        const parsed = parseJsonObject(raw);
        const window = buildWindowFromParsed(context, parsed, createdAt, "model");
        if (window.candidateTasks.length > 0) return window;
      } catch {
        // The agent can keep programming from durable context when planning fails.
      }
    }

    return buildFallbackWindow(context, createdAt);
  }
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
  const candidateTasks = arrayValue(valueFor(parsed, "candidateTasks"))
    .map(toCandidateTask)
    .filter((task): task is RadioAgentCandidateTask => task !== null)
    .filter((task) => taskFitsContract(context, task))
    .slice(0, MAX_CANDIDATE_TASKS);

  return {
    id: makeWindowId(context, createdAt),
    uid: context.uid,
    sessionId: context.sessionId,
    stationBrief: stringValue(valueFor(parsed, "stationBrief")) || fallbackStationBrief(context),
    mainDirection: stringValue(valueFor(parsed, "mainDirection")) || fallbackMainDirection(context),
    allowedAdjacent: stringArray(valueFor(parsed, "allowedAdjacent")),
    bridgeBudget: numberValue(valueFor(parsed, "bridgeBudget"), 1),
    disallowed: stringArray(valueFor(parsed, "disallowed")),
    returnRequirement: stringValue(valueFor(parsed, "returnRequirement")) || "Return to the station brief after adjacent exploration.",
    candidateTasks,
    hostIntent: toHostIntent(valueFor(parsed, "hostIntent")),
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
    traceBasis: traceBasisFromContext(context),
    source: "deterministic_fallback",
    createdAt,
  };
}

function fallbackCandidateTasks(context: RadioAgentContextSnapshot): RadioAgentCandidateTask[] {
  const contract = contractAnchor(context.contract);
  const failedQueries = repairFailedQueries(context.repair);
  const skippedAvoids = reflectionSkippedAvoids(context.reflection);
  const anchors = [
    ...reflectionCompletedArtists(context.reflection),
    ...reflectionPositiveAnchors(context.reflection),
    ...context.memoryHypotheses.map(memoryAnchor),
    ...context.memoryFacts.map(memoryAnchor),
    ...profileAnchors(context.profile),
    context.currentTrack?.artist,
    ...context.readyQueue.map((track) => track.artist),
    contract,
    ...contractDefaultQueries(contract),
    DEFAULT_FALLBACK_QUERY,
  ]
    .filter((anchor): anchor is string => Boolean(anchor?.trim()))
    .map((anchor) => anchor.trim());

  const uniqueAnchors = Array.from(new Set(anchors));
  const tasks = uniqueAnchors.map((anchor) => ({
    query: anchor,
    reason: "This stays close to known taste while keeping the current radio mood coherent.",
    style: styleFromContract(context.contract),
    negativeConstraints: fallbackNegativeConstraints(context),
  }));

  return tasks
    .filter(isAllowedCandidateTask)
    .filter((task) => !queryWasRecentlyFailed(task.query, failedQueries))
    .filter((task) => !queryMatchesAvoids(task.query, skippedAvoids))
    .filter((task) => taskFitsContract(context, task))
    .slice(0, MAX_CANDIDATE_TASKS);
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
  if (!isRnbContractGoal(goal)) return true;

  const queryText = task.query.toLowerCase();
  if (/\b(anyma|innellea|martin garrix|meduza|edm|techno|trance|festival|classical|concerto|sonata|quartet|piano ambient|nils frahm|max richter)\b/i.test(queryText)) {
    return false;
  }
  return queryFitsRnbContract(queryText);
}

function toHostIntent(value: unknown): RadioAgentHostIntent {
  if (!isRecord(value)) return silentHostIntent("missing_host_intent");

  const shouldSpeak = valueFor(value, "shouldSpeak") === true;
  const event = hostEventValue(valueFor(value, "event"));
  const reason = stringValue(valueFor(value, "reason"));
  const text = sanitizeHostText(stringValue(valueFor(value, "text")));

  if (!shouldSpeak || event === "silent" || !text) return silentHostIntent(reason || "silent");
  return { shouldSpeak: true, event, reason, text };
}

function sanitizeHostText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (INTERNAL_HOST_TERMS.test(compact)) return "";
  return compact.length <= HOST_TEXT_LIMIT ? compact : compact.slice(0, HOST_TEXT_LIMIT).trim();
}

function silentHostIntent(reason: string): RadioAgentHostIntent {
  return { shouldSpeak: false, event: "silent", reason, text: "" };
}

function fallbackHostIntent(context: RadioAgentContextSnapshot): RadioAgentHostIntent {
  if (!shouldFallbackHostSpeak(context)) return silentHostIntent("fallback_low_interruption");

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

function fallbackHostAnchor(context: RadioAgentContextSnapshot): string {
  const contract = contractAnchor(context.contract);
  const anchor =
    reflectionCompletedArtists(context.reflection)[0] ||
    reflectionPositiveAnchors(context.reflection)[0] ||
    memoryAnchor(context.memoryHypotheses[0]) ||
    memoryAnchor(context.memoryFacts[0]) ||
    profileAnchors(context.profile)[0] ||
    context.currentTrack?.artist ||
    context.readyQueue[0]?.artist ||
    "";
  if (anchor && (!contract || anchorFitsContract(contract, anchor))) return anchor;
  if (isRnbContractGoal(contract)) return "R&B";
  return contract;
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
    return Boolean(normalizedAvoid && normalizedAvoid === normalizedQuery);
  });
}

function normalizeQueryForRepair(query: string): string {
  return query.toLowerCase().replace(/[^a-z0-9&.+ ]/g, " ").replace(/\s+/g, " ").trim();
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
  const contractGoal = firstContractLine(context.contract, "station_goal");
  const profileGoal = listenerFacingProfileGoal(context.profile);
  if (contractGoal && profileGoal && isGenericContractGoal(contractGoal)) {
    return `${contractGoal}; keep it close to ${profileGoal}.`;
  }
  return listenerFacingGoal(contractGoal, [...context.memoryHypotheses, ...context.memoryFacts]) || profileGoal || "Keep the current personal radio session coherent.";
}

function fallbackMainDirection(context: RadioAgentContextSnapshot): string {
  const contract = contractAnchor(context.contract);
  const anchor =
    reflectionCompletedArtists(context.reflection)[0] ||
    reflectionPositiveAnchors(context.reflection)[0] ||
    memoryAnchor(context.memoryHypotheses[0]) ||
    memoryAnchor(context.memoryFacts[0]) ||
    profileAnchors(context.profile)[0] ||
    context.currentTrack?.artist ||
    context.currentTrack?.name;
  if (contract && (!anchor || !anchorFitsContract(contract, anchor))) return contract;
  return anchor ? `Stay close to ${anchor} and keep the current radio mood coherent.` : "Keep the current radio mood coherent.";
}

function firstContractLine(contract: string, key: string): string {
  const match = contract.match(new RegExp(`${key}\\s*:\\s*([^\\n]+)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function extractDisallowed(contract: string): string[] {
  const avoid = firstContractLine(contract, "avoid");
  if (!avoid) return [];
  return avoid.split(",").map((item) => item.trim()).filter(Boolean);
}

function fallbackNegativeConstraints(context: RadioAgentContextSnapshot): string[] {
  return uniqueStrings([
    ...extractDisallowed(context.contract),
    ...reflectionTemporaryAvoids(context.reflection),
    ...reflectionSkippedAvoids(context.reflection),
  ]);
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
  const goal = firstContractLine(contract, "station_goal");
  return RAW_MEMORY_EVIDENCE_TERMS.test(goal) ? "" : goal;
}

function contractAnchor(contract: string): string {
  const goal = firstContractLine(contract, "station_goal");
  if (!RAW_MEMORY_EVIDENCE_TERMS.test(goal)) return goal;
  return evidenceAnchorsFromText(goal)[0] ?? "";
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
  return [
    "Daniel Caesar Japanese Denim",
    "Frank Ocean Pink + White",
    "SZA Broken Clocks",
    "H.E.R. Focus",
    "Brent Faiyaz Clouded",
  ];
}

function isRnbText(text: string): boolean {
  return /\br\s*&?\s*b\b|\brnb\b|alt[-\s]?r\s*&?\s*b|neo[-\s]?soul|frank ocean|sza|daniel caesar|h\.?e\.?r\.?|brent faiyaz|jorja smith|kelela|ravyn lenae|snoh aalegra|giveon|summer walker|the weeknd|partynextdoor/i.test(text);
}

function memoryAnchor(memory: RadioAgentMemory | undefined): string {
  if (!memory) return "";
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
