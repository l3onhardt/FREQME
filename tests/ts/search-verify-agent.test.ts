import assert from "node:assert/strict";
import test from "node:test";

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

test("generic R&B goals are expanded by the search planner instead of searched directly", async () => {
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

  assert.deepEqual(queries, ["Linkin Park Numb", "Linkin Park In the End"]);
  assert.equal(llm.calls[0].options["timeoutMs"], 12000);
  await agent.verify(task, "42", "我要听rnb");
  assert.ok(netease.queries.every((query) => !["R&B", "R&B artists", "R&B songs", "我要听rnb"].includes(query)));
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

test("planner output that remains only style buckets is rejected with diagnostics", async () => {
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
      return JSON.stringify({ chosen_id: "", confidence: 0 });
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
  const netease = new FakeNetease();
  const agent = new SearchVerifyAgent(new BucketOnlyLlm() as any, netease as any, new FakeAudioResolver() as any);

  const result = await agent.verify(task, "42", "我要听5电的rnb", personalContext);

  assert.equal(result.status, "not_found");
  assert.equal(netease.queries.length, 0);
  assert.equal(result.failureReason, "Search planner did not produce concrete song queries.");
  assert.deepEqual(result.diagnostics?.rejectedQueries, ["R&B 电子融合", "舞曲 R&B", "Electronic R&B"]);
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
