import { compactText, dedupe } from "../utils/text.js";
import type { ListeningIntentDecision } from "./radioBrainTypes.js";

const NEGATION_PREFIX = String.raw`(?:不要|别|別|不想|拒绝|避开|別太|别太)`;
const NEGATION_WITHOUT_TOO_PREFIX = String.raw`(?:不要|别|別|不想|拒绝|避开)`;
const NEGATED_FILLER = String.raw`(?:\s*(?:再|放|来|有|太))*\s*`;

const NEGATED_STYLE_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(String.raw`${NEGATION_PREFIX}${NEGATED_FILLER}emo`, "iu"), "emo"],
  [new RegExp(String.raw`${NEGATION_WITHOUT_TOO_PREFIX}${NEGATED_FILLER}(?:edm|电子舞曲|电音)`, "iu"), "EDM"],
  [new RegExp(String.raw`${NEGATION_WITHOUT_TOO_PREFIX}[^，。；;]{0,24}(?:dubstep|回响贝斯)`, "iu"), "dubstep"],
  [new RegExp(String.raw`(?:${NEGATION_WITHOUT_TOO_PREFIX}|没有)${NEGATED_FILLER}(?:人声|vocal|唱的|演唱)`, "iu"), "人声"],
  [new RegExp(String.raw`${NEGATION_WITHOUT_TOO_PREFIX}${NEGATED_FILLER}(?:中文|华语|中文歌)`, "iu"), "中文歌"],
  [new RegExp(String.raw`${NEGATION_WITHOUT_TOO_PREFIX}${NEGATED_FILLER}(?:高能量|高能)|太电|太电子|太吵|太炸|炸场`, "iu"), "高能量"],
];

const NEGATED_STYLE_SPAN_PATTERNS = NEGATED_STYLE_PATTERNS.map(
  ([pattern]) => new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`),
);

const NEGATIVE_STYLE_TERM_PATTERNS: Record<string, RegExp> = {
  emo: /\bemo\b/giu,
  EDM: /\bedm\b|电子舞曲|电音/giu,
  dubstep: /\bdubstep\b|回响贝斯/giu,
  人声: /人声|vocal|唱的|演唱/giu,
  中文歌: /中文歌|中文|华语/giu,
  高能量: /高能量|高能|太电|太电子|太吵|太炸|炸场/giu,
};

export class IntentRouter {
  classify(rawText: string): ListeningIntentDecision {
    const text = compactText(rawText, 240);
    const negativeConstraints = this.negativeConstraints(text);
    if (/(为什么|为啥|哪里适合|怎么理解|理由|原因).*(这首|这歌|放)|^(为什么|为啥)/iu.test(text)) {
      return this.intent("explanation_question", text, "", [], negativeConstraints, false, false, true, "我解释一下这首为什么接在这里。");
    }
    if (/(不是这种|不对|换一个|太电|太吵|太炸|不要人声|没有人声)/iu.test(text)) {
      const seeds = /专注|写代码|工作流|安静/iu.test(text) ? ["安静专注工作流"] : ["调整后的方向"];
      return this.intent("correction", text, "", seeds, negativeConstraints, true, true, false, "懂了，我先避开刚才那个方向，重新往你要的感觉收。");
    }
    const direct = text.match(/^(?:放|播放|点一首|我想听|想听)\s*(.{2,80})$/iu);
    if (direct?.[1] && !/(来点|一些|适合|感觉|氛围|风格)/iu.test(direct[1])) {
      return this.intent("specific_track_request", text, compactText(direct[1], 120), [], negativeConstraints, true, true, false, "我找一下这首。");
    }
    if (/(继续|保持|就这个|这个感觉)/iu.test(text)) {
      return this.intent("continuation", text, "", [], negativeConstraints, true, false, false, "好，继续保持这个频率。");
    }
    if (/(不喜欢|以后少放|我其实|我平时)/iu.test(text)) {
      return this.intent("preference_update", text, "", this.positiveSeeds(text, negativeConstraints), negativeConstraints, true, true, false, "记住了，我会把这个偏好先放进当前电台判断里。");
    }
    return this.intent("music_direction_request", text, "", this.positiveSeeds(text, negativeConstraints), negativeConstraints, true, true, false, "收到，我按这个方向重新排接下来的几首。");
  }

  private intent(
    type: ListeningIntentDecision["type"],
    rawText: string,
    query: string,
    positiveSeeds: string[],
    negativeConstraints: string[],
    shouldReplan: boolean,
    shouldClearQueue: boolean,
    shouldExplain: boolean,
    ackText: string,
  ): ListeningIntentDecision {
    return {
      type,
      rawText,
      query,
      positiveSeeds: dedupe(positiveSeeds).slice(0, 8),
      negativeConstraints: dedupe(negativeConstraints).slice(0, 12),
      shouldReplan,
      shouldClearQueue,
      shouldExplain,
      confidence: "high",
      ackText,
    };
  }

  private negativeConstraints(text: string): string[] {
    return NEGATED_STYLE_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  }

  private positiveSeeds(text: string, negativeConstraints: string[]): string[] {
    const seeds: string[] = [];
    if (/专注|写代码|工作流|工作/iu.test(text)) seeds.push("专注工作");
    if (/安静|轻|舒缓/iu.test(text)) seeds.push("安静");
    if (/推动力|有劲|推进/iu.test(text)) seeds.push("轻微推动力");
    if (/高能量|高能/iu.test(text) && !negativeConstraints.includes("高能量")) seeds.push("高能量");
    if (/\bemo\b|忧郁|情绪/iu.test(text) && !negativeConstraints.includes("emo")) seeds.push("emo");
    if (/\br\s*&?\s*b\b|\brnb\b/iu.test(text)) seeds.push("R&B");
    if (!seeds.length && text) {
      let fallback = text;
      for (const pattern of NEGATED_STYLE_SPAN_PATTERNS) {
        fallback = fallback.replace(pattern, "");
      }
      fallback = fallback.replace(/不要|别太|别|不是这种/giu, "");
      for (const constraint of negativeConstraints) {
        fallback = fallback.replace(NEGATIVE_STYLE_TERM_PATTERNS[constraint] ?? /$./giu, "");
      }
      const seed = compactText(fallback, 80);
      if (seed) seeds.push(seed);
    }
    return seeds.filter(Boolean);
  }
}
