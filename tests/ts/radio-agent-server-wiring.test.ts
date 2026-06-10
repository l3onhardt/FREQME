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
