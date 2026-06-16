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

test("server executes approved radio agent actions through the action runner boundary", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  assert.match(source, /runRadioAgentActions/);
  assert.match(source, /const executeRadioAgentActions\s*=/);
  assert.match(source, /executeRadioAgentActions\(result\.actions\)/);
  assert.match(source, /executeRadioAgentActions\(agentTextResult\.actions\)/);
});

test("server does not duplicate direct prepared-track queueing after executing agent actions", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const actionExecution = source.indexOf("executeRadioAgentActions(agentTextResult.actions)", songRequestHandler);
  const legacyPreparedQueue = source.indexOf("queue.addReady(agentTextResult.preparedTrack.track", actionExecution);

  assert.ok(songRequestHandler >= 0);
  assert.ok(actionExecution > songRequestHandler);
  assert.equal(legacyPreparedQueue, -1);
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
  assert.match(source.slice(schedulerPick, schedulerPick + 450), /stationContract:\s*currentStationContract\(\)/);
  assert.match(source, /const currentStationContract\s*=\s*\(\):\s*StationContract\s*\|\s*null\s*=>\s*[\s\S]*activeAgentStationContract\s*\|\|\s*schedulerStationContract\(uid,\s*sessionId\)/);
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

test("server gives track-end playback a bounded no-stall recovery path before reporting exhaustion", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNext = source.indexOf("const runSendPreparedNext =");
  const serviceRecovery = source.indexOf("await radioAgentService.handleTrackEnded", sendPreparedNext);
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)");
  const missingItem = source.indexOf("if (!item)", promoteNext);
  const recoveryBoundary = source.indexOf("await ensureTrackEndReadyItem", serviceRecovery);
  const fallbackLog = source.indexOf('store.logPlaybackEvent("radio_agent_track_end_fallback"', missingItem);
  const listenerError = source.indexOf('send({ type: "error"', missingItem);

  assert.ok(sendPreparedNext >= 0);
  assert.ok(serviceRecovery > sendPreparedNext);
  assert.ok(promoteNext >= 0);
  assert.ok(recoveryBoundary > serviceRecovery);
  assert.ok(promoteNext > recoveryBoundary);
  assert.ok(missingItem > promoteNext);
  assert.ok(fallbackLog > missingItem);
  assert.ok(listenerError > fallbackLog);
  const recoveryBlock = source.slice(serviceRecovery, listenerError);
  assert.match(recoveryBlock, /currentTrack:\s*currentTrack\s*\?\s*trackInfo\(currentTrack\)\s*:\s*null/);
  assert.match(recoveryBlock, /readyQueue:\s*queue\.readyItems\(\)\.map\(\(readyItem\)\s*=>\s*trackInfo\(readyItem\.track\)\)/);
  assert.match(recoveryBlock, /fallbackReason/);
  assert.match(recoveryBlock, /ensureTrackEndReadyItem/);
  assert.match(recoveryBlock, /fillLegacyQueue:\s*\(\)\s*=>\s*fillQueue\(1,\s*false\)/);
  assert.match(recoveryBlock, /addRecentPlayableFallback/);
  assert.match(recoveryBlock, /recoverySource:\s*recovery\.source/);
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
  assert.match(source, /mirrorSocketRadioAgentImmediate\(event\)\.then\(\(result\)/);
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
  const recoveryBoundary = sendPreparedNextSource.indexOf("await ensureTrackEndReadyItem", serviceContinuation);
  const fillQueueCall = sendPreparedNextSource.indexOf("fillLegacyQueue: () => fillQueue(1, false)", recoveryBoundary);
  const recentFallback = sendPreparedNextSource.indexOf("addRecentPlayableFallback", recoveryBoundary);
  const legacyContinuation = sendPreparedNextSource.indexOf("kickBrainContinuation", recoveryBoundary);

  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(sendPreparedNextEnd > sendPreparedNextStart);
  assert.ok(serviceContinuation >= 0);
  assert.ok(recoveryBoundary > serviceContinuation);
  assert.ok(fillQueueCall > recoveryBoundary);
  assert.ok(recentFallback > recoveryBoundary);
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

test("server blocks stale queued next-track promotions once a listener request is active", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNextStart = source.indexOf("const sendPreparedNext = async");
  const runSendPreparedNextStart = source.indexOf("const runSendPreparedNext = async", sendPreparedNextStart);
  const socketHandler = source.indexOf('socket.on("message"', runSendPreparedNextStart);
  const sendPreparedNextSource = source.slice(sendPreparedNextStart, socketHandler);
  const promotionStart = sendPreparedNextSource.indexOf("const item = queue.promoteNext(previousEvent)");
  const requestPromotion = source.indexOf("sendPreparedNext(\"played\", { allowContinuation: false, skipPrewarmWait: true", socketHandler);

  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(runSendPreparedNextStart > sendPreparedNextStart);
  assert.ok(socketHandler > runSendPreparedNextStart);
  assert.ok(promotionStart > 0);
  assert.ok(requestPromotion > socketHandler);
  assert.match(sendPreparedNextSource, /requestToken\?:\s*number/);
  assert.match(sendPreparedNextSource.slice(0, promotionStart), /options\.requestToken\s*==\s*null\s*&&\s*activeRequestToken\s*!=\s*null/);
  assert.match(sendPreparedNextSource.slice(0, promotionStart), /options\.requestToken\s*!=\s*null\s*&&\s*!isCurrentRequestToken\(activeRequestToken,\s*options\.requestToken\)/);
  assert.match(source.slice(requestPromotion, requestPromotion + 180), /requestToken/);
});

test("server executes explicit user direction with radio agent program window before legacy request planning", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const agentResultDeclaration = source.indexOf("const agentTextResult =", songRequestHandler);
  const serviceDirection = source.indexOf("radioAgentService.handleUserText", songRequestHandler);
  const agentAcknowledgement = source.indexOf("const agentAckText = agentTextResult.hostText", serviceDirection);
  const actionExecution = source.indexOf("executeRadioAgentActions(agentTextResult.actions)", agentAcknowledgement);
  const agentProgramQueue = source.indexOf("agentTextResult.programQueued", actionExecution);
  const agentAckSpeech = source.indexOf("synthesizeAndSendDjMessage(agentAckText)", actionExecution);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", serviceDirection);

  assert.ok(songRequestHandler >= 0);
  assert.ok(agentResultDeclaration > songRequestHandler);
  assert.ok(agentResultDeclaration < serviceDirection);
  assert.ok(serviceDirection > songRequestHandler);
  assert.ok(agentAcknowledgement > serviceDirection);
  assert.ok(agentAcknowledgement < agentProgramQueue);
  assert.ok(actionExecution > agentAcknowledgement);
  assert.ok(actionExecution < agentProgramQueue);
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
  assert.doesNotMatch(source.slice(actionExecution, legacyBrainRequest), /queue\.addReady\(agentTextResult\.preparedTrack\.track/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /synthesizeAndSendDjMessage\(agentAckText\)/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /sendPreparedNext\("played",\s*\{\s*allowContinuation:\s*false,\s*skipPrewarmWait:\s*true,\s*requestToken\s*\}\)/);
  assert.match(source.slice(agentProgramQueue, legacyBrainRequest), /return;/);
  assert.doesNotMatch(source.slice(songRequestHandler, legacyBrainRequest), /await\s+mirrorRadioAgentImmediate\(\{/);
});

test("server acknowledges song requests before waiting on radio agent planning", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const requestText = source.indexOf("const requestText = compactText", songRequestHandler);
  const immediatePlanning = source.indexOf('status: "planning"', requestText);
  const serviceCorrection = source.indexOf("radioAgentService.handleCorrection", requestText);
  const serviceDirection = source.indexOf("radioAgentService.handleUserText", requestText);
  const firstAgentService = Math.min(serviceCorrection, serviceDirection);

  assert.ok(songRequestHandler >= 0);
  assert.ok(requestText > songRequestHandler);
  assert.ok(immediatePlanning > requestText);
  assert.ok(firstAgentService > immediatePlanning);
  assert.match(source.slice(immediatePlanning - 80, immediatePlanning + 220), /send\(\{\s*type:\s*"request_status",\s*status:\s*"planning"/);
  assert.match(source.slice(immediatePlanning - 80, immediatePlanning + 220), /我先按这个方向找一首稳的/);
});

test("server cancels delayed generated intros as soon as a song request starts", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const requestText = source.indexOf("const requestText = compactText", songRequestHandler);
  const immediatePlanning = source.indexOf('status: "planning"', requestText);
  const cancelIntro = source.indexOf("introSendCancelled = true", requestText);
  const agentTimeout = source.indexOf("withUserRequestAgentTimeout(", immediatePlanning);
  const logRequest = source.indexOf('store.logPlaybackEvent("song_request"', immediatePlanning);

  assert.ok(songRequestHandler >= 0);
  assert.ok(requestText > songRequestHandler);
  assert.ok(immediatePlanning > requestText);
  assert.ok(cancelIntro > requestText);
  assert.ok(cancelIntro < immediatePlanning);
  assert.ok(cancelIntro < agentTimeout);
  assert.ok(logRequest > agentTimeout);
});

test("server skips the long legacy brain wait after radio agent request queue timeout", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const fallbackReasonCheck = source.indexOf("agentTextResult.fallbackReason", songRequestHandler);
  const stationFallback = source.indexOf("runStationDirectorRequestFallback", fallbackReasonCheck);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", songRequestHandler);

  assert.ok(songRequestHandler >= 0);
  assert.ok(fallbackReasonCheck > songRequestHandler);
  assert.ok(stationFallback > fallbackReasonCheck);
  assert.ok(legacyBrainRequest > stationFallback);
  assert.match(source.slice(fallbackReasonCheck, legacyBrainRequest), /agentTextResult\.fallbackReason/);
  assert.match(source.slice(fallbackReasonCheck, legacyBrainRequest), /radio_agent_user_text_timeout/);
  assert.match(source.slice(fallbackReasonCheck, legacyBrainRequest), /radio_agent_user_text_queue_timeout/);
  assert.match(source.slice(fallbackReasonCheck, legacyBrainRequest), /return;/);
});

test("server clears active request token after the whole radio agent request times out", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const timeoutBranch = source.indexOf('if (!("hostText" in agentTextResult))', songRequestHandler);
  const stationFallback = source.indexOf("await runStationDirectorRequestFallback", timeoutBranch);
  const clearToken = source.indexOf("activeRequestToken = null", stationFallback);
  const returnAfterFallback = source.indexOf("return;", stationFallback);

  assert.ok(songRequestHandler >= 0);
  assert.ok(timeoutBranch > songRequestHandler);
  assert.ok(stationFallback > timeoutBranch);
  assert.ok(clearToken > stationFallback);
  assert.ok(clearToken < returnAfterFallback);
  assert.match(source.slice(timeoutBranch, returnAfterFallback), /isCurrentRequestToken\(activeRequestToken,\s*requestToken\)/);
});

test("server clears active request token after an agent request track starts", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const readyBranch = source.indexOf("if (ready)", songRequestHandler);
  const requestPromotion = source.indexOf('await sendPreparedNext("played", { allowContinuation: false, skipPrewarmWait: true, requestToken })', readyBranch);
  const returnAfterPromotion = source.indexOf("return;", requestPromotion);

  assert.ok(songRequestHandler >= 0);
  assert.ok(readyBranch > songRequestHandler);
  assert.ok(requestPromotion > readyBranch);
  assert.ok(returnAfterPromotion > requestPromotion);
  assert.match(source.slice(requestPromotion, returnAfterPromotion), /isCurrentRequestToken\(activeRequestToken,\s*requestToken\)/);
  assert.match(source.slice(requestPromotion, returnAfterPromotion), /activeRequestToken\s*=\s*null/);
});

