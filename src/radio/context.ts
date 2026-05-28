import type { GeoContext, Track, UserSettings } from "../types.js";

export function detectScene(utcOffsetMinutes = 480): string {
  const now = new Date();
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000 + now.getTimezoneOffset() * 60_000);
  const hour = local.getHours();
  if (hour >= 5 && hour < 9) return "清晨";
  if (hour >= 12 && hour < 17) return "下午";
  if (hour >= 22 || hour < 5) return "深夜";
  return "日常";
}

export function localTimeBlock(scene: string): string {
  if (scene === "清晨") return "morning";
  if (scene === "下午") return "afternoon";
  if (scene === "深夜") return "late_night";
  return "daytime";
}

export function normalizeGeo(value: unknown): GeoContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const permission = source.permission === "granted" || source.permission === "denied" ? source.permission : "unavailable";
  const lat = Number(source.lat);
  const lon = Number(source.lon);
  const accuracyM = Number(source.accuracyM);
  if (permission !== "granted") return { permission };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { permission: "unavailable" };
  return {
    permission,
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
    accuracyM: Number.isFinite(accuracyM) ? Math.round(accuracyM) : undefined,
  };
}

export function contextText(settings: Partial<UserSettings>, scene: string): string {
  const parts = [scene];
  if (settings.currentMode) parts.push(`模式：${settings.currentMode}`);
  if (settings.regionHint) parts.push(`地区：${settings.regionHint}`);
  if (settings.timezoneName) parts.push(`时区：${settings.timezoneName}`);
  if (settings.geo?.permission === "granted") {
    parts.push(`城市级位置：${settings.geo.lat},${settings.geo.lon}`);
  }
  return parts.join("，");
}

export function trackInfo(track: Track | null | undefined): { id: string; name: string; artist: string } {
  return {
    id: track?.id || "",
    name: track?.name || "",
    artist: track?.artist || "",
  };
}

