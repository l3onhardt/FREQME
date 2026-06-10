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

test("server passes the active station contract into degraded scheduler fallback", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const schedulerConstruction = source.indexOf("new StreamScheduler(netease, store, audioResolver, boundaryGuard)");
  const degradedFallback = source.indexOf('store.logPlaybackEvent("ai_station_degraded_fallback"');
  const schedulerPick = source.indexOf("scheduler.pickNext", degradedFallback);

  assert.ok(schedulerConstruction >= 0);
  assert.ok(degradedFallback >= 0);
  assert.ok(schedulerPick > degradedFallback);
  assert.match(source.slice(schedulerPick, schedulerPick + 450), /stationContract:\s*schedulerStationContract\(uid,\s*sessionId\)/);
  assert.match(source, /function schedulerStationContract\(uid:\s*string\s*\|\s*null,\s*sessionId:\s*number\s*\|\s*null\):\s*StationContract\s*\|\s*null/);
  assert.match(source, /radioAgentStore\.artifact\(uid,\s*"program_contract\.md"\)/);
});

test("server parses generic radio agent program contracts for scheduler fallback", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const parserStart = source.indexOf("function stationContractFromAgentArtifact");
  const parserEnd = source.indexOf("function isStationContract", parserStart);
  const parserSource = source.slice(parserStart, parserEnd);

  assert.ok(parserStart >= 0);
  assert.ok(parserEnd > parserStart);
  assert.doesNotMatch(parserSource, /isRnbContractText/);
  assert.match(parserSource, /positiveSeeds:\s*\[stationGoal\]/);
  assert.match(parserSource, /negativeConstraints:\s*blocked/);
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

test("server gives the radio agent a final recovery window before reporting playback exhaustion", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)");
  const missingItem = source.indexOf("if (!item)", promoteNext);
  const agentRecoveryResult = source.indexOf("const agentRecoveryResult = await mirrorRadioAgentImmediate", missingItem);
  const recoveryEvent = source.indexOf('type: "playback_recovery_needed"', agentRecoveryResult);
  const agentRecoveryQueue = source.indexOf("queueRadioAgentWindow(agentRecoveryResult.programWindow)", agentRecoveryResult);
  const recoveredItem = source.indexOf("const recoveredItem = queue.promoteNext(previousEvent)", agentRecoveryQueue);
  const listenerError = source.indexOf('send({ type: "error"', missingItem);

  assert.ok(promoteNext >= 0);
  assert.ok(missingItem > promoteNext);
  assert.ok(agentRecoveryResult > missingItem);
  assert.ok(recoveryEvent > agentRecoveryResult);
  assert.ok(agentRecoveryQueue > agentRecoveryResult);
  assert.ok(recoveredItem > agentRecoveryQueue);
  assert.ok(listenerError > recoveredItem);
  const recoveryBlock = source.slice(recoveryEvent, listenerError);
  assert.match(recoveryBlock, /reason:\s*"queue_empty_after_all_recovery"/);
  assert.match(recoveryBlock, /currentTrack:\s*currentTrack\s*\?\s*trackInfo\(currentTrack\)\s*:\s*null/);
  assert.match(recoveryBlock, /sendTrack\(recoveredItem\.track,\s*recoveredItem\.url\)/);
  assert.match(recoveryBlock, /return;/);
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

test("server routes queue pressure through host speech and recovery pressure through executable agent recovery", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNext = source.indexOf("const sendPreparedNext =");
  const queueLowEvent = source.indexOf('type: "queue_low"', sendPreparedNext);
  const agentRecoveryResult = source.indexOf("const agentRecoveryResult = await mirrorRadioAgentImmediate", queueLowEvent);
  const recoveryEvent = source.indexOf('type: "playback_recovery_needed"', agentRecoveryResult);
  const recoveryText = source.indexOf("const recoveryText = agentRecoveryResult", recoveryEvent);

  assert.ok(sendPreparedNext >= 0);
  assert.ok(queueLowEvent > sendPreparedNext);
  assert.ok(agentRecoveryResult > queueLowEvent);
  assert.ok(recoveryEvent > agentRecoveryResult);
  assert.ok(recoveryText > recoveryEvent);
  assert.match(source.slice(queueLowEvent - 80, queueLowEvent), /mirrorRadioAgentHostSpeech\(\{\s*$/);
  assert.match(source.slice(agentRecoveryResult, recoveryText), /queueRadioAgentWindow\(agentRecoveryResult\.programWindow\)/);
  assert.match(source.slice(recoveryText, recoveryText + 260), /hostTextForRadioAgentDelivery/);
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

test("server executes explicit user direction with radio agent program window before legacy request planning", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const userTextEvent = source.indexOf('type: "user_text"', songRequestHandler);
  const agentAcknowledgement = source.indexOf("hostTextForRadioAgentDelivery", userTextEvent);
  const agentProgramQueue = source.indexOf("queueRadioAgentWindow(agentTextResult.programWindow)", userTextEvent);
  const agentAckSpeech = source.indexOf("synthesizeAndSendDjMessage(agentAckText)", agentProgramQueue);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", userTextEvent);

  assert.ok(songRequestHandler >= 0);
  assert.ok(userTextEvent > songRequestHandler);
  assert.ok(agentAcknowledgement > userTextEvent);
  assert.ok(agentAcknowledgement < agentProgramQueue);
  assert.ok(agentProgramQueue > userTextEvent);
  assert.ok(agentAckSpeech > agentProgramQueue);
  assert.ok(agentAckSpeech < legacyBrainRequest);
  assert.ok(legacyBrainRequest > agentProgramQueue);
  assert.match(source.slice(userTextEvent - 120, userTextEvent), /await\s+mirrorRadioAgentImmediate\(\{\s*$/);
  assert.match(source.slice(userTextEvent - 120, userTextEvent), /const\s+agentTextResult\s*=/);
  assert.match(source.slice(agentAcknowledgement, agentProgramQueue), /eventType:\s*agentTextResult\.event\.type/);
  assert.match(source.slice(agentAcknowledgement, agentProgramQueue), /decision:\s*agentTextResult\.hostDecision/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /synthesizeAndSendDjMessage\(agentAckText\)/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /agentTextResult\.programWindow/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /sendPreparedNext\("played",\s*\{\s*allowContinuation:\s*false,\s*skipPrewarmWait:\s*true\s*\}\)/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /return;/);
});

test("server clears stale ready queue after explicit listener direction before planning replacement", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const agentRefresh = source.indexOf("await mirrorRadioAgentImmediate", songRequestHandler);
  const staleClear = source.indexOf("clearReadyQueueForExplicitDirection(requestText)", agentRefresh);
  const readyBeforeRequest = source.indexOf("const readyBeforeRequest = snapshotReadyItems(queue)", staleClear);
  const agentProgramQueue = source.indexOf("queueRadioAgentWindow(agentTextResult.programWindow)", readyBeforeRequest);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", readyBeforeRequest);

  assert.ok(songRequestHandler >= 0);
  assert.ok(agentRefresh > songRequestHandler);
  assert.ok(staleClear > agentRefresh);
  assert.ok(readyBeforeRequest > staleClear);
  assert.ok(agentProgramQueue > readyBeforeRequest);
  assert.ok(legacyBrainRequest > agentProgramQueue);
  assert.match(source, /const clearReadyQueueForExplicitDirection\s*=\s*\(requestText:\s*string\):\s*void\s*=>/);
  assert.match(source, /queue\.clearReady\(\)/);
});
