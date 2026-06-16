import assert from "node:assert/strict";
import test from "node:test";

import { audioProxyContentType } from "../../src/services/audioProxy.js";

test("audio proxy accepts octet-stream responses when bytes identify MP3 audio", () => {
  const result = audioProxyContentType("application/octet-stream;charset=UTF-8", Buffer.from("ID3\x04\x00\x00", "latin1"));

  assert.equal(result.ok, true);
  assert.equal(result.contentType, "audio/mpeg");
});

test("audio proxy rejects octet-stream responses without known audio bytes", () => {
  const result = audioProxyContentType("application/octet-stream", Buffer.from("{\"error\":\"not audio\"}"));

  assert.equal(result.ok, false);
});

test("audio proxy preserves explicit audio content types", () => {
  const result = audioProxyContentType("audio/flac", Buffer.from("fLaC", "latin1"));

  assert.equal(result.ok, true);
  assert.equal(result.contentType, "audio/flac");
});
