import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { SearchVerifyAgent } from "../../src/radio/searchVerifyAgent.js";
import type { MemoryPack, MusicTask, Track } from "../../src/types.js";

class FakeLlm {
  calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

  async chat(prompt: string, options: Record<string, unknown>): Promise<string> {
    this.calls.push({ prompt, options });
    if (prompt.includes("Rewrite this DJ music task")) {
      return JSON.stringify({
        picks: [
          { artist: "Linkin Park", title: "Numb", query: "Linkin Park Numb" },
          { artist: "Linkin Park", title: "In the End", query: "Linkin Park In the End" },
        ],
        search_queries: ["Linkin Park Numb"],
      });
    }
    return JSON.stringify({
      chosen_id: "1",
      confidence: 0.91,
      matched_entities: ["Linkin Park"],
      version_note: "artist and title match",
      risk: "",
    });
  }
}

class FakeNetease {
  queries: string[] = [];

  async search(query: string): Promise<Track[]> {
    this.queries.push(query);
    return [
      { id: "bad", name: "Linkin Park 睡眠歌单", artist: "白噪音", source: query },
      { id: "1", name: "Numb", artist: "Linkin Park", source: query },
    ];
  }
}

class FakeAudioResolver {
  async resolveWithCandidates(track: Track): Promise<any> {
    return {
      ok: track.id === "1",
      songId: track.id,
      proxyUrl: `/api/radio/audio/${track.id}`,
    };
  }
}

class FakeStyleRegistry {
  calls: string[] = [];

  match(text: string): any {
    return this.matches(text)[0] || null;
  }

  matches(text: string): any[] {
    this.calls.push(text);
    return text.includes("registry marker") ? [{ id: "registry_style", markers: ["registry marker"] }] : [];
  }

  queriesFor(): string[] {
    return ["Registry Artist Registry Song"];
  }

  queriesForDefinition(): string[] {
    return ["Registry Artist Registry Song"];
  }
}

const personalContext: MemoryPack = {
  userProfileDigest:
    "taste summary: prefers intimate vocal pop, late-night melancholy, warm R&B textures; anchors include Frank Ocean Nights and SZA Good Days",
  sessionWorkingMemory: {
    activeMode: {
      label: "quiet night radio",
      understoodIntent: "keep the station soft, nocturnal, and not too loud",
    },
  },
  recentTurns: [{ user: "刚才那首太炸了", result: "queued" }],
  retrievedMemories: [{ memoryText: "likes Frank Ocean, SZA, Daniel Caesar, and low-key vocal tracks" }],
  playbackContext: {
    currentTrack: { name: "Nights", artist: "Frank Ocean" },
    recentTracks: [{ name: "Good Days", artist: "SZA" }],
    scene: "late night",
  },
  userSettings: { musicNotes: "avoid noisy club tracks", localTimeBlock: "late_night" },
  hardConstraints: ["Do not search the literal listener sentence."],
};

test("specific track exact metadata can verify without an LLM judge call", async () => {
  const task: MusicTask = {
    type: "specific_track",
    primaryEntities: [],
    workHint: "",
    styleHint: "instrumental focus",
    negativeConstraints: ["EDM"],
    searchGoals: ["Nils Frahm Says"],
    mustNotSearchLiteralUserSentence: true,
  };
  const llm = new FakeLlm();
  const netease = {
    async search(query: string): Promise<Track[]> {
      return [{ id: "1", name: "Says", artist: "Nils Frahm", source: query }];
    },
  };
  const agent = new SearchVerifyAgent(llm as any, netease as any, new FakeAudioResolver() as any);

  const result = await agent.verify(task, "42", "");

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.name, "Says");
  assert.equal(llm.calls.length, 0);
  assert.equal(result.verification.versionNote, "Candidate metadata locally matches the concrete query.");
});

test("EDM negative constraints reject adjacent house and drum and bass episode queries", async () => {
  const task: MusicTask = {
    type: "specific_track",
    primaryEntities: [],
    workHint: "",
    styleHint: "quiet focus",
    negativeConstraints: ["EDM", "dubstep"],
    searchGoals: ["Alexandre Pachabezian Una Mattina Deep House Remix"],
    mustNotSearchLiteralUserSentence: true,
  };
  const searched: string[] = [];
  const netease = {
    async search(query: string): Promise<Track[]> {
      searched.push(query);
      return [{ id: "1", name: "Una Mattina Deep House Remix", artist: "Alexandre Pachabezian", source: query }];
    },
  };
  const agent = new SearchVerifyAgent(new FakeLlm() as any, netease as any, new FakeAudioResolver() as any);

  const result = await agent.verify(task, "42", "");

  assert.equal(result.status, "not_found");
  assert.deepEqual(searched, []);
  assert.ok(result.diagnostics?.rejectedQueries?.includes("Alexandre Pachabezian Una Mattina Deep House Remix"));
});

test("EDM negative constraints reject liquid drum and bass episode queries", async () => {
  const task: MusicTask = {
    type: "specific_track",
    primaryEntities: [],
    workHint: "",
    styleHint: "quiet focus",
    negativeConstraints: ["EDM"],
    searchGoals: ["Hybrid Minds Lights liquid drum and bass vocal soft"],
    mustNotSearchLiteralUserSentence: true,
  };
  const searched: string[] = [];
  const netease = {
    async search(query: string): Promise<Track[]> {
      searched.push(query);
      return [{ id: "1", name: "Lights", artist: "Hybrid Minds", source: query }];
    },
  };
  const agent = new SearchVerifyAgent(new FakeLlm() as any, netease as any, new FakeAudioResolver() as any);

  const result = await agent.verify(task, "42", "");

  assert.equal(result.status, "not_found");
  assert.deepEqual(searched, []);
  assert.ok(result.diagnostics?.rejectedQueries?.includes("Hybrid Minds Lights liquid drum and bass vocal soft"));
});

