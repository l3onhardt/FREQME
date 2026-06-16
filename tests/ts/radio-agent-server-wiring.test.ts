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
  assert.match(source, /executeRadioAgentActions\(trackEndResult\.actions\)/);
});

test("server delegates the first playback attempt to RadioAgentService before governed opening fallback", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const handshake = source.indexOf('if (type === "handshake")');
  const openingAttempt = source.indexOf("tryQueueRadioAgentOpeningTrack", handshake);
  const governedFallback = source.indexOf("runGovernedLegacyFallback({", openingAttempt);
  const firstPromote = source.indexOf("const item = queue.promoteNext()", governedFallback);

  assert.ok(handshake >= 0);
  assert.ok(openingAttempt > handshake);
  assert.ok(governedFallback > openingAttempt);
  assert.ok(firstPromote > governedFallback);
  assert.match(source.slice(openingAttempt, governedFallback), /avoidArtists:\s*durableAvoidedArtists\(uid\)/);
  assert.match(source.slice(openingAttempt, governedFallback), /likedTracks:\s*likedOpeningTracks\(\{/);
  assert.match(source.slice(governedFallback, firstPromote), /source:\s*"opening"/);
  assert.doesNotMatch(source.slice(openingAttempt, firstPromote), /radioBrain\.startSession|fillQueue\(1,\s*false\)/);
});

test("server legacy fallback candidate helpers do not mutate playback directly", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  for (const helperName of [
    "buildLegacyOpeningFallbackCandidate",
    "buildLegacyRequestFallbackCandidate",
    "buildLegacyContinuationFallbackCandidate",
  ]) {
    const helperStart = source.indexOf(`const ${helperName}`);
    assert.ok(helperStart >= 0, `expected ${helperName} helper to exist`);
    const nextHelper = source.indexOf("\n  const ", helperStart + 1);
    const helperBody = source.slice(helperStart, nextHelper > helperStart ? nextHelper : helperStart + 3000);
    assert.doesNotMatch(helperBody, /queue\.addReady|queue\.promoteNext|sendTrack\(|fillQueue\(1,\s*false\)|synthesizeAndSendDjMessage/);
  }
});

test("server wraps legacy fallback candidates with governor and action runner", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const tools = source.indexOf("const legacyFallbackTools = createLegacyFallbackTools");
  const runner = source.indexOf("const runGovernedLegacyFallback =", tools);
  const actionExecution = source.indexOf("executeRadioAgentActions([fallbackResult.action])", runner);

  assert.ok(tools >= 0);
  assert.ok(runner > tools);
  assert.ok(actionExecution > runner);
  assert.match(source.slice(tools, runner), /candidateSource:\s*legacyFallbackCandidateSource/);
  assert.match(source.slice(tools, runner), /radioAgentPlaybackGovernor\.evaluate/);
  assert.match(source.slice(tools, runner), /contract:\s*fallbackContractForGovernor\(context\)/);
  assert.match(source.slice(runner, actionExecution + 120), /currentAgentActionContract\(\)/);
});

test("server maps fallback sources to opening request correction and continuation candidate helpers", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sourceHelper = source.indexOf("const legacyFallbackCandidateSource");
  const helperEnd = source.indexOf("const currentAgentActionContract", sourceHelper);
  const body = source.slice(sourceHelper, helperEnd);

  assert.ok(sourceHelper >= 0);
  assert.match(body, /context\.source === "request"/);
  assert.match(body, /context\.source === "correction"/);
  assert.match(body, /buildLegacyRequestFallbackCandidate/);
  assert.match(body, /context\.source === "opening"/);
  assert.match(body, /buildLegacyOpeningFallbackCandidate/);
  assert.match(body, /buildLegacyContinuationFallbackCandidate/);
});

test("server routes queue-low and track-end fallback intent through governed fallback before promotion", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const trackEndCall = source.indexOf("radioAgentService.handleTrackEnded");
  const actionExecution = source.indexOf("executeRadioAgentActions(trackEndResult.actions)", trackEndCall);
  const governedFallback = source.indexOf("runGovernedLegacyFallback({", actionExecution);
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)", governedFallback);

  assert.ok(trackEndCall >= 0);
  assert.ok(actionExecution > trackEndCall);
  assert.ok(governedFallback > actionExecution);
  assert.ok(promoteNext > governedFallback);
  assert.match(source.slice(governedFallback, promoteNext), /source:\s*actionSummary\.fallbackLevels\.length\s*\?\s*"queue_low"\s*:\s*"track_end"/);
  assert.doesNotMatch(source.slice(actionExecution, promoteNext), /ensureTrackEndReadyItem|fillQueue\(1,\s*false\)|kickBrainContinuation|addRecentPlayableFallback/);
});