test("server bounds the whole radio agent request attempt and guards late queue mutations", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const helper = source.indexOf("const withUserRequestAgentTimeout =");
  const expiredTokens = source.indexOf("expiredRequestTokens");
  const queueAdapter = source.indexOf("const queueRadioAgentWindow =");
  const guardedQueue = source.indexOf("guardedQueue", queueAdapter);
  const serviceDirection = source.indexOf("withUserRequestAgentTimeout(", songRequestHandler);

  assert.ok(expiredTokens >= 0);
  assert.ok(helper >= 0);
  assert.ok(queueAdapter >= 0);
  assert.ok(guardedQueue > queueAdapter);
  assert.ok(serviceDirection > songRequestHandler);
  assert.match(source.slice(helper, queueAdapter), /radio_agent_user_text_timeout/);
  assert.match(source.slice(helper, queueAdapter), /markRequestTokenExpired/);
  assert.match(source.slice(queueAdapter, queueAdapter + 1200), /isRequestTokenExpired/);
  assert.match(source.slice(queueAdapter, queueAdapter + 1200), /throw new Error\("radio_agent_request_token_expired"\)/);
  assert.match(source.slice(queueAdapter, queueAdapter + 1200), /isCurrentRequestToken\(activeRequestToken,\s*requestTokenAtStart\)/);
});