test("scene planner creates concrete artist-title queries and verifier rejects utility candidates", async () => {
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "scene", name: "low-key Linkin Park mood" }],
    workHint: "",
    styleHint: "low-key Linkin Park mood",
    negativeConstraints: [],
    searchGoals: [],
    mustNotSearchLiteralUserSentence: true,
  };
  const llm = new FakeLlm();
  const netease = new FakeNetease();
  const agent = new SearchVerifyAgent(llm as any, netease as any, new FakeAudioResolver() as any);

  const queries = await agent.queries(task, "来点 linkin parl");
  assert.deepEqual(queries, ["Linkin Park Numb", "Linkin Park In the End"]);

  const result = await agent.verify(task, "42", "来点 linkin parl");
  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "1");
  assert.equal(result.url, "/api/radio/audio/1");
  assert.ok(netease.queries.every((query) => query !== "来点 linkin parl"));
});

test("artist direction must use LLM planned concrete song queries instead of bare artist search", async () => {
  const task: MusicTask = {
    type: "artist_direction",
    primaryEntities: [{ role: "artist", name: "Radiohead" }],
    workHint: "",
    styleHint: "Radiohead",
    negativeConstraints: [],
    searchGoals: ["Radiohead"],
    mustNotSearchLiteralUserSentence: true,
  };
  const llm = new FakeLlm();
  const searched: string[] = [];
  const netease = {
    async search(query: string): Promise<Track[]> {
      searched.push(query);
      return [{ id: "1", name: "Numb", artist: "Linkin Park", source: query }];
    },
  };
  const agent = new SearchVerifyAgent(llm as any, netease as any, new FakeAudioResolver() as any);

  const queries = await agent.queries(task, "我要听radiohead");

  assert.deepEqual(queries, ["Linkin Park Numb", "Linkin Park In the End"]);
  assert.equal(llm.calls[0].options["timeoutMs"], 12000);
  await agent.verify(task, "42", "我要听radiohead");
  assert.ok(searched.every((query) => query !== "Radiohead"));
  assert.ok(searched.every((query) => query !== "我要听radiohead"));
});

test("performer request like Zimerman is planned into concrete recordings and verified semantically", async () => {
  class ZimermanLlm {
    calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

    async chat(prompt: string, options: Record<string, unknown>): Promise<string> {
      this.calls.push({ prompt, options });
      if (prompt.includes("Rewrite this DJ music task")) {
        assert.match(prompt, /Krystian Zimerman/);
        return JSON.stringify({
          picks: [
            {
              artist: "Krystian Zimerman",
              title: "Chopin Ballade No. 1",
              query: "Krystian Zimerman Chopin Ballade No. 1",
              reason: "representative piano recording",
            },
            {
              artist: "Krystian Zimerman",
              title: "Beethoven Piano Concerto No. 5",
              query: "Krystian Zimerman Beethoven Piano Concerto No. 5",
              reason: "well-known concerto recording",
            },
          ],
          search_queries: [
            "Krystian Zimerman Chopin Ballade No. 1",
            "Krystian Zimerman Beethoven Piano Concerto No. 5",
          ],
        });
      }
      return JSON.stringify({
        chosen_id: "zim1",
        confidence: 0.94,
        matched_entities: ["齐默尔曼", "Krystian Zimerman", "Chopin"],
        version_note: "Performer alias and work match.",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "artist_direction",
    primaryEntities: [{ role: "performer", name: "Krystian Zimerman" }],
    workHint: "",
    styleHint: "classical piano",
    negativeConstraints: [],
    searchGoals: ["Krystian Zimerman"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      return [
        {
          id: "zim1",
          name: "Ballade No. 1 in G Minor, Op. 23",
          artist: "Krystian Zimerman",
          album: "Chopin: 4 Ballades",
          source: query,
        },
      ];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new ZimermanLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我要听齐默尔曼", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "zim1");
  assert.equal(result.url, "/api/radio/audio/zim1");
  assert.deepEqual(netease.queries, ["Krystian Zimerman Chopin Ballade No. 1", "Krystian Zimerman Beethoven Piano Concerto No. 5"]);
});

test("performer request still searches entity candidates when planner only returns a bare name", async () => {
  class BareNameLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["Krystian Zimerman"],
          picks: [{ artist: "Krystian Zimerman", title: "", query: "Krystian Zimerman" }],
        });
      }
      return JSON.stringify({
        chosen_id: "zim1",
        confidence: 0.91,
        matched_entities: ["Krystian Zimerman"],
        version_note: "Performer matches the listener request.",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "artist_direction",
    primaryEntities: [{ role: "performer", name: "Krystian Zimerman" }],
    workHint: "",
    styleHint: "classical piano",
    negativeConstraints: [],
    searchGoals: ["Krystian Zimerman"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      return [
        {
          id: "zim1",
          name: "Ballade No. 1 in G Minor, Op. 23",
          artist: "Krystian Zimerman",
          album: "Chopin: 4 Ballades",
          source: query,
        },
      ];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new BareNameLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我要听齐默尔曼", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "zim1");
  assert.ok(netease.queries.includes("Krystian Zimerman Chopin"));
  assert.ok(netease.queries.includes("Krystian Zimerman"));
});

test("specific track can keep a direct concrete query without planner expansion", async () => {
  const task: MusicTask = {
    type: "specific_track",
    primaryEntities: [
      { role: "artist", name: "Radiohead" },
      { role: "work", name: "No Surprises" },
    ],
    workHint: "No Surprises",
    styleHint: "",
    negativeConstraints: [],
    searchGoals: ["Radiohead No Surprises"],
    mustNotSearchLiteralUserSentence: true,
  };
  const llm = new FakeLlm();
  const agent = new SearchVerifyAgent(llm as any, new FakeNetease() as any, new FakeAudioResolver() as any);

  const queries = await agent.queries(task, "Radiohead No Surprises");

  assert.deepEqual(queries, ["Radiohead No Surprises"]);
  assert.equal(llm.calls.length, 0);
});

test("Chinese command sentence with adjacent latin artist is never accepted as a concrete query", async () => {
  const task: MusicTask = {
    type: "artist_direction",
    primaryEntities: [{ role: "artist", name: "Radiohead" }],
    workHint: "",
    styleHint: "Radiohead",
    negativeConstraints: [],
    searchGoals: ["我要听radiohead", "Radiohead No Surprises"],
    mustNotSearchLiteralUserSentence: true,
  };
  const llm = new FakeLlm();
  const agent = new SearchVerifyAgent(llm as any, new FakeNetease() as any, new FakeAudioResolver() as any);

  const queries = await agent.queries(task, "我要听radiohead");

  assert.deepEqual(queries, ["Radiohead No Surprises"]);
  assert.equal(llm.calls.length, 0);
});

test("generic anonymous R&B goals use concrete fast seeds instead of broad searches", async () => {
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "genre", name: "R&B" }],
    workHint: "",
    styleHint: "R&B",
    negativeConstraints: ["avoid overly loud tracks"],
    searchGoals: ["R&B", "R&B artists", "R&B songs"],
    mustNotSearchLiteralUserSentence: true,
  };
  const llm = new FakeLlm();
  const netease = new FakeNetease();
  const agent = new SearchVerifyAgent(llm as any, netease as any, new FakeAudioResolver() as any);

  const queries = await agent.queries(task, "我要听rnb");

  assert.deepEqual(queries, [
    "frank ocean pinkpuss",
    "Daniel Caesar Japanese Denim",
    "Frank Ocean Pink + White",
    "SZA Broken Clocks",
    "Summer Walker Session 32",
    "Jhené Aiko While We're Young",
  ]);
  assert.equal(llm.calls.length, 0);
  await agent.verify(task, "42", "我要听rnb");
  assert.ok(netease.queries.every((query) => !["R&B", "R&B artists", "R&B songs", "我要听rnb"].includes(query)));
});

test("R&B fallback prioritizes a proven playable seed before slower canonical searches", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic R&B execution");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "genre", name: "R&B" }],
    workHint: "",
    styleHint: "late-night R&B",
    negativeConstraints: ["jazz"],
    searchGoals: ["R&B"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "frank ocean pinkpuss") {
        return [{ id: "playable-rnb", name: "frank ocean - pinkpuss（pink + white remix）", artist: "LegoG", source: query }];
      }
      return [{ id: `blocked-${this.queries.length}`, name: "Japanese Denim", artist: "Daniel Caesar", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "playable-rnb"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, reason: "empty_url", proxyUrl: "" };
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "不要爵士了，换成晚上听的R&B");

  assert.equal(llm.calls, 0);
  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "playable-rnb");
  assert.equal(netease.queries[0], "frank ocean pinkpuss");
  assert.deepEqual(audioResolver.attempted, ["playable-rnb"]);
});

