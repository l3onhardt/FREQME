import assert from "node:assert/strict";
import test from "node:test";

import { LibraryCensus } from "../../src/radio-agent/libraryCensus.js";

test("library census scans every playlist and stores normalized tracks", async () => {
  const calls: string[] = [];
  const netease = {
    userPlaylist: async () => [
      { id: 1, name: "Night" },
      { id: 2, name: "Work" },
    ],
    playlistDetail: async (id: string | number) => {
      calls.push(String(id));
      return {
        playlist: {
          id,
          name: `P${id}`,
          tracks: [{ id: `song-${id}`, name: `Song ${id}`, ar: [{ name: "Artist" }], al: { name: "Album" } }],
        },
      };
    },
    normalizeTrack: (song: Record<string, unknown>, source = "") => ({
      id: String(song.id || ""),
      name: String(song.name || ""),
      artist: "Artist",
      album: "Album",
      source,
      raw: song,
    }),
  };
  const saved: Array<{ playlistId: string; count: number }> = [];
  const playlists: string[] = [];
  const store = {
    savePlaylist: (_uid: string, playlist: { playlistId: string }) => playlists.push(playlist.playlistId),
    savePlaylistTracks: (_uid: string, playlistId: string, tracks: unknown[]) => {
      saved.push({ playlistId, count: tracks.length });
    },
  };

  const census = new LibraryCensus(netease, store);
  const result = await census.scan("42");

  assert.deepEqual(calls, ["1", "2"]);
  assert.deepEqual(playlists, ["1", "2"]);
  assert.deepEqual(saved, [{ playlistId: "1", count: 1 }, { playlistId: "2", count: 1 }]);
  assert.equal(result.playlistsScanned, 2);
  assert.equal(result.tracksScanned, 2);
  assert.deepEqual(result.failures, []);
});

test("library census continues when one playlist detail fails", async () => {
  const netease = {
    userPlaylist: async () => [
      { id: 1, name: "Broken" },
      { id: 2, name: "Good" },
    ],
    playlistDetail: async (id: string | number) => {
      if (String(id) === "1") throw new Error("playlist unavailable");
      return {
        playlist: {
          id,
          name: "Good",
          tracks: [{ id: "song-2", name: "Song 2", ar: [{ name: "Artist" }], al: { name: "Album" } }],
        },
      };
    },
    normalizeTrack: (song: Record<string, unknown>, source = "") => ({
      id: String(song.id || ""),
      name: String(song.name || ""),
      artist: "Artist",
      album: "Album",
      source,
      raw: song,
    }),
  };
  const saved: string[] = [];
  const store = {
    savePlaylist: () => undefined,
    savePlaylistTracks: (_uid: string, playlistId: string) => saved.push(playlistId),
  };

  const census = new LibraryCensus(netease, store);
  const result = await census.scan("42");

  assert.deepEqual(saved, ["2"]);
  assert.equal(result.playlistsScanned, 1);
  assert.equal(result.tracksScanned, 1);
  assert.equal(result.failures[0]?.playlistId, "1");
  assert.match(result.failures[0]?.reason || "", /playlist unavailable/);
});

test("library census paginates user playlists until the final page", async () => {
  const playlistCalls: Array<{ limit?: number; offset?: number }> = [];
  const netease = {
    userPlaylist: async (_uid: string, options: { limit?: number; offset?: number } = {}) => {
      playlistCalls.push(options);
      if (options.offset === 0) return [{ id: 1, name: "A" }, { id: 2, name: "B" }];
      if (options.offset === 2) return [{ id: 3, name: "C" }];
      return [];
    },
    playlistDetail: async (id: string | number) => ({
      playlist: {
        id,
        name: `P${id}`,
        tracks: [{ id: `song-${id}`, name: `Song ${id}`, ar: [{ name: "Artist" }] }],
      },
    }),
    normalizeTrack: (song: Record<string, unknown>, source = "") => ({
      id: String(song.id || ""),
      name: String(song.name || ""),
      artist: "Artist",
      album: "",
      source,
      raw: song,
    }),
  };
  const store = {
    savePlaylist: () => undefined,
    savePlaylistTracks: () => undefined,
  };

  const census = new LibraryCensus(netease, store, { pageSize: 2 });
  const result = await census.scan("42");

  assert.deepEqual(playlistCalls, [
    { limit: 2, offset: 0 },
    { limit: 2, offset: 2 },
  ]);
  assert.equal(result.playlistsScanned, 3);
  assert.equal(result.tracksScanned, 3);
});