test("server gives request fallback planning a bounded listener-visible outcome", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const fallbackTimeoutHelper = source.indexOf("const withUserRequestFallbackTimeout =");
  const fallbackFunction = source.indexOf("const runStationDirectorRequestFallback =");
  const stationFallbackCall = source.indexOf("withUserRequestFallbackTimeout(", fallbackFunction);
  const stationDirectorCall = source.indexOf("stationDirector.handleUserRequest", stationFallbackCall);
  const timeoutBranch = source.indexOf('station_director_request_timeout"', stationDirectorCall);
  const timeoutStatus = source.indexOf('status: "not_found"', timeoutBranch);

  assert.ok(fallbackTimeoutHelper >= 0);
  assert.ok(fallbackFunction >= 0);
  assert.ok(stationFallbackCall > fallbackFunction);
  assert.ok(stationDirectorCall > stationFallbackCall);
  assert.ok(timeoutBranch > stationDirectorCall);
  assert.ok(timeoutStatus > timeoutBranch);
  assert.match(source.slice(fallbackTimeoutHelper, fallbackFunction), /station_director_request_timeout/);
  assert.match(source.slice(fallbackFunction, timeoutStatus + 220), /store\.logPlaybackEvent\("radio_agent_request_fallback_timeout"/);
  assert.match(source.slice(timeoutBranch, timeoutStatus + 220), /send\(\{\s*type:\s*"request_status",\s*status:\s*"not_found"/);
});

test("server asks the radio agent service to clear stale ready queue for non-explanation listener directions", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const intentDecision = source.indexOf("requestIntent = intentRouter.classify(requestText)", songRequestHandler);
  const requestToken = source.indexOf("const requestToken = ++nextRequestToken", songRequestHandler);
  const activeToken = source.indexOf("activeRequestToken = requestToken", requestToken);
  const readyBeforeRequest = source.indexOf("const readyBeforeRequest = snapshotReadyItems(queue)", activeToken);
  const serviceDirection = source.indexOf("radioAgentService.handleUserText", songRequestHandler);
  const clearDecision = source.indexOf("shouldClearQueue:", serviceDirection);
  const postAgentTokenCheck = source.indexOf("isCurrentRequestToken(activeRequestToken, requestToken)", serviceDirection);
  const agentProgramQueue = source.indexOf("agentTextResult.programQueued", readyBeforeRequest);
  const legacyBrainRequest = source.indexOf("radioBrain.handleUserText", readyBeforeRequest);

  assert.ok(songRequestHandler >= 0);
  assert.ok(intentDecision > songRequestHandler);
  assert.ok(requestToken > songRequestHandler);
  assert.ok(activeToken > requestToken);
  assert.ok(readyBeforeRequest > activeToken);
  assert.ok(serviceDirection > readyBeforeRequest);
  assert.ok(serviceDirection > songRequestHandler);
  assert.ok(clearDecision > serviceDirection);
  assert.ok(postAgentTokenCheck > serviceDirection);
  assert.ok(agentProgramQueue > readyBeforeRequest);
  assert.ok(legacyBrainRequest > agentProgramQueue);
  assert.match(source.slice(serviceDirection, clearDecision + 180), /shouldClearQueue:\s*!\s*requestIntent\?\.shouldExplain/);
  assert.doesNotMatch(source.slice(serviceDirection, postAgentTokenCheck), /agentTextResult\.shouldClearQueue\)\s*queue\.clearReady/);
});

