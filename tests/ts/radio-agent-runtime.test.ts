import assert from "node:assert/strict";
import test from "node:test";

import { RadioAgentRuntime } from "../../src/radio-agent/radioAgentRuntime.js";

test("shadow runtime persists login event and schedules library scan", async () => {
  const events: string[] = [];
  const decisions: string[] = [];
  const store = {
    appendEvent: (event: { type: string }) => {
      events.push(event.type);
      return events.length;
    },
    recentEvents: () => [],
    upsertMemory: () => undefined,
    memories: () => [],
    saveArtifact: () => undefined,
    artifact: () => null,
    saveShadowDecision: (decision: { decisionType: string }) => {
      decisions.push(decision.decisionType);
    },
    latestShadowDecisions: () => [],
  };
  const census = { scan: async () => ({ playlistsScanned: 0, tracksScanned: 0, failures: [] }) };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census, now: () => "2026-06-03T01:02:03.000Z" });
  const result = await runtime.handle({ type: "login_completed", uid: "42", sessionId: 1 });

  assert.equal(result.controlsPlayback, false);
  assert.deepEqual(events.slice(0, 2), ["login_completed", "library_scan_requested"]);
  assert.ok(events.includes("library_scan_completed"));
  assert.ok(decisions.includes("host"));
});

test("shadow runtime handles library scan failure without taking playback control", async () => {
  const events: string[] = [];
  const store = {
    appendEvent: (event: { type: string }) => {
      events.push(event.type);
      return events.length;
    },
    recentEvents: () => [],
    upsertMemory: () => undefined,
    memories: () => [],
    saveArtifact: () => undefined,
    artifact: () => null,
    saveShadowDecision: () => undefined,
    latestShadowDecisions: () => [],
  };
  const census = { scan: async () => { throw new Error("network down"); } };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, census, now: () => "2026-06-03T01:02:03.000Z" });
  const result = await runtime.handle({ type: "login_completed", uid: "42", sessionId: 1 });
  await runtime.flushBackgroundWork();

  assert.equal(result.controlsPlayback, false);
  assert.ok(events.includes("radio_agent_library_scan_failed"));
});

test("runtime writes skip session evidence as a shadow decision", async () => {
  const decisions: Array<{ decisionType: string; payload: Record<string, unknown> }> = [];
  const store = {
    appendEvent: () => 1,
    recentEvents: () => [],
    upsertMemory: () => undefined,
    memories: () => [],
    saveArtifact: () => undefined,
    artifact: () => null,
    saveShadowDecision: (decision: { decisionType: string; payload: Record<string, unknown> }) => {
      decisions.push(decision);
    },
    latestShadowDecisions: () => [],
  };

  const runtime = new RadioAgentRuntime({ mode: "shadow", store, now: () => "2026-06-03T01:02:03.000Z" });
  const result = await runtime.handle({
    type: "track_skipped",
    uid: "42",
    sessionId: 1,
    track: { id: "bad-1", name: "Bad", artist: "A" },
  });

  assert.equal(result.controlsPlayback, false);
  assert.ok(decisions.some((decision) => decision.decisionType === "session_evidence"));
});
