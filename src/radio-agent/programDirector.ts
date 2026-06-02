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
const INTERNAL_HOST_TERMS = /\b(model|json|candidate|trace|prompt|verification|shadow mode|tool call)\b/i;
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
    section("Memory Facts", context.memoryFacts.map(formatMemory).join("\n")),
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
    returnRequirement: "Return to the current station contract after one adjacent bridge.",
    candidateTasks,
    hostIntent: silentHostIntent("fallback"),
    traceBasis: traceBasisFromContext(context),
    source: "deterministic_fallback",
    createdAt,
  };
}

function fallbackCandidateTasks(context: RadioAgentContextSnapshot): RadioAgentCandidateTask[] {
  const anchors = [
    ...context.memoryFacts.map(memoryAnchor),
    context.currentTrack?.artist,
    ...context.readyQueue.map((track) => track.artist),
    contractAnchor(context.contract),
    DEFAULT_FALLBACK_QUERY,
  ]
    .filter((anchor): anchor is string => Boolean(anchor?.trim()))
    .map((anchor) => anchor.trim());

  const uniqueAnchors = Array.from(new Set(anchors));
  const tasks = uniqueAnchors.map((anchor) => ({
    query: anchor,
    reason: "Deterministic anchor from radio memory or current contract.",
    style: styleFromContract(context.contract),
    negativeConstraints: extractDisallowed(context.contract),
  }));

  return tasks.filter(isAllowedCandidateTask).slice(0, MAX_CANDIDATE_TASKS);
}

function toCandidateTask(value: unknown): RadioAgentCandidateTask | null {
  if (!isRecord(value)) return null;
  const task: RadioAgentCandidateTask = {
    query: stringValue(valueFor(value, "query")),
    reason: stringValue(valueFor(value, "reason")) || "Model-selected radio direction.",
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

function toHostIntent(value: unknown): RadioAgentHostIntent {
  if (!isRecord(value)) return silentHostIntent("missing_host_intent");

  const shouldSpeak = Boolean(valueFor(value, "shouldSpeak"));
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

function traceBasisFromContext(context: RadioAgentContextSnapshot): RadioAgentProgramWindow["traceBasis"] {
  return {
    profile: context.profile,
    now: context.now,
    contract: context.contract,
    eventType: context.eventType,
  };
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
  return contractGoal || "Keep the current personal radio session coherent.";
}

function fallbackMainDirection(context: RadioAgentContextSnapshot): string {
  const anchor = memoryAnchor(context.memoryFacts[0]) || context.currentTrack?.artist || context.currentTrack?.name;
  return anchor ? `Continue from ${anchor} while respecting the current station contract.` : "Continue the current station contract.";
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

function styleFromContract(contract: string): string {
  const goal = firstContractLine(contract, "station_goal");
  return goal || "";
}

function contractAnchor(contract: string): string {
  return firstContractLine(contract, "station_goal");
}

function memoryAnchor(memory: RadioAgentMemory | undefined): string {
  if (!memory) return "";
  const keyed = memory.key.includes(":") ? memory.key.split(":").slice(1).join(":") : memory.key;
  if (keyed.trim()) return keyed.trim();
  const artistMatch = memory.value.match(/\bfor\s+([A-Z][A-Za-z0-9 .+'&-]+)/);
  return artistMatch?.[1]?.replace(/\.$/, "").trim() ?? "";
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
