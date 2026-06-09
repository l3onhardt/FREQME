import type { RadioAgentEventType, RadioHostDecision } from "./types.js";

export interface HostAgentArgs {
  eventType: RadioAgentEventType;
  recentHostLines: string[];
  profileReady: boolean;
  lowInterruption: boolean;
  userText?: string;
  proposedText?: string;
  anchor?: string;
  direction?: string;
}

const HOST_TEXT_LIMIT = 120;
const INTERNAL_OR_AWKWARD_TERMS =
  /shadow decision|low-interruption|program contract|decision trace|model|prompt|json|candidate|verification|tool call|旁边|质感|当前电台方向/i;
const MOJIBAKE_TERMS = /鎴|銆|鐨|涓|杩|俙|閹|娑|鐢|鍙|姘|绋|濂|鏀|浣/u;

export function planHostSpeech(args: HostAgentArgs): RadioHostDecision {
  if (args.eventType === "login_completed" || args.eventType === "session_restored") {
    const text = sanitizeHostText(
      args.proposedText ||
        (args.profileReady
          ? "我先按你熟悉的听歌习惯接一首，后面慢慢把电台调准。"
          : "我先放一首稳一点的，你的音乐习惯我会在后台慢慢整理。"),
    );
    return {
      shouldSpeak: true,
      event: "station_open",
      reason: args.profileReady ? "station handoff with ready profile" : "station handoff while profile warms",
      text,
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
      text: sanitizeHostText(args.proposedText || "明白，这首先避开，我把方向收回来。"),
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
    const anchor = cleanLabel(args.anchor);
    const direction = cleanLabel(args.direction);
    const defaultText = anchor
      ? `我先顺着 ${anchor} 的方向接一首，把电台续上。`
      : direction
        ? `我先守住 ${direction}，接一首更稳的。`
        : "我先接一首稳一点的，把电台续上。";
    return {
      shouldSpeak: true,
      event: "return",
      reason: "queue needs a short continuity handoff",
      text: sanitizeHostText(args.proposedText || defaultText),
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

export function sanitizeHostText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "我先把电台稳住。";
  if (INTERNAL_OR_AWKWARD_TERMS.test(compact) || MOJIBAKE_TERMS.test(compact)) return "我先把电台稳住。";
  return compact.length <= HOST_TEXT_LIMIT ? compact : compact.slice(0, HOST_TEXT_LIMIT).trim();
}

function userTextAcknowledgement(text: string): string {
  if (isRnbRequest(text)) {
    const avoids = explicitAvoids(text);
    if (avoids.length > 0) {
      return `好，先守住 R&B，人声和律动靠前，${avoids.join("、")}我先避开。`;
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

function cleanLabel(value: string | undefined): string {
  const compact = (value || "").replace(/\s+/g, " ").trim();
  if (!compact || INTERNAL_OR_AWKWARD_TERMS.test(compact) || MOJIBAKE_TERMS.test(compact)) return "";
  return compact.length <= 48 ? compact : compact.slice(0, 48).trim();
}