test("server lets radio agent program requests clear stale ready queue for any non-explanation direction", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const serviceDirection = source.indexOf("radioAgentService.handleUserText", songRequestHandler);
  const clearArgument = source.indexOf("shouldClearQueue:", serviceDirection);
  const serviceDirectionEnd = source.indexOf("}),", clearArgument);

  assert.ok(songRequestHandler >= 0);
  assert.ok(serviceDirection > songRequestHandler);
  assert.ok(clearArgument > serviceDirection);
  assert.match(source.slice(clearArgument, serviceDirectionEnd), /!\s*requestIntent\?\.shouldExplain/);
  assert.doesNotMatch(source.slice(clearArgument, serviceDirectionEnd), /requestIntent\?\.shouldClearQueue\s*&&/);
});

test("server keeps the latest radio agent program window as a session-local station contract", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const socketStart = source.indexOf("async function handleRadioSocket");
  const socketEnd = source.indexOf('socket.on("close"', socketStart);
  const socketSource = source.slice(socketStart, socketEnd);
  const declaration = socketSource.indexOf("let activeAgentStationContract");
  const helper = socketSource.indexOf("const rememberAgentProgramWindowContract");
  const queueWindow = socketSource.indexOf("const queueRadioAgentWindow");
  const helperCallInQueue = socketSource.indexOf("rememberAgentProgramWindowContract(programWindow)", queueWindow);
  const songRequestHandler = socketSource.indexOf('if (type === "song_request")');
  const agentProgramWindow = socketSource.indexOf("const agentProgramWindow = agentTextResult.programWindow", songRequestHandler);
  const helperCallInRequest = socketSource.indexOf("rememberAgentProgramWindowContract(agentProgramWindow)", agentProgramWindow);

  assert.ok(socketStart >= 0);
  assert.ok(socketEnd > socketStart);
  assert.ok(declaration >= 0);
  assert.ok(helper > declaration);
  assert.ok(queueWindow > helper);
  assert.ok(helperCallInQueue > queueWindow);
  assert.ok(songRequestHandler > queueWindow);
  assert.ok(agentProgramWindow > songRequestHandler);
  assert.ok(helperCallInRequest > agentProgramWindow);
  assert.match(socketSource.slice(helper, queueWindow), /stationContractFromAgentProgramWindow\(programWindow\)/);
});

