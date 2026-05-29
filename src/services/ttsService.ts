import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import type { MemoryStore } from "../storage/memoryStore.js";
import type { UserSettings } from "../types.js";

const voicePresets: Record<string, { configValue: string; director: string; prompt?: string }> = {
  silver_female: {
    configValue: config.mimoTtsVoiceWarmFemale,
    director: "知性、低暖、克制的中文电台女主播音色，成熟自然，不甜腻。",
    prompt: config.mimoTtsVoiceWarmFemalePrompt,
  },
  warm_female: {
    configValue: config.mimoTtsVoiceWarmFemale,
    director: "温暖、磁性、克制的中文电台女主播音色，亲切但不表演化。",
    prompt: config.mimoTtsVoiceWarmFemalePrompt,
  },
  warm_male: {
    configValue: config.mimoTtsVoiceWarmMale,
    director: "温和、低暖、沉稳的中文电台男主播音色，有陪伴感但不油腻。",
  },
  bright_girl: {
    configValue: config.mimoTtsVoiceBrightGirl,
    director: "年轻、明亮、干净的中文电台女主播音色，轻松但克制。",
  },
};

const sceneGuidance: Record<string, string> = {
  清晨: "清晨时段，语气清爽，节奏适中。",
  下午: "下午时段，语气放松，节奏舒展。",
  深夜: "深夜时段，语速稍慢，留白自然，氛围安静。",
  日常: "日常陪伴，语气自然平稳，像真实电台主持人在顺畅串场。",
};

export class TTSService {
  private readonly cacheDir: string;
  private readonly inflight = new Map<string, Promise<{ hash: string; ok: boolean }>>();

  constructor(private readonly store: MemoryStore) {
    this.cacheDir = path.join(config.dataDir, "tts_cache");
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  hash(text: string, scene: string, voicePreset?: string, settings?: Partial<UserSettings>): string {
    const preset = this.voicePreset(voicePreset || settings?.voicePreset);
    const voice = this.resolveVoice(preset);
    return crypto.createHash("md5").update(`${text}|${scene}|${preset}|${config.mimoTtsModel}|${voice}`).digest("hex");
  }

  async synthesize(
    text: string,
    scene = "日常",
    voicePreset?: string,
    settings?: Partial<UserSettings>,
  ): Promise<{ hash: string; ok: boolean }> {
    const clean = String(text || "").trim();
    const preset = this.voicePreset(voicePreset || settings?.voicePreset);
    const hash = this.hash(clean, scene, preset, settings);
    if (!clean) return { hash, ok: false };

    const cachePath = path.join(this.cacheDir, `${hash}.wav`);
    if (fs.existsSync(cachePath)) return { hash, ok: true };
    const known = this.store.getTtsCache(hash);
    if (known && fs.existsSync(known)) {
      fs.copyFileSync(known, cachePath);
      this.store.cacheTts(hash, cachePath);
      return { hash, ok: true };
    }
    const existing = this.inflight.get(hash);
    if (existing) return existing;

    const task = this.requestMimo(clean, scene, preset)
      .then((audio) => {
        if (!audio?.length) return { hash, ok: false };
        fs.writeFileSync(cachePath, audio);
        this.store.cacheTts(hash, cachePath);
        return { hash, ok: true };
      })
      .catch(() => ({ hash, ok: false }))
      .finally(() => {
        this.inflight.delete(hash);
      });
    this.inflight.set(hash, task);
    return task;
  }

  getCachedPath(hash: string): string | null {
    if (!/^[a-f0-9]{32}$/i.test(hash)) return null;
    const cachePath = path.join(this.cacheDir, `${hash}.wav`);
    if (fs.existsSync(cachePath)) return cachePath;
    const known = this.store.getTtsCache(hash);
    return known && fs.existsSync(known) ? known : null;
  }

  private async requestMimo(text: string, scene: string, preset: string): Promise<Buffer | null> {
    if (!config.mimoApiKey) return null;
    const body = this.requestBody(text, scene, preset);
    const response = await fetch(`${config.mimoApiBase.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "api-key": config.mimoApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await this.logFailure(response);
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { audio?: { data?: string } } }>;
    };
    const audioBase64 = data.choices?.[0]?.message?.audio?.data || "";
    return audioBase64 ? Buffer.from(audioBase64, "base64") : null;
  }

  private requestBody(text: string, scene: string, preset: string): Record<string, unknown> {
    const audio: Record<string, unknown> = { format: "wav" };
    const director = this.directorPrompt(scene, preset);
    if (!this.usesVoiceDesign()) {
      audio.voice = this.resolveVoice(preset);
      return {
        model: config.mimoTtsModel,
        messages: [
          { role: "user", content: director },
          { role: "assistant", content: text },
        ],
        audio,
      };
    }

    return {
      model: config.mimoTtsModel,
      messages: [
        { role: "user", content: `${director}\n[音色设计]${this.resolveVoice(preset)}` },
        { role: "assistant", content: text },
      ],
      audio,
    };
  }

  private usesVoiceDesign(): boolean {
    return config.mimoTtsModel.toLowerCase().includes("voicedesign");
  }

  private async logFailure(response: Response): Promise<void> {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    console.warn("[TTS] MiMo synthesis failed", {
      status: response.status,
      model: config.mimoTtsModel,
      body: body.slice(0, 500),
    });
  }

  private voicePreset(value?: string): string {
    return value && voicePresets[value] ? value : "warm_female";
  }

  private resolveVoice(preset: string): string {
    return voicePresets[preset]?.configValue || config.mimoTtsVoice || "Cherry";
  }

  private directorPrompt(scene: string, preset: string): string {
    const voice = voicePresets[preset] || voicePresets.warm_female;
    const sceneText = sceneGuidance[scene] || sceneGuidance.日常;
    return `[角色]${voice.director}[场景]${sceneText}[音色指引]${voice.prompt || ""}[指导]像真实电台主播一样说话，克制、自然、温暖。只读正文含义，不要加入夸张语气词、括号提示或舞台表演。`;
  }
}
