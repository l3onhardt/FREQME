import type { LLMRouter } from "../services/llmRouter.js";
import type { TasteProfile, Track, UserSettings } from "../types.js";
import { compactText } from "../utils/text.js";
import { contextText } from "./context.js";

export function shouldGenerateSegue(trackIndex: number): boolean {
  return trackIndex > 1 && (trackIndex - 1) % 3 === 0;
}

export class DJEngine {
  constructor(private readonly llm: LLMRouter) {}

  defaultIntro(scene: string): string {
    const greeting: Record<string, string> = {
      清晨: "早上好",
      下午: "下午好",
      深夜: "晚上好",
      日常: "你好",
    };
    return `${greeting[scene] || "你好"}，电台已经打开了。先别急着说话，我们让第一首歌把今天的气氛慢慢铺开。`;
  }

  async generateIntro(profile: TasteProfile | null, scene: string, settings: Partial<UserSettings>): Promise<string> {
    const prompt = `你是 FREQME，一位真实的私人 FM 音乐电台主播。现在是${scene}，用户刚打开电台。

听感画像：
${this.profileText(profile)}

上下文：
${contextText(settings, scene)}

生成一段开场白，朗读 10 到 18 秒。
只输出主播要说的话，不要标题、括号、解释或舞台提示。
不要说“欢迎收听”，不要提系统、算法、推荐或画像。`;
    return compactText(
      await this.llm.chat(prompt, {
        maxTokens: 180,
      }),
      300,
    );
  }

  async generateProgramBreak(args: {
    profile: TasteProfile | null;
    scene: string;
    playedTracks: Track[];
    nextTrack: Track;
    settings: Partial<UserSettings>;
  }): Promise<string> {
    const played = args.playedTracks
      .slice(-3)
      .map((track) => `${track.name} - ${track.artist}`)
      .join("；");
    const reason = args.nextTrack.selectionReason?.text || "让情绪自然接上。";
    const prompt = `你是 FREQME 的私人电台主播。现在是${args.scene}。

刚刚播过：${played || "刚开始"}
下一首：${args.nextTrack.name} - ${args.nextTrack.artist}
选曲线索：${reason}
画像与上下文：
${this.profileText(args.profile)}
${contextText(args.settings, args.scene)}

生成一段 8 到 18 秒的自然串场。可以点到下一首歌名和艺人，但不要编造背景。
只输出主播要说的话。不要提系统、算法、推荐或画像。`;
    return compactText(await this.llm.chat(prompt, { maxTokens: 220 }), 360);
  }

  async generateRequestAck(args: {
    profile: TasteProfile | null;
    scene: string;
    requestText: string;
    settings: Partial<UserSettings>;
  }): Promise<string> {
    const prompt = `你是 FREQME 的私人音乐电台主播。用户刚说：${args.requestText}
现在是${args.scene}。上下文：${contextText(args.settings, args.scene)}
生成一句 4 到 8 秒的回应，像听懂了点歌方向的真实 DJ。不要承诺一定找到某首歌，不要提系统、搜索、算法。`;
    return compactText(await this.llm.chat(prompt, { maxTokens: 100 }), 180);
  }

  private profileText(profile: TasteProfile | null): string {
    if (!profile) return "画像还在建立中。";
    return compactText(
      [
        profile.radioInsights.tasteSummary,
        `熟悉区：${profile.radioInsights.comfortZone.slice(0, 4).join("、")}`,
        `扩展方向：${profile.radioInsights.discoveryDirection.slice(0, 4).join("、")}`,
        profile.learned.avoidedStyles.length ? `避雷：${profile.learned.avoidedStyles.join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      1000,
    );
  }
}

