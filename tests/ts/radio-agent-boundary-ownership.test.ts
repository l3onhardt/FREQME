import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const forbiddenInServer = [
  /radioBrain\.handleUserText/g,
  /radioBrain\.startSession/g,
  /stationDirector\.pickNext/g,
  /stationDirector\.handleUserRequest/g,
  /scheduler\.pickNext/g,
  /fillQueue\(1,\s*false\)/g,
];

test("server does not call legacy decision systems outside explicit fallback helpers", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const allowedHelpers = [
    "const buildLegacyFallbackCandidate",
    "const buildLegacyOpeningFallbackCandidate",
    "const buildLegacyRequestFallbackCandidate",
    "const buildLegacyContinuationFallbackCandidate",
    "const legacyFallbackCandidateSource",
    "const runGovernedLegacyFallback",
  ];
  const allowedRanges = allowedHelpers
    .map((helper) => {
      const start = source.indexOf(helper);
      if (start < 0) return null;
      const nextHelper = source.indexOf("\n  const ", start + 1);
      return { start, end: nextHelper > start ? nextHelper : source.length };
    })
    .filter((range): range is { start: number; end: number } => Boolean(range));

  for (const pattern of forbiddenInServer) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      const window = source.slice(Math.max(0, index - 500), index + 500);
      assert.ok(
        allowedHelpers.some((helper) => window.includes(helper)) ||
          allowedRanges.some((range) => index >= range.start && index < range.end),
        `Forbidden legacy call ${match[0]} outside allowed fallback helper near index ${index}`,
      );
    }
  }
});

test("legacy fallback tools module cannot mutate playback directly", () => {
  const source = fs.readFileSync("src/radio-agent/legacyFallbackTools.ts", "utf8");
  assert.doesNotMatch(source, /queue\.addReady|queue\.promoteNext|fillQueue|send\(|synthesizeAndSendDjMessage|radioBrain|stationDirector|scheduler/);
});
