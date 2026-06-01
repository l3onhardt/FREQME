import assert from "node:assert/strict";
import test from "node:test";

import { WeatherService, weatherCodeLabel } from "../../src/services/weatherService.js";

test("weather code labels describe rainy context for station planning", () => {
  assert.equal(weatherCodeLabel(61), "小雨");
  assert.equal(weatherCodeLabel(95), "雷雨");
  assert.equal(weatherCodeLabel(0), "晴");
});

test("weather service returns null when location is unavailable", async () => {
  const service = new WeatherService();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch should not be called");
  }) as typeof fetch;
  try {
    const result = await service.current({ permission: "unavailable" });
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("weather service converts Open-Meteo current weather to station snapshot", async () => {
  const service = new WeatherService();
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(
      JSON.stringify({
        current_weather: {
          weathercode: 61,
          temperature: 19.4,
          windspeed: 8.6,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await service.current({ permission: "granted", lat: 31.23, lon: 121.47 });
    assert.match(requestedUrl, /api\.open-meteo\.com/);
    assert.deepEqual(result, {
      condition: "小雨",
      temperatureC: 19,
      windKph: 9,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