test("server passes the session-local radio agent contract into scheduler and track-end recovery", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const socketStart = source.indexOf("async function handleRadioSocket");
  const socketEnd = source.indexOf('socket.on("close"', socketStart);
  const socketSource = source.slice(socketStart, socketEnd);
  const fillQueueStart = socketSource.indexOf("const fillQueue =");
  const schedulerPick = socketSource.indexOf("scheduler.pickNext", fillQueueStart);
  const recentFallback = socketSource.indexOf("const addRecentPlayableFallback =");
  const recentPrepare = socketSource.indexOf("scheduler.prepareTrack(track, uid)", recentFallback);
  const recoveryCall = socketSource.indexOf("await ensureTrackEndReadyItem");

  assert.ok(fillQueueStart >= 0);
  assert.ok(schedulerPick > fillQueueStart);
  assert.ok(recentFallback > schedulerPick);
  assert.ok(recentPrepare > recentFallback);
  assert.ok(recoveryCall > recentFallback);
  assert.match(socketSource.slice(schedulerPick, schedulerPick + 520), /stationContract:\s*currentStationContract\(\)/);
  assert.match(socketSource.slice(recentFallback, recentPrepare), /boundaryGuard\.evaluate\(\{/);
  assert.match(socketSource.slice(recentFallback, recentPrepare), /contract:\s*currentStationContract\(\)/);
  assert.match(socketSource.slice(recoveryCall, recoveryCall + 900), /hasActiveStationContract:\s*Boolean\(currentStationContract\(\)\)/);
});

test("server injects the session-local station contract into radio agent runtime events", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const socketStart = source.indexOf("async function handleRadioSocket");
  const socketEnd = source.indexOf('socket.on("close"', socketStart);
  const socketSource = source.slice(socketStart, socketEnd);
  const helper = socketSource.indexOf("const radioAgentEventWithCurrentContract");
  const localMirror = socketSource.indexOf("const mirrorSocketRadioAgentImmediate");
  const serviceConstruction = socketSource.indexOf("const radioAgentService = new RadioAgentService");
  const serviceEnd = socketSource.indexOf("});", serviceConstruction);

  assert.ok(socketStart >= 0);
  assert.ok(socketEnd > socketStart);
  assert.ok(helper >= 0);
  assert.ok(localMirror > helper);
  assert.ok(serviceConstruction > localMirror);
  assert.match(socketSource.slice(helper, localMirror), /const\s+programContract\s*=\s*programContractMarkdownFromStationContract\(currentStationContract\(\)\)/);
  assert.match(socketSource.slice(helper, localMirror), /programContract,/);
  assert.match(socketSource.slice(localMirror, serviceConstruction), /mirrorRadioAgentImmediate\(radioAgentEventWithCurrentContract\(event\)\)/);
  assert.match(socketSource.slice(localMirror, serviceConstruction), /const socketRadioAgent\s*=\s*\{/);
  assert.match(socketSource.slice(localMirror, serviceConstruction), /const result = await mirrorSocketRadioAgentImmediate\(event\)/);
  assert.match(socketSource.slice(localMirror, serviceConstruction), /throw new Error\("radio_agent_event_failed"\)/);
  assert.match(socketSource.slice(serviceConstruction, serviceEnd), /handleRadioAgentEvent:\s*mirrorSocketRadioAgentImmediate/);
  assert.match(socketSource, /radioAgent:\s*socketRadioAgent/);
  assert.doesNotMatch(socketSource, /radioAgent:\s*radioAgent,/);
  assert.doesNotMatch(socketSource.slice(serviceConstruction, serviceEnd), /handleRadioAgentEvent:\s*mirrorRadioAgentImmediate/);
  assert.match(source, /function programContractMarkdownFromStationContract\(contract:\s*StationContract\s*\|\s*null\):\s*string/);
});

test("server filters stale ready items against the active agent contract before promotion", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const importLine = source.indexOf("removeReadyItemsOutsideStationContract");
  const sendPreparedNextStart = source.indexOf("const runSendPreparedNext =");
  const sanitizer = source.indexOf("const sanitizeReadyItemsForPromotion", sendPreparedNextStart);
  const staleFilter = source.indexOf("removeReadyItemsOutsideStationContract", sanitizer);
  const recoveryCall = source.indexOf("await ensureTrackEndReadyItem", sanitizer);
  const sanitizerInjection = source.indexOf("sanitizeReadyItems: sanitizeReadyItemsForPromotion", recoveryCall);
  const finalSanitize = source.indexOf("sanitizeReadyItemsForPromotion();", recoveryCall);
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)", recoveryCall);

  assert.ok(importLine >= 0);
  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(sanitizer > sendPreparedNextStart);
  assert.ok(staleFilter > sanitizer);
  assert.ok(recoveryCall > staleFilter);
  assert.ok(sanitizerInjection > recoveryCall);
  assert.ok(finalSanitize > sanitizerInjection);
  assert.ok(promoteNext > finalSanitize);
  assert.match(source.slice(sanitizer, recoveryCall), /currentStationContract\(\)/);
  assert.match(source.slice(sanitizer, recoveryCall), /boundaryGuard/);
});