test("R&B local scene verification accepts trusted fresh registry seeds beyond the opening remix", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for trusted R&B registry seeds");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "genre", name: "R&B" }],
    workHint: "",
    styleHint: "late-night R&B",
    negativeConstraints: ["jazz", "classical", "edm"],
    searchGoals: ["R&B"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "Summer Walker Session 32") {
        return [{ id: "summer-session-32", name: "Session 32", artist: "Summer Walker", source: query }];
      }
      if (query === "Jhené Aiko While We're Young") {
        return [{ id: "jhene-young", name: "While We're Young", artist: "Jhené Aiko", source: query }];
      }
      if (query === "Brent Faiyaz Clouded") {
        return [{ id: "brent-clouded", name: "Clouded", artist: "Brent Faiyaz", source: query }];
      }
      if (query === "Kelela LMK") {
        return [{ id: "kelela-lmk", name: "LMK", artist: "Kelela", source: query }];
      }
      return [];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "kelela-lmk"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, proxyUrl: "", reason: "empty_url" };
    },
  };
  const context: MemoryPack = {
    ...personalContext,
    playbackContext: {
      currentTrack: { id: "her-focus", name: "Focus", artist: "H.E.R." },
      recentTracks: [
        { id: "sza-broken", name: "Broken Clocks", artist: "SZA" },
        { id: "frank-pink", name: "Pink + White", artist: "Frank Ocean" },
        { id: "daniel-denim", name: "Japanese Denim", artist: "Daniel Caesar" },
        { id: "her-focus", name: "Focus", artist: "H.E.R." },
      ],
      readyQueue: [],
      scene: "late-night R&B",
    },
  };
  const agent = new SearchVerifyAgent(new NoLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "play rnb", context);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "kelela-lmk");
  assert.deepEqual(audioResolver.attempted, ["summer-session-32", "jhene-young", "kelela-lmk"]);
});

test("style fallback queries come from registry instead of local ad hoc branches", async () => {
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "genre", name: "registry marker" }],
    workHint: "",
    styleHint: "registry marker",
    negativeConstraints: [],
    searchGoals: [],
    mustNotSearchLiteralUserSentence: true,
  };
  const registry = new FakeStyleRegistry();
  const agent = new SearchVerifyAgent(
    new FakeLlm() as any,
    new FakeNetease() as any,
    new FakeAudioResolver() as any,
    12000,
    registry as any,
  );

  const queries = await agent.queries(task, "play registry marker");

  assert.deepEqual(queries, ["Registry Artist Registry Song"]);
  assert.ok(registry.calls.some((text) => text.includes("registry marker")));
});

test("search verifier delegates concrete style seed lists to registry", () => {
  const source = fs.readFileSync("src/radio/searchVerifyAgent.ts", "utf8");
  const styleSeedStart = source.indexOf("private styleSeedQueries");
  const styleSeedEnd = source.indexOf("\n  private", styleSeedStart + 1);
  const styleSeedSource = source.slice(styleSeedStart, styleSeedEnd);

  assert.doesNotMatch(styleSeedSource, /Daniel Caesar|jazz piano bar academy|Seven Lions|Nora En Pure/);
});

