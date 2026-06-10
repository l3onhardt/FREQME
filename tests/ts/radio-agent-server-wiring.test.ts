import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("server wires long-term radio agent from configured mode", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");

  assert.match(source, /RadioAgentRuntime/);
  assert.match(source, /RadioAgentStore/);
  assert.match(source, /mode:\s*config\.radioAgentMode/);
  assert.match(source, /radioAgent\.handle/);
  assert.match(source, /\/api\/radio\/agent\/status/);
});

test("server wires assisted radio agent planning before legacy station director fallback", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");

  assert.match(source, /RadioAgentProgramDirector/);
  assert.match(source, /RadioAgentProgramExecutor/);
  assert.match(source, /tryQueueRadioAgentAssistedTrack/);
  assert.match(source, /config\.radioAgentMode/);
  assert.match(source, /tryRadioAgentAssistedQueue/);
  assert.match(source, /stationDirector\.pickNext/);
  const fillQueueStart = source.indexOf("const fillQueue =");
  const assistedCall = source.indexOf("await tryRadioAgentAssistedQueue()", fillQueueStart);
  const legacyPickNextCall = source.indexOf("stationDirector.pickNext", fillQueueStart);

  assert.ok(fillQueueStart >= 0);
  assert.ok(assistedCall > fillQueueStart);
  assert.ok(legacyPickNextCall > assistedCall);
  assert.match(source, /readyQueue:\s*queue\.readyItems\(\)\.map\(\(item\)\s*=>\s*\(\{[\s\S]*selectionReason:\s*item\.selectionReason/);
});

test("server keeps assisted fallback logging best effort", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const assistedQueueSource = fs.readFileSync("src/radio-agent/assistedQueue.ts", "utf8");

  assert.match(source, /logRadioAgentAssistedFallback/);
  assert.match(source, /try\s*{\s*store\.logPlaybackEvent\("radio_agent_assisted_fallback"/);
  assert.match(source, /catch\s*{\s*}\s*};/);
  assert.match(source, /logFallback:\s*logRadioAgentAssistedFallback/);
  assert.match(assistedQueueSource, /program_window_missing/);
  assert.match(assistedQueueSource, /program_executor_no_track/);
  assert.match(assistedQueueSource, /trace_save_failed/);
  assert.match(assistedQueueSource, /assisted_queue_failed/);
});

test("server reports exhausted playback recovery back to the radio agent", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)");
  const missingItem = source.indexOf("if (!item)", promoteNext);
  const recoveryEvent = source.indexOf('type: "playback_recovery_needed"', missingItem);
  const listenerError = source.indexOf('send({ type: "error"', missingItem);

  assert.ok(promoteNext >= 0);
  assert.ok(missingItem > promoteNext);
  assert.ok(recoveryEvent > missingItem);
  assert.ok(listenerError > recoveryEvent);
  assert.match(source.slice(recoveryEvent, listenerError), /reason:\s*"queue_empty_after_all_recovery"/);
  assert.match(source.slice(recoveryEvent, listenerError), /currentTrack:\s*currentTrack\s*\?\s*trackInfo\(currentTrack\)\s*:\s*null/);
});

test("server reports queue pressure when playback completion is mirrored to the radio agent", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const endedHandler = source.indexOf('if (type === "track_ended")');
  const completedEvent = source.indexOf('type: "track_completed"', endedHandler);
  const sendNext = source.indexOf('await sendPreparedNext("played")', completedEvent);

  assert.ok(endedHandler >= 0);
  assert.ok(completedEvent > endedHandler);
  assert.ok(sendNext > completedEvent);
  const completionMirror = source.slice(completedEvent, sendNext);
  assert.match(completionMirror, /readyQueue:\s*queue\.readyItems\(\)\.map\(\(readyItem\)\s*=>\s*trackInfo\(readyItem\.track\)\)/);
  assert.match(completionMirror, /readyQueueCount:\s*queue\.readyItems\(\)\.length/);
  assert.match(completionMirror, /queueLow:\s*queue\.readyItems\(\)\.length\s*===\s*0/);
});

