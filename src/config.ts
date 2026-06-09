import dotenv from "dotenv";

import type { RadioAgentMode } from "./radio-agent/types.js";

dotenv.config();

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

export function parseRadioAgentMode(raw: string | undefined): RadioAgentMode {
  const value = (raw || "assisted").toLowerCase();
  if (value === "shadow" || value === "active") return value;
  return "assisted";
}

function radioAgentModeEnv(): RadioAgentMode {
  return parseRadioAgentMode(process.env.RADIO_AGENT_MODE);
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: intEnv("PORT", 8000),
  dataDir: process.env.DATA_DIR || "./data",
  dbPath: process.env.RADIO_DB_PATH || "./data/freqme.db",
  neteaseCookiePath: process.env.NETEASE_COOKIE_PATH || "./data/netease-cookie.json",
  radioAgentMode: radioAgentModeEnv(),

  mimoApiKey: process.env.MIMO_API_KEY || "",
  mimoApiBase: process.env.MIMO_API_BASE || "https://api.xiaomimimo.com/v1",
  mimoTtsModel: process.env.MIMO_TTS_MODEL || "mimo-v2.5-tts",
  mimoTtsVoice: process.env.MIMO_TTS_VOICE || "",
  mimoTtsVoiceWarmFemale: process.env.MIMO_TTS_VOICE_WARM_FEMALE || "",
  mimoTtsVoiceWarmMale: process.env.MIMO_TTS_VOICE_WARM_MALE || "",
  mimoTtsVoiceBrightGirl: process.env.MIMO_TTS_VOICE_BRIGHT_GIRL || "",
  mimoTtsVoiceWarmFemalePrompt: process.env.MIMO_TTS_VOICE_WARM_FEMALE_PROMPT || "",

  llmProvider: process.env.LLM_PROVIDER || "mimo",
  llmApiKey: process.env.LLM_API_KEY || process.env.MIMO_API_KEY || "",
  llmApiBase: process.env.LLM_API_BASE || process.env.MIMO_API_BASE || "https://api.xiaomimimo.com/v1",
  llmModel: process.env.LLM_MODEL || "mimo-v2.5-pro",
  llmFallbackProvider: process.env.LLM_FALLBACK_PROVIDER || "anthropic",
  llmFallbackApiKey: process.env.LLM_FALLBACK_API_KEY || "",
  llmFallbackApiBase: process.env.LLM_FALLBACK_API_BASE || "https://api.anthropic.com/v1",
  llmFallbackModel: process.env.LLM_FALLBACK_MODEL || "claude-sonnet-4-6",
  maxDailyTokens: intEnv("MAX_DAILY_TOKENS", 100000),
};