test("abstract scene planning uses listener profile and memory instead of genre keywords alone", async () => {
  class ProfileAwareLlm {
    calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];

    async chat(prompt: string, options: Record<string, unknown>): Promise<string> {
      this.calls.push({ prompt, options });
      if (prompt.includes("Rewrite this DJ music task")) {
        assert.match(prompt, /Frank Ocean Nights/);
        assert.match(prompt, /SZA Good Days/);
        assert.match(prompt, /avoid noisy club tracks/);
        assert.match(prompt, /late_night/);
        return JSON.stringify({
          picks: [
            {
              artist: "Daniel Caesar",
              title: "Japanese Denim",
              query: "Daniel Caesar Japanese Denim",
              reason: "late-night intimate R&B adjacent to the listener profile",
            },
            {
              artist: "SZA",
              title: "Broken Clocks",
              query: "SZA Broken Clocks",
              reason: "soft R&B with a familiar anchor",
            },
          ],
          search_queries: ["Daniel Caesar Japanese Denim", "SZA Broken Clocks"],
        });
      }
      return JSON.stringify({
        chosen_id: "1",
        confidence: 0.9,
        matched_entities: ["late-night R&B", "listener profile"],
        version_note: "personalized late-night R&B fit",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "scene", name: "late night" },
      { role: "genre", name: "R&B" },
    ],
    workHint: "",
    styleHint: "late-night R&B",
    negativeConstraints: ["avoid loud club tracks"],
    searchGoals: ["R&B"],
    mustNotSearchLiteralUserSentence: true,
  };
  const llm = new ProfileAwareLlm();
  const agent = new SearchVerifyAgent(llm as any, new FakeNetease() as any, new FakeAudioResolver() as any);

  const queries = await agent.queries(task, "放点深夜听的rnb", personalContext);

  assert.deepEqual(queries, ["Daniel Caesar Japanese Denim", "SZA Broken Clocks"]);
  assert.ok(llm.calls[0].prompt.includes("Personal listener context"));
});

test("planner output that remains only style buckets falls back to concrete scene songs", async () => {
  class BucketOnlyLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          picks: [
            { artist: "", title: "", query: "R&B 电子融合" },
            { artist: "", title: "", query: "舞曲 R&B" },
            { artist: "", title: "", query: "Electronic R&B" },
          ],
          search_queries: ["R&B 电子融合", "舞曲 R&B", "Electronic R&B"],
        });
      }
      return JSON.stringify({
        chosen_id: "sza",
        confidence: 0.88,
        matched_entities: ["R&B"],
        version_note: "concrete R&B fallback candidate",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "R&B" },
      { role: "scene", name: "electronic fusion" },
    ],
    workHint: "",
    styleHint: "modern electronic R&B",
    negativeConstraints: ["avoid noisy club tracks"],
    searchGoals: ["R&B 电子融合", "舞曲 R&B", "Electronic R&B"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      return [{ id: "sza", name: "Snooze", artist: "SZA", source: query }];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new BucketOnlyLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我要听5电的rnb", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "sza");
  assert.ok(netease.queries.includes("Daniel Caesar Japanese Denim"));
  assert.ok(netease.queries.every((query) => !["R&B", "R&B tracks", "R&B playlist", "R&B evening"].includes(query)));
  assert.ok(result.diagnostics?.rejectedQueries?.includes("Electronic R&B"));
  assert.ok(netease.queries.every((query) => !["R&B 电子融合", "舞曲 R&B", "Electronic R&B"].includes(query)));
});

test("afternoon R&B request does not fail when planner returns only broad R&B goals", async () => {
  class BroadOnlyLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["R&B tracks", "R&B playlist", "R&B evening"],
          picks: [{ artist: "", title: "", query: "R&B tracks" }],
        });
      }
      return JSON.stringify({
        chosen_id: "daniel",
        confidence: 0.9,
        matched_entities: ["R&B", "evening"],
        version_note: "specific relaxed R&B track",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "R&B" },
      { role: "scene", name: "下午5点" },
    ],
    workHint: "",
    styleHint: "适合傍晚放松或带点氛围感的R&B",
    negativeConstraints: [],
    searchGoals: ["R&B", "R&B playlist", "R&B evening"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      return [{ id: "daniel", name: "Japanese Denim", artist: "Daniel Caesar", source: query }];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new BroadOnlyLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我要听下午5点的rnb", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "daniel");
  assert.ok(netease.queries.includes("Daniel Caesar Japanese Denim"));
  assert.ok(netease.queries.every((query) => query !== "R&B tracks" && query !== "R&B playlist" && query !== "R&B evening"));
});

test("descriptive R&B search goals are not treated as concrete NetEase queries", async () => {
  class DescriptiveLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["R&B tracks matching user's taste summary (intimate, warm, melancholy)"],
          picks: [
            {
              artist: "",
              title: "",
              query: "R&B tracks matching user's taste summary (intimate, warm, melancholy)",
            },
          ],
        });
      }
      return JSON.stringify({
        chosen_id: "frank",
        confidence: 0.9,
        matched_entities: ["R&B", "warm"],
        version_note: "specific profile-adjacent R&B track",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "genre", name: "R&B" }],
    workHint: "",
    styleHint: "intimate warm R&B",
    negativeConstraints: [],
    searchGoals: ["R&B tracks matching user's taste summary (intimate, warm, melancholy)"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      return [{ id: "frank", name: "Pink + White", artist: "Frank Ocean", source: query }];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new DescriptiveLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我要听rnb", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "frank");
  assert.ok(netease.queries.includes("frank ocean pinkpuss") || netease.queries.includes("Frank Ocean Pink + White"));
  assert.ok(netease.queries.every((query) => !query.includes("taste summary")));
});

