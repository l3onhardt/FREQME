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

test("server delegates the first playback attempt to RadioAgentService with durable avoids", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const handshake = source.indexOf('if (type === "handshake")');
  const startSession = source.indexOf("await radioBrain.startSession", handshake);
  const openingAttempt = source.indexOf("tryQueueRadioAgentOpeningTrack", handshake);
  const openingHelper = source.indexOf("const tryQueueRadioAgentOpeningTrack =");
  const serviceConstruction = source.indexOf("new RadioAgentService", openingHelper - 2500);
  const firstPromote = source.indexOf("const item = queue.promoteNext()", handshake);

  assert.match(source, /RadioAgentService/);
  assert.doesNotMatch(source, /import\s*\{\s*chooseOpeningTrack/);
  assert.doesNotMatch(source, /chooseOpeningTrack\(\{/);
  assert.match(source, /durableAvoidedArtists\(uid\)/);
  assert.ok(handshake >= 0);
  assert.ok(openingAttempt > handshake);
  assert.ok(startSession > openingAttempt);
  assert.ok(firstPromote > startSession);
  assert.ok(openingHelper >= 0);
  assert.ok(serviceConstruction >= 0);
  assert.ok(serviceConstruction < openingHelper);
  assert.match(source.slice(openingAttempt, startSession), /avoidArtists:\s*durableAvoidedArtists\(uid\)/);
  assert.match(source.slice(serviceConstruction, openingHelper), /new RadioAgentService/);
  assert.match(source.slice(openingHelper, openingAttempt), /radioAgentService\.startSession/);
  assert.match(source, /likedOpeningTracks/);
  assert.match(source.slice(openingAttempt, startSession), /likedTracks:\s*likedOpeningTracks\(\{\s*uid,\s*profile,\s*libraryTracks:\s*uid\s*\?\s*radioAgentStore\.libraryTracks\(uid,\s*5000\)\s*:\s*\[\],\s*\}\)/);
  assert.doesNotMatch(source.slice(openingAttempt, startSession), /likedTracks:\s*\[\]/);
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
  const sendPreparedNext = source.indexOf("const runSendPreparedNext =");
  const serviceRecovery = source.indexOf("await radioAgentService.handleTrackEnded", sendPreparedNext);
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)");
  const missingItem = source.indexOf("if (!item)", promoteNext);
  const fallbackAction = source.indexOf('trackEndResult.action === "legacy_fallback"', serviceRecovery);
  const fallbackLog = source.indexOf('store.logPlaybackEvent("radio_agent_track_end_fallback"', missingItem);
  const listenerError = source.indexOf('send({ type: "error"', missingItem);

  assert.ok(sendPreparedNext >= 0);
  assert.ok(serviceRecovery > sendPreparedNext);
  assert.ok(promoteNext >= 0);
  assert.ok(promoteNext > serviceRecovery);
  assert.ok(missingItem > promoteNext);
  assert.ok(fallbackAction > serviceRecovery);
  assert.ok(fallbackLog > missingItem);
  assert.ok(listenerError > fallbackLog);
  const recoveryBlock = source.slice(serviceRecovery, listenerError);
  assert.match(recoveryBlock, /currentTrack:\s*currentTrack\s*\?\s*trackInfo\(currentTrack\)\s*:\s*null/);
  assert.match(recoveryBlock, /readyQueue:\s*queue\.readyItems\(\)\.map\(\(readyItem\)\s*=>\s*trackInfo\(readyItem\.track\)\)/);
  assert.match(recoveryBlock, /fallbackReason/);
  assert.match(source.slice(promoteNext, missingItem), /queue\.promoteNext\(previousEvent\)/);
  assert.doesNotMatch(source.slice(missingItem, listenerError), /queue\.promoteNext\(previousEvent\)/);
  assert.match(source.slice(listenerError, listenerError + 220), /return;/);
  assert.doesNotMatch(recoveryBlock, /await\s+mirrorRadioAgentImmediate\(\{/);
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
  const serviceContinuation = source.indexOf("await radioAgentService.handleTrackEnded", sendPreparedNext);
  const recoveryText = source.indexOf("const recoveryText = trackEndResult.hostText", serviceContinuation);

  assert.ok(sendPreparedNext >= 0);
  assert.ok(serviceContinuation > sendPreparedNext);
  assert.ok(recoveryText > serviceContinuation);
  assert.match(source.slice(serviceContinuation, recoveryText), /previousEvent/);
  assert.match(source.slice(serviceContinuation, recoveryText), /readyQueue:\s*queue\.readyItems\(\)\.map\(\(readyItem\)\s*=>\s*trackInfo\(readyItem\.track\)\)/);
  assert.doesNotMatch(source.slice(sendPreparedNext, recoveryText), /mirrorRadioAgentHostSpeech\(\{\s*type:\s*"queue_low"/);
  assert.doesNotMatch(source.slice(sendPreparedNext, recoveryText), /await\s+mirrorRadioAgentImmediate\(\{\s*type:\s*"playback_recovery_needed"/);
});

test("server gives RadioAgentService first chance to continue an empty queue", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNextStart = source.indexOf("const sendPreparedNext =");
  const sendPreparedNextEnd = source.indexOf('socket.on("message"', sendPreparedNextStart);
  const sendPreparedNextSource = source.slice(sendPreparedNextStart, sendPreparedNextEnd);
  const serviceContinuation = sendPreparedNextSource.indexOf("const trackEndResult = await radioAgentService.handleTrackEnded");
  const fillQueueCall = sendPreparedNextSource.indexOf("await fillQueue(1, false)", serviceContinuation);
  const legacyContinuation = sendPreparedNextSource.indexOf("kickBrainContinuation()", serviceContinuation);

  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(sendPreparedNextEnd > sendPreparedNextStart);
  assert.ok(serviceContinuation >= 0);
  assert.ok(fillQueueCall > serviceContinuation);
  assert.ok(legacyContinuation > fillQueueCall);
  assert.doesNotMatch(sendPreparedNextSource, /const trackEndResult = !queue\.readyItems\(\)\.length/);
});

test("server continuation prompt is grounded in the active station contract", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const helper = source.indexOf("function continuationPromptFromContract");
  const kickContinuation = source.indexOf("const kickBrainContinuation =");
  const continuationPrompt = source.indexOf("const continuationPrompt = continuationPromptFromContract", kickContinuation);

  assert.ok(helper >= 0);
  assert.ok(kickContinuation >= 0);
  assert.ok(continuationPrompt > kickContinuation);
  assert.match(source.slice(kickContinuation, kickContinuation + 600), /handleUserText\(\{\s*\.\.\.brainArgs\(continuationPrompt\),\s*text:\s*continuationPrompt\s*\}\)/);
  assert.doesNotMatch(source.slice(kickContinuation, kickContinuation + 600), /继续保持这个感觉/);
  assert.match(source.slice(helper, kickContinuation), /Continue the active R&B station contract with vocals and groove forward/);
  assert.match(source.slice(helper, kickContinuation), /Continue the active station contract:/);
  assert.match(source.slice(helper, kickContinuation), /Continue the current personal radio direction with a coherent next track/);
});

test("server serializes next-track promotion requests", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const guardDeclaration = source.indexOf("let nextTrackTask: Promise<void> = Promise.resolve()");
  const wrapperStart = source.indexOf("const sendPreparedNext = async", guardDeclaration);
  const innerStart = source.indexOf("const runSendPreparedNext = async", wrapperStart);
  const endedHandler = source.indexOf('if (type === "track_ended")');
  const skipHandler = source.indexOf('if (type === "skip")');

  assert.ok(guardDeclaration >= 0);
  assert.ok(wrapperStart > guardDeclaration);
  assert.ok(innerStart > wrapperStart);
  assert.match(source.slice(wrapperStart, innerStart), /nextTrackTask\s*=\s*nextTrackTask\.then\(\s*\(\)\s*=>\s*runSendPreparedNext\(previousEvent,\s*options\)/);
  assert.match(source.slice(wrapperStart, innerStart), /return await nextTrackTask/);
  assert.match(source.slice(endedHandler, skipHandler), /await sendPreparedNext\("played"\)/);
  assert.match(source.slice(skipHandler, skipHandler + 1200), /await sendPreparedNext\("skipped"\)/);
});

test("server executes explicit user direction with radio agent program window before legacy request planning", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const agentResultDeclaration = source.indexOf("const agentTextResult =", songRequestHandler);
  const serviceDirection = source.indexOf("await radioAgentService.handleUserText", songRequestHandler);
  const agentAcknowledgement = source.indexOf("const agentAckText = agentTextResult.hostText", serviceDirection);
  const agentProgramQueue = source.indexOf("agentTextResult.programQueued", agentAcknowledgement);
  const preparedFallbackQueue = source.indexOf("queue.addReady(agentTextResult.preparedTrack.track", agentProgramQueue);
  const agentAckSpeech = source.indexOf("synthesizeAndSendDjMessage(agentAckText)", agentProgramQueue);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", serviceDirection);

  assert.ok(songRequestHandler >= 0);
  assert.ok(agentResultDeclaration > songRequestHandler);
  assert.ok(agentResultDeclaration < serviceDirection);
  assert.ok(serviceDirection > songRequestHandler);
  assert.ok(agentAcknowledgement > serviceDirection);
  assert.ok(agentAcknowledgement < agentProgramQueue);
  assert.ok(agentProgramQueue > serviceDirection);
  assert.ok(agentAckSpeech > agentProgramQueue);
  assert.ok(agentAckSpeech < legacyBrainRequest);
  assert.ok(legacyBrainRequest > agentProgramQueue);
  assert.match(source.slice(agentResultDeclaration, serviceDirection), /const\s+agentTextResult\s*=/);
  assert.match(source.slice(serviceDirection, agentAcknowledgement), /currentTrack:\s*currentTrack\s*\?\s*trackInfo\(currentTrack\)\s*:\s*null/);
  assert.match(source.slice(serviceDirection, agentAcknowledgement), /readyQueue:\s*queue\.readyItems\(\)\.map\(\(readyItem\)\s*=>\s*trackInfo\(readyItem\.track\)\)/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /agentTextResult\.programQueued/);
  assert.match(source.slice(serviceDirection, agentProgramQueue), /const\s+agentProgramWindow\s*=\s*agentTextResult\.programWindow/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /agentProgramWindow\.stationBrief/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /agentTextResult\.preparedTrack/);
  assert.ok(preparedFallbackQueue > agentProgramQueue);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /synthesizeAndSendDjMessage\(agentAckText\)/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /sendPreparedNext\("played",\s*\{\s*allowContinuation:\s*false,\s*skipPrewarmWait:\s*true\s*\}\)/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /return;/);
  assert.doesNotMatch(source.slice(songRequestHandler, legacyBrainRequest), /await\s+mirrorRadioAgentImmediate\(\{/);
});

test("server clears stale ready queue after explicit listener direction before planning replacement", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const intentDecision = source.indexOf("requestIntent = intentRouter.classify(requestText)", songRequestHandler);
  const serviceDirection = source.indexOf("await radioAgentService.handleUserText", songRequestHandler);
  const clearDecision = source.indexOf("shouldClearQueue:", serviceDirection);
  const readyBeforeRequest = source.indexOf("const readyBeforeRequest = snapshotReadyItems(queue)", clearDecision);
  const agentProgramQueue = source.indexOf("agentTextResult.programQueued", readyBeforeRequest);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", readyBeforeRequest);

  assert.ok(songRequestHandler >= 0);
  assert.ok(intentDecision > songRequestHandler);
  assert.ok(serviceDirection > songRequestHandler);
  assert.ok(clearDecision > serviceDirection);
  assert.ok(readyBeforeRequest > clearDecision);
  assert.ok(agentProgramQueue > readyBeforeRequest);
  assert.ok(legacyBrainRequest > agentProgramQueue);
  assert.match(source.slice(clearDecision, readyBeforeRequest), /requestIntent\?\.shouldClearQueue\s*&&\s*!requestIntent\.shouldExplain/);
  assert.doesNotMatch(source.slice(serviceDirection, readyBeforeRequest), /agentTextResult\.shouldClearQueue\)\s*queue\.clearReady/);
});

test("server delegates explicit correction requests to the radio agent correction API", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const intentDeclaration = source.indexOf("let requestIntent:", songRequestHandler);
  const intentDecision = source.indexOf("requestIntent = intentRouter.classify(requestText)", intentDeclaration);
  const correctionBranch = source.indexOf("requestIntent?.type === \"correction\"", intentDecision);
  const serviceCorrection = source.indexOf("await radioAgentService.handleCorrection", correctionBranch);
  const serviceDirection = source.indexOf("await radioAgentService.handleUserText", serviceCorrection);
  const agentAcknowledgement = source.indexOf("const agentAckText = agentTextResult.hostText", serviceCorrection);

  assert.ok(songRequestHandler >= 0);
  assert.ok(intentDecision > songRequestHandler);
  assert.ok(correctionBranch > intentDecision);
  assert.ok(serviceCorrection > correctionBranch);
  assert.ok(serviceDirection > serviceCorrection);
  assert.ok(agentAcknowledgement > serviceDirection);
  assert.match(source.slice(correctionBranch, serviceDirection), /requestIntent\?\.type\s*===\s*"negative_feedback"/);
  assert.match(source.slice(serviceCorrection, serviceDirection), /currentTrack:\s*currentTrack\s*\?\s*trackInfo\(currentTrack\)\s*:\s*null/);
  assert.match(source.slice(serviceCorrection, serviceDirection), /readyQueue:\s*queue\.readyItems\(\)\.map\(\(readyItem\)\s*=>\s*trackInfo\(readyItem\.track\)\)/);
  assert.match(source.slice(serviceCorrection, serviceDirection), /\}\)\s*:\s*$/);
});

test("server injects radio agent runtime, executor, and host policy into RadioAgentService", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const serviceConstruction = source.indexOf("const radioAgentService = new RadioAgentService");
  const serviceEnd = source.indexOf("});", serviceConstruction);
  const serviceSource = source.slice(serviceConstruction, serviceEnd);

  assert.ok(serviceConstruction >= 0);
  assert.ok(serviceEnd > serviceConstruction);
  assert.match(serviceSource, /handleRadioAgentEvent:\s*mirrorRadioAgentImmediate/);
  assert.match(serviceSource, /clearReadyQueue:\s*\(\)\s*=>\s*queue\.clearReady\(\)/);
  assert.match(serviceSource, /queueProgramWindow:\s*queueRadioAgentWindow/);
  assert.match(serviceSource, /prepareProgramWindow:\s*\(programWindow\)\s*=>\s*radioAgentProgramExecutor\.prepareFirstPlayable\(programWindow\)/);
  assert.match(serviceSource, /hostTextForDelivery:\s*hostTextForRadioAgentDelivery/);
});
