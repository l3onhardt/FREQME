import assert from "node:assert/strict";
import test from "node:test";

import { LyricService, parseLrc } from "../../src/services/lyricService.js";

test("parseLrc converts timestamped lines into sorted lyric lines", () => {
  const parsed = parseLrc(`
[ar:Artist]
[00:12.34]First line
[00:15.00][00:18.50]Repeated line
[01:02.7]Later line
plain metadata
`);

  assert.deepEqual(parsed, [
    { timeMs: 12340, text: "First line" },
    { timeMs: 15000, text: "Repeated line" },
    { timeMs: 18500, text: "Repeated line" },
    { timeMs: 62700, text: "Later line" },
  ]);
});

test("lyric service fetches NetEase lyric_new and returns parsed lines", async () => {
  const netease = {
    async lyrics(songId: string): Promise<Record<string, unknown>> {
      assert.equal(songId, "42");
      return {
        lrc: { lyric: "[00:01.00]Hello\n[00:02.50]World" },
        tlyric: { lyric: "[00:01.00]你好\n[00:02.50]世界" },
      };
    },
  };
  const service = new LyricService(netease as any);

  const result = await service.forSong("42");

  assert.equal(result.songId, "42");
  assert.equal(result.source, "netease");
  assert.deepEqual(result.lines, [
    { timeMs: 1000, text: "Hello" },
    { timeMs: 2500, text: "World" },
  ]);
  assert.deepEqual(result.translatedLines, [
    { timeMs: 1000, text: "你好" },
    { timeMs: 2500, text: "世界" },
  ]);
});

test("lyric service returns an empty result when lyrics are unavailable", async () => {
  const netease = {
    async lyrics(): Promise<Record<string, unknown>> {
      return { nolyric: true };
    },
  };
  const service = new LyricService(netease as any);

  const result = await service.forSong("missing");

  assert.equal(result.songId, "missing");
  assert.equal(result.source, "none");
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.translatedLines, []);
});

test("lyric service falls back to a matching search result when the playable id has no lyrics", async () => {
  const calls: string[] = [];
  const netease = {
    async lyrics(songId: string): Promise<Record<string, unknown>> {
      calls.push(songId);
      if (songId === "playable-without-lyrics") return { nolyric: true };
      return {
        lrc: { lyric: "[00:04.18]Yeah, yeah, um\n[00:07.20]Yeah, yeah, yeah" },
        tlyric: { lyric: "" },
      };
    },
    async search(query: string) {
      assert.equal(query, "Frank Ocean Pink + White");
      return [
        { id: "matched-lyrics", name: "Pink + White", artist: "Frank Ocean" },
        { id: "wrong", name: "Pink + White Remix", artist: "Someone Else" },
      ];
    },
  };
  const service = new LyricService(netease as any);

  const result = await service.forSong("playable-without-lyrics", { name: "Pink + White", artist: "Frank Ocean" });

  assert.deepEqual(calls, ["playable-without-lyrics", "matched-lyrics"]);
  assert.equal(result.songId, "playable-without-lyrics");
  assert.equal(result.source, "netease");
  assert.deepEqual(result.lines, [
    { timeMs: 4180, text: "Yeah, yeah, um" },
    { timeMs: 7200, text: "Yeah, yeah, yeah" },
  ]);
});