test("server filters ready items matching current or recent playback before promotion", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const importLine = source.indexOf("removeReadyItemsMatchingRecentPlayback");
  const sendPreparedNextStart = source.indexOf("const runSendPreparedNext =");
  const sanitizer = source.indexOf("const sanitizeReadyItemsForPromotion", sendPreparedNextStart);
  const duplicateFilter = source.indexOf("removeReadyItemsMatchingRecentPlayback", sanitizer);
  const recoveryCall = source.indexOf("await ensureTrackEndReadyItem", sanitizer);
  const sanitizerInjection = source.indexOf("sanitizeReadyItems: sanitizeReadyItemsForPromotion", recoveryCall);
  const finalSanitize = source.indexOf("sanitizeReadyItemsForPromotion();", recoveryCall);
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)", recoveryCall);

  assert.ok(importLine >= 0);
  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(sanitizer > sendPreparedNextStart);
  assert.ok(duplicateFilter > sanitizer);
  assert.ok(recoveryCall > duplicateFilter);
  assert.ok(sanitizerInjection > recoveryCall);
  assert.ok(finalSanitize > sanitizerInjection);
  assert.ok(promoteNext > finalSanitize);
  assert.match(source.slice(duplicateFilter, recoveryCall), /currentTrack/);
  assert.match(source.slice(duplicateFilter, recoveryCall), /playedTracks\.slice\(-8\)/);
});

