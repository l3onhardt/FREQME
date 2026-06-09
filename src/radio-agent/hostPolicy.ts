import type { RadioAgentEventType, RadioHostDecision } from "./types.js";

export interface HostPolicyArgs {
  eventType: RadioAgentEventType;
  recentHostLines: string[];
  profileReady: boolean;
  lowInterruption: boolean;
  userText?: string;
  proposedText?: string;
}

const BANNED_LISTENER_TERMS = [
  /shadow decision/gi,
  /low-interruption/gi,
  /program contract/gi,
  /decision trace/gi,
  /\bbridge\b/gi,
];

export function decideHostSpeech(args: HostPolicyArgs): RadioHostDecision {
  if (args.eventType === "login_completed" || args.eventType === "session_restored") {
    const defaultText = args.profileReady
      ? "我按你熟悉的听歌习惯先接上，今晚慢慢往里走。"
      : "我先放一首稳的，你的音乐习惯我会在后台慢慢整理。";
    return {
      shouldSpeak: true,
      event: "station_open",
      reason: args.profileReady ? "station handoff with ready profile" : "station handoff while profile warms",
      text: sanitizeHostText(args.proposedText || defaultText),
    };
  }

  if (args.eventType === "user_text") {
    return {
      shouldSpeak: true,
      event: "user_ack",
      reason: "direct listener text needs acknowledgement",
      text: sanitizeHostText(args.proposedText || userTextAcknowledgement(args.userText || "")),
    };
  }

  if (args.eventType === "track_skipped") {
    return {
      shouldSpeak: true,
      event: "correction",
      reason: "skip is hot correction evidence",
      text: sanitizeHostText(args.proposedText || "明白，这首先避开。"),
    };
  }

  if (args.lowInterruption && args.recentHostLines.length > 0) {
    return {
      shouldSpeak: false,
      event: "silent",
      reason: "low-interruption ordinary continuation after recent host speech",
    };
  }

  if (args.eventType === "queue_low") {
    return {
      shouldSpeak: true,
      event: "return",
      reason: "queue needs a short continuity handoff",
      text: sanitizeHostText(args.proposedText || "我接着往这个方向续上。"),
    };
  }

  if (args.eventType === "radio_agent_library_scan_failed") {
    return {
      shouldSpeak: false,
      event: "silent",
      reason: "background recovery is internal and should not interrupt playback",
    };
  }

  return {
    shouldSpeak: false,
    event: "silent",
    reason: "ordinary continuation does not need host speech",
  };
}

function sanitizeHostText(text: string): string {
  let sanitized = text;
  for (const pattern of BANNED_LISTENER_TERMS) {
    sanitized = sanitized.replace(pattern, "");
  }
  return sanitized.replace(/\s+/g, " ").trim() || "我继续帮你接上。";
}

function userTextAcknowledgement(text: string): string {
  if (isRnbRequest(text)) {
    const avoid = explicitAvoids(text);
    if (avoid.length > 0) {
      return `好，先守住 R&B，人声和律动靠前，${avoid.join("、")}我先避开。`;
    }
    return "好，先守住 R&B，人声和律动靠前，不乱跳出去。";
  }
  return "收到，我会按这个方向调整。";
}

function explicitAvoids(text: string): string[] {
  const avoids: string[] = [];
  if (/电子|electronic|edm|techno|trance|ambient/i.test(text)) avoids.push("电子");
  if (/古典|classical|chamber|concerto|sonata|quartet/i.test(text)) avoids.push("古典");
  if (/氛围|ambient|piano/i.test(text) && !avoids.includes("氛围")) avoids.push("氛围");
  return Array.from(new Set(avoids));
}

function isRnbRequest(text: string): boolean {
  return /\br\s*&?\s*b\b|\brnb\b/i.test(text);
}
