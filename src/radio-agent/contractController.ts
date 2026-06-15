import type { RadioAgentProgramWindow } from "./types.js";

export interface AgentSessionContract {
  id: string;
  uid: string | null;
  sessionId: number | null;
  rawUserText: string;
  stationBrief: string;
  positiveAnchors: string[];
  disallowed: string[];
  allowedAdjacent: string[];
  bridgeBudget: number;
  returnRequirement: string;
  sourceEventId: string;
  status: "active" | "repaired" | "expired";
  repairedFrom?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContractControllerOptions {
  now?: () => string;
}

export interface UserDirectionArgs {
  uid: string | null;
  sessionId: number | null;
  text: string;
  sourceEventId: string;
}

export interface RecordNotFoundArgs {
  searchedQueries: string[];
}

export interface RepairFromCorrectionArgs {
  text: string;
  sourceEventId: string;
  reason: string;
}

type MarkdownKey =
  | "id"
  | "uid"
  | "sessionId"
  | "sourceEventId"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "rawUserText"
  | "stationBrief"
  | "bridgeBudget"
  | "returnRequirement"
  | "repairedFrom";

const EMPTY_UID = "__null__";

export class ContractController {
  private readonly now: () => string;

  constructor(options: ContractControllerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  fromUserDirection(args: UserDirectionArgs): AgentSessionContract {
    const timestamp = this.now();
    return this.createContract({
      uid: args.uid,
      sessionId: normalizeSessionId(args.sessionId),
      rawUserText: args.text,
      sourceEventId: args.sourceEventId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  recordNotFound(contract: AgentSessionContract, _args: RecordNotFoundArgs): AgentSessionContract {
    return {
      ...contract,
      status: "active",
      updatedAt: this.now(),
    };
  }

  repairFromCorrection(contract: AgentSessionContract, args: RepairFromCorrectionArgs): AgentSessionContract {
    const timestamp = this.now();
    return this.createContract({
      uid: contract.uid,
      sessionId: contract.sessionId,
      rawUserText: args.text,
      sourceEventId: args.sourceEventId,
      repairedFrom: contract.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  toProgramContractMarkdown(contract: AgentSessionContract): string {
    const lines = [
      "# Program Contract",
      "",
      metadataLine("id", contract.id),
      metadataLine("uid", contract.uid ?? EMPTY_UID),
      metadataLine("sessionId", contract.sessionId ?? ""),
      metadataLine("sourceEventId", contract.sourceEventId),
      metadataLine("status", contract.status),
      metadataLine("createdAt", contract.createdAt),
      metadataLine("updatedAt", contract.updatedAt),
    ];

    if (contract.repairedFrom) lines.push(metadataLine("repairedFrom", contract.repairedFrom));

    lines.push(
      "",
      metadataLine("rawUserText", contract.rawUserText),
      metadataLine("stationBrief", contract.stationBrief),
      metadataLine("bridgeBudget", contract.bridgeBudget),
      metadataLine("returnRequirement", contract.returnRequirement),
      "",
      "## Positive Anchors",
      ...listLines(contract.positiveAnchors),
      "",
      "## Allowed Adjacent",
      ...listLines(contract.allowedAdjacent),
      "",
      "## Disallowed",
      ...listLines(contract.disallowed),
    );

    return lines.join("\n");
  }

  fromProgramWindow(window: RadioAgentProgramWindow & { sourceEventId?: string }): AgentSessionContract {
    const timestamp = window.createdAt || this.now();
    const rawUserText = window.mainDirection || window.stationBrief;
    const sourceEventId = window.sourceEventId || window.id;
    const contract = this.createContract({
      id: window.id,
      uid: window.uid,
      sessionId: window.sessionId,
      rawUserText,
      sourceEventId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return {
      ...contract,
      stationBrief: window.stationBrief || contract.stationBrief,
      allowedAdjacent: [...window.allowedAdjacent],
      disallowed: [...window.disallowed],
      bridgeBudget: Math.max(0, Math.floor(window.bridgeBudget)),
      returnRequirement: window.returnRequirement || contract.returnRequirement,
    };
  }

  fromMarkdown(markdown: string): AgentSessionContract {
    const metadata: Partial<Record<MarkdownKey, string>> = {};
    const lists: Record<string, string[]> = {
      "Positive Anchors": [],
      "Allowed Adjacent": [],
      Disallowed: [],
    };
    let activeSection = "";

    for (const rawLine of markdown.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const heading = /^##\s+(.+)$/.exec(line);
      if (heading) {
        activeSection = heading[1] ?? "";
        continue;
      }
      if (line.startsWith("- ")) {
        if (activeSection in lists) lists[activeSection]!.push(line.slice(2).trim());
        continue;
      }
      const pair = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (pair) metadata[pair[1] as MarkdownKey] = parseMetadataValue(pair[2] ?? "");
    }

    const timestamp = this.now();
    const status = normalizeStatus(metadata.status);
    const sessionId = metadata.sessionId === "" || metadata.sessionId == null ? null : Number(metadata.sessionId);
    const uid = metadata.uid === EMPTY_UID ? null : metadata.uid ?? null;
    const rawUserText = metadata.rawUserText || "";
    const baseline = this.createContract({
      id: metadata.id || this.nextId(metadata.sourceEventId || "markdown"),
      uid,
      sessionId: Number.isFinite(sessionId) ? sessionId : null,
      rawUserText,
      sourceEventId: metadata.sourceEventId || metadata.id || "markdown",
      repairedFrom: metadata.repairedFrom || undefined,
      createdAt: metadata.createdAt || timestamp,
      updatedAt: metadata.updatedAt || timestamp,
    });

    return {
      ...baseline,
      stationBrief: metadata.stationBrief || baseline.stationBrief,
      positiveAnchors: lists["Positive Anchors"].length ? lists["Positive Anchors"] : baseline.positiveAnchors,
      disallowed: lists.Disallowed.length ? lists.Disallowed : baseline.disallowed,
      allowedAdjacent: lists["Allowed Adjacent"].length ? lists["Allowed Adjacent"] : baseline.allowedAdjacent,
      bridgeBudget: Number.isFinite(Number(metadata.bridgeBudget)) ? Math.max(0, Math.floor(Number(metadata.bridgeBudget))) : baseline.bridgeBudget,
      returnRequirement: metadata.returnRequirement || baseline.returnRequirement,
      status,
    };
  }

  private createContract(args: {
    id?: string;
    uid: string | null;
    sessionId: number | null;
    rawUserText: string;
    sourceEventId: string;
    repairedFrom?: string;
    createdAt: string;
    updatedAt: string;
  }): AgentSessionContract {
    const positiveAnchors = anchorsFor(args.rawUserText);
    const stationBrief = stationBriefFor(args.rawUserText);
    return {
      id: args.id || this.nextId(args.sourceEventId),
      uid: args.uid,
      sessionId: normalizeSessionId(args.sessionId),
      rawUserText: args.rawUserText,
      stationBrief,
      positiveAnchors,
      disallowed: disallowedFor(args.rawUserText),
      allowedAdjacent: allowedAdjacentFor(positiveAnchors),
      bridgeBudget: bridgeBudgetFor(args.rawUserText),
      returnRequirement: `Return to ${stationBrief} after any adjacent step.`,
      sourceEventId: args.sourceEventId,
      status: "active",
      repairedFrom: args.repairedFrom,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    };
  }

  private nextId(seed: string): string {
    return `contract-${slug(seed || "session")}-${hash(`${seed}:${this.now()}`)}`;
  }
}

function anchorsFor(text: string): string[] {
  const normalized = text.toLowerCase();
  const anchors: string[] = [];
  if (/\br\s*&\s*b\b|\brnb\b|\balt-r\s*&\s*b\b|\bneo-soul\b/.test(normalized)) {
    anchors.push("R&B", "alt-R&B", "neo-soul", "soul");
  }
  if (/\bjazz\b/.test(normalized)) {
    anchors.push("jazz", "soft jazz piano", "light acoustic jazz");
  }
  if (/\bquiet\b|\bfocus\b|\breading\b|\bstudy\b|\bsoft\b|\blow energy\b/.test(normalized)) {
    anchors.push("quiet", "focus", "soft", "low energy");
  }
  if (/[\u3400-\u9fff]/u.test(text)) {
    anchors.push("listener mood", "broad style", "coherent radio direction");
  }
  return dedupe(anchors.length ? anchors : ["listener direction"]);
}

function stationBriefFor(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const direction = cleaned.replace(/^(play|put on|make it|actually)\s+/i, "").trim() || cleaned;
  return direction.endsWith(".") ? direction : `${direction}.`;
}

function disallowedFor(text: string): string[] {
  const normalized = text.toLowerCase();
  const disallowed: string[] = [];
  if (/\bjazz\b/.test(normalized) || /\bquiet\b|\bfocus\b|\breading\b|\bstudy\b|\bsoft\b/.test(normalized)) {
    disallowed.push("festival EDM", "hard rock");
  }
  if (/\br\s*&\s*b\b|\brnb\b|\bneo-soul\b/.test(normalized)) {
    disallowed.push("high energy EDM", "classical chamber drift");
  }
  return dedupe(disallowed);
}

function allowedAdjacentFor(anchors: string[]): string[] {
  if (anchors.includes("R&B")) return ["soul", "neo-soul", "quiet vocal pop"];
  if (anchors.includes("jazz")) return ["cool jazz", "soft vocal jazz", "small-combo jazz"];
  if (anchors.includes("quiet")) return ["minimal piano", "soft acoustic", "low-key instrumental"];
  return [];
}

function bridgeBudgetFor(text: string): number {
  return /\bquiet\b|\bfocus\b|\breading\b|\bstudy\b/i.test(text) ? 1 : 0;
}

function normalizeSessionId(sessionId: number | null): number | null {
  return typeof sessionId === "number" && Number.isFinite(sessionId) ? sessionId : null;
}

function normalizeStatus(value: string | undefined): AgentSessionContract["status"] {
  if (value === "repaired" || value === "expired") return value;
  return "active";
}

function listLines(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- "];
}

function metadataLine(key: string, value: string | number): string {
  return `${key}: ${JSON.stringify(String(value))}`;
}

function parseMetadataValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return trimmed;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "session";
}

function hash(value: string): string {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result.toString(36);
}