test("server stops waiting on old prewarm work when a fresh listener direction starts", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const requestText = source.indexOf("const requestText = compactText", songRequestHandler);
  const cancelPrewarm = source.indexOf("prewarmTask = null", requestText);
  const requestToken = source.indexOf("const requestToken = ++nextRequestToken", requestText);

  assert.ok(songRequestHandler >= 0);
  assert.ok(requestText > songRequestHandler);
  assert.ok(cancelPrewarm > requestText);
  assert.ok(cancelPrewarm < requestToken);
});

test("server delegates explicit correction requests to the radio agent correction API", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const intentDeclaration = source.indexOf("let requestIntent:", songRequestHandler);
  const intentDecision = source.indexOf("requestIntent = intentRouter.classify(requestText)", intentDeclaration);
  const correctionBranch = source.indexOf("requestIntent?.type === \"correction\"", intentDecision);
  const serviceCorrection = source.indexOf("radioAgentService.handleCorrection", correctionBranch);
  const serviceDirection = source.indexOf("radioAgentService.handleUserText", serviceCorrection);
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
  assert.match(serviceSource, /handleRadioAgentEvent:\s*mirrorSocketRadioAgentImmediate/);
  assert.match(serviceSource, /clearReadyQueue:\s*\(\)\s*=>\s*queue\.clearReady\(\)/);
  assert.match(serviceSource, /queueProgramWindow:\s*queueRadioAgentWindow/);
  assert.match(serviceSource, /prepareProgramWindow:\s*\(programWindow,\s*options\)\s*=>\s*radioAgentProgramExecutor\.prepareFirstPlayable\(programWindow,\s*options\)/);
  assert.match(serviceSource, /playbackGovernor:\s*radioAgentPlaybackGovernor/);
  assert.match(serviceSource, /hostTextForDelivery:\s*hostTextForRadioAgentDelivery/);
  assert.match(serviceSource, /userTextQueueTimeoutMs:\s*\d+/);
});

