import { config } from "./config.js";

type CheckState = "ok" | "configured" | "missing" | "lazy";

export interface RuntimeStatus {
  status: "ready" | "degraded";
  checks: Record<string, CheckState>;
}

export function runtimeStatus(): RuntimeStatus {
  const checks: Record<string, CheckState> = {
    database: "ok",
    netease: "lazy",
    mimo_api: config.mimoApiKey ? "configured" : "missing",
    mimo_tts_model: config.mimoTtsModel ? "configured" : "missing",
    llm_api: config.llmApiKey ? "configured" : "missing",
  };
  return {
    status: Object.values(checks).includes("missing") ? "degraded" : "ready",
    checks,
  };
}
