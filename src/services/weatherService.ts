import type { GeoContext, WeatherSnapshot } from "../types.js";

export function weatherCodeLabel(code: number): string {
  if (code === 0) return "晴";
  if ([1, 2, 3].includes(code)) return "多云";
  if ([45, 48].includes(code)) return "雾";
  if (code >= 51 && code <= 57) return "毛毛雨";
  if (code >= 61 && code <= 67) return code === 61 ? "小雨" : "雨";
  if (code >= 71 && code <= 77) return "雪";
  if (code >= 80 && code <= 82) return "阵雨";
  if (code >= 85 && code <= 86) return "阵雪";
  if (code >= 95 && code <= 99) return "雷雨";
  return "天气未知";
}

export class WeatherService {
  constructor(private readonly timeoutMs = 1200) {}

  async current(geo?: GeoContext): Promise<WeatherSnapshot | null> {
    if (!geo || geo.permission !== "granted") return null;
    if (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(geo.lat));
      url.searchParams.set("longitude", String(geo.lon));
      url.searchParams.set("current_weather", "true");
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        current_weather?: {
          weathercode?: number;
          temperature?: number;
          windspeed?: number;
        };
      };
      const current = data.current_weather;
      if (!current) return null;
      const code = Number(current.weathercode);
      const temperature = Number(current.temperature);
      const wind = Number(current.windspeed);
      return {
        condition: weatherCodeLabel(Number.isFinite(code) ? code : -1),
        ...(Number.isFinite(temperature) ? { temperatureC: Math.round(temperature) } : {}),
        ...(Number.isFinite(wind) ? { windKph: Math.round(wind) } : {}),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