test("server defers rejected ready playback reports until recovery cannot promote a safe item", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNextStart = source.indexOf("const runSendPreparedNext =");
  const recoveryCall = source.indexOf("await ensureTrackEndReadyItem", sendPreparedNextStart);
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)", recoveryCall);
  const missingItem = source.indexOf("if (!item)", promoteNext);
  const actionGuard = source.indexOf("radioAgentRejectedPlayback(trackEndResult.actions)", missingItem);
  const listenerError = source.indexOf('send({ type: "error"', missingItem);

  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(recoveryCall > sendPreparedNextStart);
  assert.ok(promoteNext > recoveryCall);
  assert.ok(missingItem > promoteNext);
  assert.ok(actionGuard > missingItem);
  assert.ok(listenerError > actionGuard);
  assert.doesNotMatch(source.slice(recoveryCall, promoteNext), /radioAgentRejectedPlayback\(trackEndResult\.actions\)/);
  assert.match(source.slice(actionGuard, listenerError), /send\(\{\s*type:\s*"request_status",\s*status:\s*"not_found"/);
  assert.match(source.slice(actionGuard, listenerError), /return;/);
  assert.match(source, /function radioAgentRejectedPlayback\(actions:/);
  assert.match(source, /action\.type === "honest_not_found"/);
});

test("server queues governed track-end play actions before recovery promotion", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNextStart = source.indexOf("const runSendPreparedNext =");
  const serviceContinuation = source.indexOf("const trackEndResult = await radioAgentService.handleTrackEnded", sendPreparedNextStart);
  const acceptedPlayback = source.indexOf("radioAgentAcceptedPlayback(trackEndResult.actions)", serviceContinuation);
  const queueAccepted = source.indexOf("queue.addReady(acceptedPlayback.track", acceptedPlayback);
  const recoveryCall = source.indexOf("await ensureTrackEndReadyItem", serviceContinuation);
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)", recoveryCall);

  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(serviceContinuation > sendPreparedNextStart);
  assert.ok(acceptedPlayback > serviceContinuation);
  assert.ok(queueAccepted > acceptedPlayback);
  assert.ok(recoveryCall > queueAccepted);
  assert.ok(promoteNext > recoveryCall);
  assert.match(source.slice(acceptedPlayback, recoveryCall), /governanceTrace:\s*acceptedPlayback\.governanceTrace/);
  assert.match(source.slice(acceptedPlayback, recoveryCall), /program_track_queued/);
});

test("server mirrors radio agent governance traces into runtime status events", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const acceptedHelper = source.indexOf("function radioAgentAcceptedPlayback");
  const rejectedHelper = source.indexOf("function radioAgentRejectedPlayback");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const readyBranch = source.indexOf("if (ready)", songRequestHandler);
  const requestTrace = source.indexOf("radioAgentAcceptedPlayback(agentTextResult.actions)", readyBranch);
  const requestMirror = source.indexOf('type: "program_track_queued"', requestTrace);
  const sendPreparedNextStart = source.indexOf("const runSendPreparedNext =");
  const actionGuard = source.indexOf("radioAgentRejectedPlayback(trackEndResult.actions)", sendPreparedNextStart);
  const rejectedMirror = source.indexOf('type: "playback_recovery_needed"', actionGuard);

  assert.ok(acceptedHelper >= 0);
  assert.ok(rejectedHelper > acceptedHelper);
  assert.ok(songRequestHandler >= 0);
  assert.ok(readyBranch > songRequestHandler);
  assert.ok(requestTrace > readyBranch);
  assert.ok(requestMirror > requestTrace);
  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(actionGuard > sendPreparedNextStart);
  assert.ok(rejectedMirror > actionGuard);
  assert.match(source.slice(acceptedHelper, rejectedHelper), /action\.type === "play_now"/);
  assert.match(source.slice(acceptedHelper, rejectedHelper), /Boolean\(action\.governanceTrace\)/);
  assert.match(source.slice(requestTrace, requestMirror + 420), /governanceTrace:\s*acceptedPlayback\.governanceTrace/);
  assert.match(source.slice(requestTrace, requestMirror + 420), /programWindowId:\s*agentProgramWindow\.id/);
  assert.match(source.slice(actionGuard, rejectedMirror + 420), /governanceTrace:\s*rejectedPlayback\.governanceTrace/);
  assert.match(source.slice(actionGuard, rejectedMirror + 420), /reason/);
});

test("server gives anonymous websocket sessions an isolated radio agent session id", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const socketStart = source.indexOf("async function handleRadioSocket");
  const socketEnd = source.indexOf('socket.on("close"', socketStart);
  const socketSource = source.slice(socketStart, socketEnd);

  assert.ok(socketStart >= 0);
  assert.ok(socketEnd > socketStart);
  assert.match(socketSource, /const anonymousSessionId = -Date\.now\(\) - Math\.floor\(Math\.random\(\) \* 1000000\);/);
  assert.match(socketSource, /sessionId = uid \? store\.createSession\(uid\) : anonymousSessionId;/);
  assert.doesNotMatch(socketSource, /sessionId = uid \? store\.createSession\(uid\) : null;/);
});
