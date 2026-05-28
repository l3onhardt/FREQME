import assert from "node:assert/strict";
import test from "node:test";

import { SearchVerifyAgent } from "../../src/radio/searchVerifyAgent.js";
import type { MusicTask, Track } from "../../src/types.js";

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