test("negative feedback blocks rejected style seeds and does not replay the avoided direction", async () => {
  class NegativeLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["R&B tracks", "SZA Snooze", "Organic House"],
          picks: [
            { artist: "SZA", title: "Snooze", query: "SZA Snooze" },
            { artist: "", title: "", query: "Organic House" },
          ],
        });
      }
      return JSON.stringify({
        chosen_id: "ambient",
        confidence: 0.9,
        matched_entities: ["舒缓放松"],
        version_note: "avoids the rejected R&B direction",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "scene", name: "舒缓放松" },
      { role: "genre", name: "Ambient" },
      { role: "genre", name: "Chillout" },
      { role: "genre", name: "Organic House" },
    ],
    workHint: "偏向氛围感、温暖、有机音色、适合放松聆听",
    styleHint: "舒缓、平静、舒适",
    negativeConstraints: ["R&B", "强节奏", "人声突出", "高能量"],
    searchGoals: ["舒缓放松的电子音乐", "有机氛围电子", "Chillout", "Organic House"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      return [
        { id: "ambient", name: "Come With Me", artist: "Nora En Pure", source: query },
        { id: "sza", name: "Snooze", artist: "SZA", source: query },
      ];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new NegativeLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "不想听rnb了，放点舒服的", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "ambient");
  assert.ok(netease.queries.includes("Nora En Pure Come With Me"));
  assert.ok(netease.queries.every((query) => !/\bR&B\b|\brnb\b|SZA|Daniel Caesar|Frank Ocean/i.test(query)));
});

test("late-night emo fallback turns Chinese abstract mood into concrete non-EDM songs", async () => {
  class AbstractEmoLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["忧郁钢琴电子", "内省旋律电子"],
          picks: [{ artist: "", title: "", query: "忧郁钢琴电子" }],
        });
      }
      return JSON.stringify({
        chosen_id: "funeral",
        confidence: 0.91,
        matched_entities: ["late-night emo", "non-EDM"],
        version_note: "concrete emo-adjacent track, not EDM or dubstep",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "scene", name: "夜晚" },
      { role: "genre", name: "忧郁" },
      { role: "genre", name: "深沉" },
    ],
    workHint: "",
    styleHint: "旋律性强，情绪内敛，适合独处或沉思，避免高能节拍和过度电子化处理。",
    negativeConstraints: ["EDM", "Dubstep", "高能量舞曲"],
    searchGoals: ["适合夜晚的忧郁风格钢琴曲", "深沉的原声或氛围音乐", "带有情感张力但不吵闹的流行/独立音乐"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "Phoebe Bridgers Funeral") return [{ id: "funeral", name: "Funeral", artist: "Phoebe Bridgers", source: query }];
      return [{ id: "other", name: "I Bet on Losing Dogs", artist: "Mitski", source: query }];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new AbstractEmoLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我想听晚上 emo 的歌，不要 edm，不要 dubstep", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "funeral");
  assert.ok(netease.queries.includes("Phoebe Bridgers Funeral"));
  assert.ok(netease.queries.every((query) => !/EDM|Dubstep|忧郁钢琴电子|内省旋律电子/i.test(query)));
});

test("future bass fallback uses concrete artist-title songs instead of generic bass search", async () => {
  class GenericFutureBassLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["future bass", "cinematic bass music"],
          picks: [{ artist: "", title: "", query: "cinematic bass music" }],
        });
      }
      return JSON.stringify({
        chosen_id: "seven",
        confidence: 0.91,
        matched_entities: ["Future Bass"],
        version_note: "concrete future bass recording",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "genre", name: "Future Bass" }],
    workHint: "",
    styleHint: "Emotional, melodic, high-energy future bass with cinematic elements",
    negativeConstraints: [],
    searchGoals: ["future bass", "melodic future bass", "cinematic bass music"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      return [{ id: "seven", name: "Rush Over Me", artist: "Seven Lions", source: query }];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new GenericFutureBassLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "放点future bass", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "seven");
  assert.ok(netease.queries.includes("Seven Lions Rush Over Me"));
  assert.ok(netease.queries.every((query) => query !== "future bass" && query !== "cinematic bass music"));
});

test("scene fallback does not search profile prose or play candidates when verifier does not choose", async () => {
  class EmptyJudgeLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["R&B tracks with intimate vocals and warm production"],
          picks: [{ artist: "", title: "", query: "R&B tracks with intimate vocals and warm production" }],
        });
      }
      return JSON.stringify({ chosen_id: "", confidence: 0, matched_entities: [], risk: "" });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "genre", name: "R&B" }],
    workHint: "",
    styleHint: "warm textures intimate vocals",
    negativeConstraints: [],
    searchGoals: ["R&B tracks with intimate vocals and warm production"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      return [{ id: "sleep", name: "Baby Sleep Anchor", artist: "Serena Nightlight", source: query }];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(track: Track): Promise<any> {
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new EmptyJudgeLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我要听rnb", personalContext);

  assert.equal(result.status, "not_found");
  assert.ok(netease.queries.includes("Daniel Caesar Japanese Denim"));
  assert.ok(netease.queries.every((query) => !query.includes("anchors include") && !query.includes("prefers intimate")));
  assert.deepEqual(result.diagnostics?.attemptedSongIds, []);
});

test("late night R&B fallback avoids defaulting to a recently played Snooze candidate", async () => {
  class BucketOnlyLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["R&B evening"],
          picks: [{ artist: "", title: "", query: "R&B evening" }],
        });
      }
      return JSON.stringify({
        chosen_id: "snooze",
        confidence: 0.91,
        matched_entities: ["late-night R&B"],
        version_note: "semantic fit",
        risk: "",
      });
    }
  }
  const localContext: MemoryPack = {
    ...personalContext,
    playbackContext: {
      ...personalContext.playbackContext,
      recentTracks: [{ name: "Snooze", artist: "SZA" }],
      readyQueue: [{ name: "Snooze", artist: "SZA" }],
    },
  };
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "scene", name: "evening" },
      { role: "genre", name: "R&B" },
    ],
    workHint: "",
    styleHint: "evening R&B",
    negativeConstraints: [],
    searchGoals: ["R&B evening"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "SZA Snooze") return [{ id: "snooze", name: "Snooze", artist: "SZA", source: query }];
      if (query === "Daniel Caesar Japanese Denim") {
        return [{ id: "daniel", name: "Japanese Denim", artist: "Daniel Caesar", source: query }];
      }
      return [{ id: "other", name: "Pink + White", artist: "Frank Ocean", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new BucketOnlyLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我要听晚上的rnb", localContext);

  assert.equal(result.status, "verified");
  assert.notEqual(result.selectedSong?.id, "snooze");
  assert.ok(netease.queries.includes("Daniel Caesar Japanese Denim") || netease.queries.includes("frank ocean pinkpuss"));
  assert.ok(!audioResolver.attempted.includes("snooze"));
});

