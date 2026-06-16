import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultStyleSeedRegistry,
  isSeedGroupExhausted,
} from "../../src/radio-agent/styleSeedRegistry.js";
import type { StyleSeedDefinition } from "../../src/radio-agent/styleSeedRegistry.js";
import type { Track } from "../../src/types.js";

function track(name: string, artist: string): Track {
  return { id: `${artist}-${name}`, name, artist };
}

test("registry resolves R&B markers without making R&B the product center", () => {
  const registry = defaultStyleSeedRegistry();
  const match = registry.match("play rnb");

  assert.equal(match?.id, "rnb");
  assert.ok(match?.concreteQueries.some((query) => /Daniel Caesar|SZA|Frank Ocean/i.test(query)));
  assert.ok(registry.definitions().length > 1);
});

test("registry resolves quiet jazz markers", () => {
  const match = defaultStyleSeedRegistry().match("play quiet jazz for reading");

  assert.equal(match?.id, "quiet_jazz");
  assert.ok(match?.blockedTerms.includes("electronic remixes"));
});

test("registry resolves focus quiet markers", () => {
  const match = defaultStyleSeedRegistry().match("play quiet focus music");

  assert.equal(match?.id, "quiet_focus");
  assert.ok(match?.allowedAdjacent.includes("minimal piano"));
});

test("registry keeps Chinese mood as a bounded style profile", () => {
  const chineseQuietMood = "\u653e\u70b9\u665a\u4e0a\u5b89\u9759\u4e00\u70b9\u7684\u6b4c";
  const match = defaultStyleSeedRegistry().match(chineseQuietMood);

  assert.equal(match?.id, "chinese_quiet_mood");
  assert.equal(match?.exhaustion, "widen_with_contract");
});

test("registry returns fresh queries before recently promoted seed queries", () => {
  const registry = defaultStyleSeedRegistry();
  const queries = registry.queriesFor("play quiet jazz for reading", [
    track("Italian Dinner Background Music", "Jazz Piano Bar Academy"),
  ]);

  assert.ok(!queries.includes("jazz piano bar academy quiet"));
  assert.equal(queries[0], "jazz piano bar academy reading");
});

test("registry keeps enough fresh R&B queries after recent contract playback", () => {
  const registry = defaultStyleSeedRegistry();
  const queries = registry.queriesFor("play rnb", [
    track("Broken Clocks", "SZA"),
    track("Pink + White", "Frank Ocean"),
    track("Japanese Denim", "Daniel Caesar"),
    track("Focus", "H.E.R."),
  ]);

  assert.ok(queries.length >= 6);
  assert.ok(queries.every((query) => !/Broken Clocks|Pink \+ White|pinkpuss|Japanese Denim|H\.E\.R\. Focus/i.test(query)));
  assert.ok(queries.some((query) => /Brent Faiyaz|Kelela|Summer Walker|Giveon|Miguel|Sonder/i.test(query)));
});

test("registry reports seed group exhaustion after cooldown window", () => {
  const registry = defaultStyleSeedRegistry();
  const quietJazz = registry.match("play quiet jazz for reading");

  assert.ok(quietJazz);
  assert.equal(
    isSeedGroupExhausted(quietJazz, "local-quiet-jazz", [
      "jazzpianobaracademy::italiandinnerbackgroundmusic",
      "jazzpianobaracademy::magicalpiano",
      "jazzpianobaracademy::pianoinstrumentalmusic",
    ]),
    true,
  );
});

test("blocked terms are resolved from matched style definition", () => {
  const blocked = defaultStyleSeedRegistry().blockedTermsFor("play rnb");

  assert.ok(blocked.includes("classical chamber drift"));
  assert.ok(blocked.includes("high energy EDM"));
});

test("custom registry can be constructed with bounded definitions", () => {
  const definition: StyleSeedDefinition = {
    id: "custom",
    markers: ["custom marker"],
    concreteQueries: ["Custom Artist Custom Song"],
    blockedTerms: ["blocked move"],
    allowedAdjacent: ["adjacent move"],
    seedGroups: [{ id: "custom-group", queryKeys: ["customartist::customsong"], cooldownTracks: 2 }],
    exhaustion: "honest_not_found",
  };
  const registry = defaultStyleSeedRegistry([definition]);

  assert.equal(registry.match("please play custom marker")?.id, "custom");
  assert.deepEqual(registry.queriesFor("custom marker"), ["Custom Artist Custom Song"]);
});