test("server delivers safe radio agent host speech into the live DJ message channel", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");

  assert.match(source, /hostTextForRadioAgentDelivery/);
  assert.match(source, /const mirrorRadioAgentHostSpeech\s*=\s*\(/);
  assert.match(source, /radioAgent\.handle\(event\)\.then\(\(result\)/);
  assert.match(source, /hostTextForRadioAgentDelivery\(\{\s*eventType:\s*result\.event\.type,\s*decision:\s*result\.hostDecision,/s);
  assert.match(source, /synthesizeAndSendDjMessage\(text\)/);
});

test("server routes queue and recovery pressure through radio agent host speech", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNext = source.indexOf("const sendPreparedNext =");
  const queueLowEvent = source.indexOf('type: "queue_low"', sendPreparedNext);
  const recoveryEvent = source.indexOf('type: "playback_recovery_needed"', sendPreparedNext);

  assert.ok(sendPreparedNext >= 0);
  assert.ok(queueLowEvent > sendPreparedNext);
  assert.ok(recoveryEvent > queueLowEvent);
  assert.match(source.slice(queueLowEvent - 80, queueLowEvent), /mirrorRadioAgentHostSpeech\(\{\s*$/);
  assert.match(source.slice(recoveryEvent - 80, recoveryEvent), /mirrorRadioAgentHostSpeech\(\{\s*$/);
});

test("server gives assisted radio agent first chance to continue an empty queue", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNextStart = source.indexOf("const sendPreparedNext =");
  const sendPreparedNextEnd = source.indexOf('socket.on("message"', sendPreparedNextStart);
  const sendPreparedNextSource = source.slice(sendPreparedNextStart, sendPreparedNextEnd);
  const queueLowEvent = sendPreparedNextSource.indexOf('type: "queue_low"');
  const fillQueueCall = sendPreparedNextSource.indexOf("await fillQueue(1, false)", queueLowEvent);
  const legacyContinuation = sendPreparedNextSource.indexOf("kickBrainContinuation()", queueLowEvent);

  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(sendPreparedNextEnd > sendPreparedNextStart);
  assert.ok(queueLowEvent >= 0);
  assert.ok(fillQueueCall > queueLowEvent);
  assert.ok(legacyContinuation > fillQueueCall);
});

test("server waits for explicit user direction to refresh radio agent context before legacy request planning", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const userTextEvent = source.indexOf('type: "user_text"', songRequestHandler);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", userTextEvent);

  assert.ok(songRequestHandler >= 0);
  assert.ok(userTextEvent > songRequestHandler);
  assert.ok(legacyBrainRequest > userTextEvent);
  assert.match(source.slice(userTextEvent - 120, userTextEvent), /await\s+mirrorRadioAgentImmediate\(\{\s*$/);
});

test("server clears stale ready queue after explicit listener direction before planning replacement", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const agentRefresh = source.indexOf("await mirrorRadioAgentImmediate", songRequestHandler);
  const staleClear = source.indexOf("clearReadyQueueForExplicitDirection(requestText)", agentRefresh);
  const readyBeforeRequest = source.indexOf("const readyBeforeRequest = snapshotReadyItems(queue)", staleClear);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", readyBeforeRequest);

  assert.ok(songRequestHandler >= 0);
  assert.ok(agentRefresh > songRequestHandler);
  assert.ok(staleClear > agentRefresh);
  assert.ok(readyBeforeRequest > staleClear);
  assert.ok(legacyBrainRequest > readyBeforeRequest);
  assert.match(source, /const clearReadyQueueForExplicitDirection\s*=\s*\(requestText:\s*string\):\s*void\s*=>/);
  assert.match(source, /queue\.clearReady\(\)/);
});