test("abstract R&B requests expand and demote a single default Snooze query", async () => {
  class SingleDefaultLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["SZA Snooze"],
          picks: [{ artist: "SZA", title: "Snooze", query: "SZA Snooze" }],
        });
      }
      return JSON.stringify({
        chosen_id: "snooze",
        confidence: 0.93,
        matched_entities: ["evening R&B"],
        version_note: "semantic fit",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "scene", name: "evening" },
      { role: "genre", name: "R&B" },
    ],
    workHint: "",
    styleHint: "evening R&B",
    negativeConstraints: [],
    searchGoals: ["SZA Snooze"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "SZA Snooze") return [{ id: "snooze", name: "Snooze", artist: "SZA", source: query }];
      if (query === "Daniel Caesar Japanese Denim") {
        return [{ id: "daniel", name: "Japanese Denim", artist: "Daniel Caesar", source: query }];
      }
      return [{ id: "other", name: "Pink + White", artist: "Frank Ocean", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const agent = new SearchVerifyAgent(new SingleDefaultLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "I want evening rnb", personalContext);

  assert.equal(result.status, "verified");
  assert.notEqual(result.selectedSong?.id, "snooze");
  assert.ok(netease.queries.includes("Daniel Caesar Japanese Denim") || netease.queries.includes("frank ocean pinkpuss"));
  assert.ok(!audioResolver.attempted.includes("snooze"));
});

test("quiet jazz fallback keeps searching playable adjacent seeds when classic versions are unavailable", async () => {
  class QuietJazzLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["Bill Evans Waltz for Debby"],
          picks: [{ artist: "Bill Evans", title: "Waltz for Debby", query: "Bill Evans Waltz for Debby" }],
        });
      }
      return JSON.stringify({
        chosen_id: "bill",
        confidence: 0.93,
        matched_entities: ["quiet jazz"],
        version_note: "semantic fit",
        risk: "",
      });
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy quiet") {
        return [{ id: "playable", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy", source: query }];
      }
      return [{ id: "bill", name: "Waltz for Debby", artist: "Bill Evans", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "playable"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, reason: "empty_url", proxyUrl: "" };
    },
  };
  const agent = new SearchVerifyAgent(new QuietJazzLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "playable");
  assert.equal(result.url, "/api/radio/audio/playable");
  assert.equal(netease.queries[0], "jazz piano bar academy quiet");
  assert.deepEqual(audioResolver.attempted, ["playable"]);
});

test("quiet jazz playable local fallback verifies before waiting for the LLM judge", async () => {
  class PlanningOnlyLlm {
    judgeCalls = 0;

    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          search_queries: ["Bill Evans Waltz for Debby"],
          picks: [{ artist: "Bill Evans", title: "Waltz for Debby", query: "Bill Evans Waltz for Debby" }],
        });
      }
      this.judgeCalls += 1;
      throw new Error("judge should not be needed for a locally playable quiet jazz fallback");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy quiet") {
        return [{ id: "playable", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy", source: query }];
      }
      return [{ id: "blocked", name: "Waltz for Debby", artist: "Bill Evans", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "playable"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, reason: "empty_url", proxyUrl: "" };
    },
  };
  const llm = new PlanningOnlyLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "playable");
  assert.equal(llm.judgeCalls, 0);
  assert.ok(netease.queries.includes("jazz piano bar academy quiet"));
  assert.deepEqual(audioResolver.attempted, ["playable"]);
});

test("quiet jazz style requests can verify from deterministic seeds without the LLM planner", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic quiet jazz execution");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy quiet") {
        return [{ id: "playable", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy", source: query }];
      }
      return [{ id: "blocked", name: "Waltz for Debby", artist: "Bill Evans", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "playable"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, reason: "empty_url", proxyUrl: "" };
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "playable");
  assert.equal(llm.calls, 0);
  assert.ok(netease.queries.includes("jazz piano bar academy quiet"));
  assert.deepEqual(audioResolver.attempted, ["playable"]);
});