test("server routes request timeout and fallback intent through governed fallback", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const timeoutBranch = source.indexOf('if (!("hostText" in agentTextResult))', songRequestHandler);
  const timeoutFallback = source.indexOf("runGovernedLegacyFallback({", timeoutBranch);
  const actionExecution = source.indexOf("executeRadioAgentActions(agentTextResult.actions)", timeoutBranch);
  const fallbackReasonCheck = source.indexOf("agentTextResult.fallbackReason", actionExecution);
  const intentFallback = source.indexOf("runGovernedLegacyFallback({", fallbackReasonCheck);

  assert.ok(songRequestHandler >= 0);
  assert.ok(timeoutBranch > songRequestHandler);
  assert.ok(timeoutFallback > timeoutBranch);
  assert.ok(actionExecution > timeoutFallback);
  assert.ok(fallbackReasonCheck > actionExecution);
  assert.ok(intentFallback > fallbackReasonCheck);
  assert.match(source.slice(timeoutFallback, actionExecution), /expectedRequestToken:\s*requestToken/);
  assert.match(source.slice(intentFallback, intentFallback + 420), /actionSummary\.fallbackLevels/);
  assert.doesNotMatch(source.slice(songRequestHandler, intentFallback + 500), /radioBrain\.handleUserText|runStationDirectorRequestFallback/);
});

test("server converts the active station contract before fallback governance", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const helper = source.indexOf("const currentAgentActionContract");
  const runner = source.indexOf("const runGovernedLegacyFallback =", helper);

  assert.ok(helper >= 0);
  assert.ok(runner > helper);
  assert.match(source.slice(helper, runner), /agentContractForGovernor\(currentStationContract\(\),\s*\{\s*uid,\s*sessionId\s*\}\)/);
  assert.match(source.slice(helper, runner), /fallbackContractForGovernor/);
  assert.match(source.slice(runner, runner + 500), /contract:\s*currentAgentActionContract\(\)/);
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
  assert.match(socketSource.slice(helper, localMirror), /programContractMarkdownFromStationContract\(currentStationContract\(\)\)/);
  assert.match(socketSource.slice(localMirror, serviceConstruction), /mirrorRadioAgentImmediate\(radioAgentEventWithCurrentContract\(event\)\)/);
  assert.match(socketSource.slice(serviceConstruction, serviceEnd), /handleRadioAgentEvent:\s*mirrorSocketRadioAgentImmediate/);
});

test("server filters stale and duplicate ready items before promotion", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const sendPreparedNextStart = source.indexOf("const runSendPreparedNext =");
  const sanitizer = source.indexOf("const sanitizeReadyItemsForPromotion", sendPreparedNextStart);
  const staleFilter = source.indexOf("removeReadyItemsOutsideStationContract", sanitizer);
  const duplicateFilter = source.indexOf("removeReadyItemsMatchingRecentPlayback", sanitizer);
  const finalSanitize = source.indexOf("sanitizeReadyItemsForPromotion();", sanitizer + 1);
  const promoteNext = source.indexOf("const item = queue.promoteNext(previousEvent)", finalSanitize);

  assert.ok(sendPreparedNextStart >= 0);
  assert.ok(sanitizer > sendPreparedNextStart);
  assert.ok(staleFilter > sanitizer);
  assert.ok(duplicateFilter > staleFilter);
  assert.ok(finalSanitize > duplicateFilter);
  assert.ok(promoteNext > finalSanitize);
});

test("server delegates explicit correction requests to the radio agent correction API", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const songRequestHandler = source.indexOf('if (type === "song_request")');
  const intentDecision = source.indexOf("requestIntent = intentRouter.classify(requestText)", songRequestHandler);
  const correctionBranch = source.indexOf('requestIntent?.type === "correction"', intentDecision);
  const serviceCorrection = source.indexOf("radioAgentService.handleCorrection", correctionBranch);
  const serviceDirection = source.indexOf("radioAgentService.handleUserText", serviceCorrection);

  assert.ok(songRequestHandler >= 0);
  assert.ok(intentDecision > songRequestHandler);
  assert.ok(correctionBranch > intentDecision);
  assert.ok(serviceCorrection > correctionBranch);
  assert.ok(serviceDirection > serviceCorrection);
  assert.match(source.slice(serviceCorrection, serviceDirection), /currentTrack:\s*currentTrack\s*\?\s*trackInfo\(currentTrack\)\s*:\s*null/);
  assert.match(source.slice(serviceCorrection, serviceDirection), /readyQueue:\s*queue\.readyItems\(\)\.map\(\(readyItem\)\s*=>\s*trackInfo\(readyItem\.track\)\)/);
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

test("server mirrors radio agent governance traces into runtime status events", () => {
  const source = fs.readFileSync("src/server.ts", "utf8");
  const actionRunnerHelper = source.indexOf("const executeRadioAgentActions =");
  const actionRunnerHelperEnd = source.indexOf("const withUserRequestAgentTimeout", actionRunnerHelper);

  assert.ok(actionRunnerHelper >= 0);
  assert.ok(actionRunnerHelperEnd > actionRunnerHelper);
  assert.match(source.slice(actionRunnerHelper, actionRunnerHelperEnd), /type:\s*"program_track_queued"/);
  assert.match(source.slice(actionRunnerHelper, actionRunnerHelperEnd), /governanceTrace/);
  assert.match(source.slice(actionRunnerHelper, actionRunnerHelperEnd), /type:\s*"playback_recovery_needed"/);
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