test("quiet jazz local fallback stops searching after the first playable deterministic style match", async () => {
  class NoLlm {
    async chat(): Promise<string> {
      throw new Error("LLM should not be needed for deterministic quiet jazz execution");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy quiet") {
        return [{ id: "playable", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy", source: query }];
      }
      return [{ id: `blocked-${this.queries.length}`, name: "Waltz for Debby", artist: "Bill Evans", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "playable"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, reason: "empty_url", proxyUrl: "" };
    },
  };
  const agent = new SearchVerifyAgent(new NoLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "playable");
  assert.ok(netease.queries.includes("jazz piano bar academy quiet"));
  assert.ok(!netease.queries.includes("jazz piano bar academy reading"));
  assert.deepEqual(audioResolver.attempted, ["playable"]);
});

test("quiet jazz deterministic style fallback prioritizes proven playable seeds before slow classic searches", async () => {
  class NoLlm {
    async chat(): Promise<string> {
      throw new Error("LLM should not be needed for deterministic quiet jazz execution");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const agent = new SearchVerifyAgent(new NoLlm() as any, { search: async () => [] } as any, {} as any);

  const queries = await agent.queries(task, "play quiet jazz for reading", personalContext);

  assert.equal(queries[0], "jazz piano bar academy quiet");
  assert.ok(queries.indexOf("jazz piano bar academy quiet") < queries.indexOf("Bill Evans Waltz for Debby"));
  assert.ok(queries.indexOf("jazz piano bar academy quiet") < queries.indexOf("Miles Davis Blue in Green"));
});

test("quiet jazz deterministic fallback still runs when guardrails block classical and electronic drift", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for bounded quiet jazz execution");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz / quiet jazz for reading",
    negativeConstraints: ["classical chamber music", "electronic ambient"],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, { search: async () => [] } as any, {} as any);

  const queries = await agent.queries(task, "Station brief: Quiet jazz for reading.", personalContext);

  assert.equal(llm.calls, 0);
  assert.equal(queries[0], "jazz piano bar academy quiet");
  assert.ok(!queries.some((query) => /classical|electronic/i.test(query)));
});

test("quiet jazz fallback skips the recently played local seed and keeps searching inside the style", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic quiet jazz recovery");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy reading") {
        return [{ id: "fresh-jazz", name: "Piano Instrumental Music", artist: "Jazz Piano Bar Academy", source: query }];
      }
      if (query === "Bill Evans Waltz for Debby") {
        return [{ id: "bill", name: "Waltz for Debby", artist: "Bill Evans", source: query }];
      }
      return [{ id: `miss-${this.queries.length}`, name: "No usable result", artist: "Unknown", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "fresh-jazz"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, proxyUrl: "", reason: "empty_url" };
    },
  };
  const context: MemoryPack = {
    ...personalContext,
    playbackContext: {
      currentTrack: { id: "played-jazz", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy" },
      recentTracks: [{ id: "played-jazz", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy" }],
      readyQueue: [],
      scene: "reading",
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", context);

  assert.equal(llm.calls, 0);
  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "fresh-jazz");
  assert.equal(netease.queries[0], "jazz piano bar academy reading");
  assert.ok(!netease.queries.includes("jazz piano bar academy quiet"));
  assert.deepEqual(audioResolver.attempted, ["fresh-jazz"]);
});

test("quiet jazz fallback can use an unplayed local seed when the opening track was another local seed", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic quiet jazz recovery");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy quiet") {
        return [{ id: "italian", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy", source: query }];
      }
      return [{ id: `unplayable-${this.queries.length}`, name: "No usable result", artist: "Unknown", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "italian"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, proxyUrl: "", reason: "empty_url" };
    },
  };
  const context: MemoryPack = {
    ...personalContext,
    playbackContext: {
      currentTrack: { id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy" },
      recentTracks: [{ id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy" }],
      readyQueue: [],
      scene: "reading",
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", context);

  assert.equal(llm.calls, 0);
  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "italian");
  assert.equal(netease.queries[0], "jazz piano bar academy quiet");
  assert.ok(!netease.queries.includes("jazz piano bar academy reading"));
  assert.deepEqual(audioResolver.attempted, ["italian"]);
});

test("quiet jazz fallback avoids looping both recently played local seeds", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic quiet jazz recovery");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "Bill Evans Waltz for Debby") {
        return [{ id: "bill-evans", name: "Waltz for Debby", artist: "Bill Evans", source: query }];
      }
      return [{ id: `recent-${this.queries.length}`, name: query.includes("reading") ? "Magical Piano" : "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "bill-evans"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, proxyUrl: "", reason: "recent_seed_blocked" };
    },
  };
  const context: MemoryPack = {
    ...personalContext,
    playbackContext: {
      currentTrack: { id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy" },
      recentTracks: [
        { id: "italian", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy" },
        { id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy" },
      ],
      readyQueue: [],
      scene: "reading",
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", context);

  assert.equal(llm.calls, 0);
  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "bill-evans");
  assert.equal(netease.queries[0], "Bill Evans Waltz for Debby");
  assert.ok(!netease.queries.includes("jazz piano bar academy quiet"));
  assert.ok(!netease.queries.includes("jazz piano bar academy reading"));
});

test("quiet jazz local verification rejects recently played local seed candidates from broad queries", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic quiet jazz recovery");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "Bill Evans Waltz for Debby") {
        return [{ id: "bill", name: "Waltz for Debby", artist: "Bill Evans", source: query }];
      }
      return [
        { id: "italian", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy", source: query },
        { id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy", source: query },
      ];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const context: MemoryPack = {
    ...personalContext,
    playbackContext: {
      currentTrack: { id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy" },
      recentTracks: [
        { id: "italian", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy" },
        { id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy" },
        { id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy" },
      ],
      readyQueue: [],
      scene: "reading",
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", context);

  assert.equal(llm.calls, 0);
  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "bill");
  assert.deepEqual(audioResolver.attempted, ["bill"]);
  assert.ok(!audioResolver.attempted.includes("italian"));
  assert.ok(!audioResolver.attempted.includes("bar-cafe"));
});

test("quiet jazz early local fallback skips a recently played local seed before resolving audio", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic quiet jazz recovery");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy quiet") {
        return [{ id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy", source: query }];
      }
      if (query === "Bill Evans Waltz for Debby") {
        return [{ id: "bill", name: "Waltz for Debby", artist: "Bill Evans", source: query }];
      }
      return [];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const context: MemoryPack = {
    ...personalContext,
    playbackContext: {
      currentTrack: { id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy" },
      recentTracks: [{ id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy" }],
      readyQueue: [],
      scene: "reading",
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", context);

  assert.equal(llm.calls, 0);
  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "bill");
  assert.deepEqual(audioResolver.attempted, ["bill"]);
  assert.ok(!audioResolver.attempted.includes("bar-cafe"));
});

test("quiet jazz fallback can rotate from a recently played bar cafe seed to another local quiet jazz seed", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic quiet jazz recovery");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy quiet") {
        return [{ id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy", source: query }];
      }
      if (query === "jazz piano bar academy reading") {
        return [{ id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy", source: query }];
      }
      if (query === "Bill Evans Waltz for Debby" || query === "Chet Baker I Fall In Love Too Easily" || query === "Miles Davis Blue in Green") {
        return [{ id: `classic-${this.queries.length}`, name: "Unavailable Classic", artist: "Classic Artist", source: query }];
      }
      return [];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return track.id === "magical"
        ? { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` }
        : { ok: false, songId: track.id, proxyUrl: "", reason: "empty_url" };
    },
  };
  const context: MemoryPack = {
    ...personalContext,
    playbackContext: {
      currentTrack: { id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy" },
      recentTracks: [{ id: "bar-cafe", name: "Bar Music Chillout Cafe", artist: "Jazz Piano Bar Academy" }],
      readyQueue: [],
      scene: "reading",
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", context);

  assert.equal(llm.calls, 0);
  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "magical");
  assert.ok(!netease.queries.includes("jazz piano bar academy quiet"));
  assert.equal(netease.queries[0], "jazz piano bar academy reading");
  assert.deepEqual(audioResolver.attempted, ["magical"]);
});

test("quiet jazz fallback refuses to loop when only recently played local seeds are playable", async () => {
  class NoLlm {
    calls = 0;

    async chat(): Promise<string> {
      this.calls += 1;
      throw new Error("LLM should not be needed for deterministic quiet jazz recovery");
    }
  }
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "genre", name: "quiet jazz" },
      { role: "scene", name: "reading" },
    ],
    workHint: "",
    styleHint: "quiet jazz for reading",
    negativeConstraints: [],
    searchGoals: ["quiet jazz for reading"],
    mustNotSearchLiteralUserSentence: true,
  };
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query === "jazz piano bar academy quiet") {
        return [{ id: "italian", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy", source: query }];
      }
      if (query === "jazz piano bar academy reading") {
        return [{ id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy", source: query }];
      }
      if (query === "Jazz Piano Bar Academy Piano Instrumental Music") {
        return [{ id: "piano", name: "Piano Instrumental Music", artist: "Jazz Piano Bar Academy", source: query }];
      }
      return [];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return { ok: true, songId: track.id, proxyUrl: `/api/radio/audio/${track.id}` };
    },
  };
  const context: MemoryPack = {
    ...personalContext,
    playbackContext: {
      currentTrack: { id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy" },
      recentTracks: [
        { id: "italian", name: "Italian Dinner Background Music", artist: "Jazz Piano Bar Academy" },
        { id: "magical", name: "Magical Piano", artist: "Jazz Piano Bar Academy" },
        { id: "piano", name: "Piano Instrumental Music", artist: "Jazz Piano Bar Academy" },
      ],
      readyQueue: [],
      scene: "reading",
    },
  };
  const llm = new NoLlm();
  const agent = new SearchVerifyAgent(llm as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, null, "play quiet jazz for reading", context);

  assert.equal(llm.calls, 0);
  assert.equal(result.status, "not_found");
  assert.deepEqual(audioResolver.attempted, []);
});

test("not-found verification returns searched queries and candidate diagnostics", async () => {
  class ConcreteLlm {
    async chat(prompt: string): Promise<string> {
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          picks: [{ artist: "Kelela", title: "LMK", query: "Kelela LMK" }],
          search_queries: ["Kelela LMK"],
        });
      }
      return JSON.stringify({
        chosen_id: "unplayable",
        confidence: 0.92,
        matched_entities: ["electronic R&B"],
        version_note: "semantic fit",
        risk: "",
      });
    }
  }
  const netease = {
    async search(query: string): Promise<Track[]> {
      return [{ id: "unplayable", name: "LMK", artist: "Kelela", source: query }];
    },
  };
  const audioResolver = {
    async resolveWithCandidates(): Promise<any> {
      return { ok: false, songId: "unplayable", reason: "empty_url", proxyUrl: "" };
    },
  };
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [{ role: "genre", name: "R&B" }],
    workHint: "",
    styleHint: "electronic R&B",
    negativeConstraints: [],
    searchGoals: ["Kelela LMK"],
    mustNotSearchLiteralUserSentence: true,
  };
  const agent = new SearchVerifyAgent(new ConcreteLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "我要听5电的rnb", personalContext);

  assert.equal(result.status, "not_found");
  assert.equal(result.failureReason, "Verified candidates were not playable.");
  assert.deepEqual(result.diagnostics?.searchedQueries, ["Kelela LMK"]);
  assert.deepEqual(result.diagnostics?.candidateIds, ["unplayable"]);
});

test("verifier keeps trying the planned private DJ list when the first chosen song is not playable", async () => {
  class OrderedLlm {
    calls: string[] = [];

    async chat(prompt: string): Promise<string> {
      this.calls.push(prompt);
      if (prompt.includes("Rewrite this DJ music task")) {
        return JSON.stringify({
          picks: [
            { artist: "Daniel Caesar", title: "Japanese Denim", query: "Daniel Caesar Japanese Denim" },
            { artist: "SZA", title: "Broken Clocks", query: "SZA Broken Clocks" },
          ],
          search_queries: ["Daniel Caesar Japanese Denim", "SZA Broken Clocks"],
        });
      }
      return JSON.stringify({
        chosen_id: "blocked",
        confidence: 0.93,
        matched_entities: ["late-night R&B"],
        version_note: "best semantic fit",
        risk: "",
      });
    }
  }
  const netease = {
    queries: [] as string[],
    async search(query: string): Promise<Track[]> {
      this.queries.push(query);
      if (query.includes("Daniel Caesar")) {
        return [{ id: "blocked", name: "Japanese Denim", artist: "Daniel Caesar", source: query }];
      }
      return [{ id: "playable", name: "Broken Clocks", artist: "SZA", source: query }];
    },
  };
  const audioResolver = {
    attempted: [] as string[],
    async resolveWithCandidates(track: Track): Promise<any> {
      this.attempted.push(track.id);
      return {
        ok: track.id === "playable",
        songId: track.id,
        proxyUrl: track.id === "playable" ? `/api/radio/audio/${track.id}` : "",
      };
    },
  };
  const task: MusicTask = {
    type: "scene_genre_direction",
    primaryEntities: [
      { role: "scene", name: "late night" },
      { role: "genre", name: "R&B" },
    ],
    workHint: "",
    styleHint: "late-night R&B",
    negativeConstraints: [],
    searchGoals: ["R&B"],
    mustNotSearchLiteralUserSentence: true,
  };
  const agent = new SearchVerifyAgent(new OrderedLlm() as any, netease as any, audioResolver as any);

  const result = await agent.verify(task, "42", "放点深夜听的rnb", personalContext);

  assert.equal(result.status, "verified");
  assert.equal(result.selectedSong?.id, "playable");
  assert.equal(result.url, "/api/radio/audio/playable");
  assert.deepEqual(audioResolver.attempted, ["blocked", "playable"]);
  assert.deepEqual(netease.queries, ["Daniel Caesar Japanese Denim", "SZA Broken Clocks"]);
});
