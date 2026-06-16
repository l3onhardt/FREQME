# Hermes AI DJ v1 Live Acceptance Checklist

**Date:** 2026-06-11
**Branch:** `codex/hermes-radio-agent-service`
**Status:** Hermes AI DJ Beta / v1 candidate, remaining v1 gates open

This checklist records live browser and websocket evidence for the bounded Hermes-style AI DJ v1 gates. Unit tests are not enough for v1 status; playback and websocket behavior must be checked in the running app.

## Current V1 Gate Scorecard

This scorecard is the current product boundary. R&B, quiet jazz, and any other style are regression cases under the same agent contract; none of them should become the center of development by themselves.

| Gate | Current status | Evidence | Remaining gap |
| --- | --- | --- | --- |
| Fast start | Partial pass | Anonymous browser guest preview can leave the QR screen, enter the player, emit a playable first track, and keep `freqme.radioState.v1` empty. Anonymous websocket session can also emit playable `play_track`; audio proxy range requests return playable bytes. | Logged-in personalized browser playback still needs visible verification. |
| No end stall | Pass for anonymous browser guest preview and anonymous websocket | Browser guest preview advanced from the first track to a second playable track after an `ended` event; websocket `track_ended` recovery also produced a next `play_track` and playable audio bytes. | Keep under logged-in browser observation. |
| Direction retention | Partial pass | Latest explicit Chinese direction `播放安静爵士阅读` produced immediate planning, concrete DJ copy, a `ready` event, a `segue`, and playable quiet-jazz fallback track `404783927` / `Italian Dinner Background Music` / `Jazz Piano Bar Academy`. | Need 3-track live retention evidence after an explicit request. |
| Cross-genre contract | Test pass, live partial | Unit coverage exercises contract behavior and drift regression paths; quiet-jazz Chinese live smoke now passes the first executable request. | Need live matrix for R&B, jazz, quiet/focus, and one Chinese mood request. |
| Correction loop | Partial pass, rapid anonymous websocket first-hop replacement now observed | Service/runtime tests cover corrections and the status endpoint records listener text. Latest anonymous websocket smoke corrected `不要爵士了，换成晚上听的R&B` into R&B ready/segue track `489877341` / `frank ocean - pinkpuss（pink + white remix）` / `LegoG`; the post-correction event scan reported `oldAfterCorrectionCount: 0`. | Need browser proof and longer correction continuity beyond the first replacement. |
| Memory persistence | Partial / open | Store, taste distillation, and artifact paths exist and are covered by tests. | Need restart/live proof that durable preferences and avoids affect later opening or continuation decisions. |
| Host naturalness | Improved, not corpus-complete | Latest quiet-jazz direction uses concrete listener-facing Chinese: `好，接下来收进安静爵士，适合阅读，我先给你找一首稳的。` No generic acknowledgement was delivered in that smoke. | Need broader live host corpus for opening, correction, recovery, explanation, and ordinary silence. |
| Agent ownership | Partial pass | `RadioAgentService` owns session/user-text/track-end/correction service paths in tests; server now bounds request handling and guards late queue mutation. | `server.ts` still contains legacy fallback and orchestration glue that must remain adapter-level. |
| Safe degradation | Test pass, live partial | Bounded timeout and fallback paths are covered by server-wiring tests. | Need live failure-mode smoke for model/search/TTS/audio failure. |
| Observability | Pass for status endpoint | `/api/radio/agent/status` exposes listener-safe readiness, recent events, and host decisions. | Logged-in artifacts and durable memory diagnostics require a real uid. |

Current release label:

- Correct: Radio Agent Beta foundation / Hermes AI DJ v1 candidate.
- Not yet correct: Hermes-style AI DJ Radio v1 complete.

## Anti-Loop Acceptance Policy

The next work must stop optimizing around a single style request. R&B, quiet jazz, focus music, and Chinese mood requests are regression cases for the same agent contract, not separate product centers.

No new runtime change should be accepted unless it moves one of these gates:

1. Browser playback/no-stall proof.
2. Three-track direction retention.
3. Cross-genre direction matrix.
4. Durable memory across restart.
5. Host speech corpus quality.
6. RadioAgentService ownership over server orchestration.
7. Safe degradation with honest fallback.
8. Listener-safe observability.

Genre-specific search seeds, local candidate exceptions, or hard-coded track fallbacks are rejected by default. They are acceptable only if they become a generic, tested style-seed mechanism and are verified against multiple styles.

The next implementation priority is:

1. Prove visible browser playback and no-stall behavior.
2. Prove three-track direction retention across multiple directions.
3. Prove memory restart behavior for repeated explicit preference/avoid evidence.
4. Review and tighten host speech with a small live corpus.

## Environment

- Local URL: `http://127.0.0.1:8000/`
- Server command: `npm run dev`
- Browser: Codex in-app browser
- Notes:
  - Server started successfully and listened on `127.0.0.1:8000`.
  - Browser page initially loaded the NetEase QR login screen.
  - A guest preview button now starts an anonymous browser radio session without saving resume state.
  - Websocket smoke tests can also start an anonymous/backend fallback radio session.
  - Audio proxy supports `GET` with range requests. `HEAD /api/radio/audio/:id` returned 404 because that route only implements `GET`.

## Checks

### Fast Start

- Status: Partial pass
- Evidence:
  - Browser guest preview smoke on 2026-06-11:
    - Login screen was active before clicking `#guest-radio-btn`.
    - Player screen became active after the click.
    - First track became visible and playable:
      - Track id `489877341`, observed title `frank ocean - pinkpuss（pink + white remix）`, observed artist `LegoG`.
      - Audio src `http://127.0.0.1:8000/api/radio/audio/489877341`.
      - `audio.paused` was `false`.
      - `localStorage.getItem("freqme.radioState.v1")` stayed `null`.
  - Websocket handshake returned `session_start`.
  - The server emitted `play_track` in backend smoke without a browser login:
    - Track id `3358758858`, observed title `My Jinji`, observed artist `Sunset Rollercoaster`.
    - Later smoke: track id `1932620174`, observed title `Daniel Caesar-Best Part (Vinahouse Edit)`, observed artist `A Sen`.
  - `GET /api/radio/audio/3358758858` with `Range: bytes=0-1023` returned `206 Partial Content`, `audio/mpeg`, and `1024` bytes.
- Failure notes:
  - Anonymous browser guest playback is now visibly verified.
  - Logged-in personalized browser playback is still unverified because no NetEase account/session is available in this environment.

### No End Stall

- Status: Pass for anonymous browser guest preview and anonymous websocket smoke on 2026-06-11; keep under observation for logged-in browser playback
- Evidence:
  - Browser guest preview smoke on 2026-06-11:
    - First track: `489877341` / `frank ocean - pinkpuss（pink + white remix）` / `LegoG`.
    - Dispatching an `ended` event on `#audio-main` advanced to the second track within the timeout.
    - Second track: `404783927` / `Italian Dinner Background Music` / `Jazz Piano Bar Academy`.
    - Second audio src changed to `http://127.0.0.1:8000/api/radio/audio/404783927`.
    - `audio.paused` was `false`.
    - Saved radio state remained `null`.
  - Earlier smoke failed: after a websocket `track_ended` message, the server recorded `track_completed` and `queue_low`, but no new `play_track` arrived within 15 seconds.
  - After the bounded no-stall recovery fix, a fresh websocket smoke produced:
    - First `play_track`: track id `2023945522`, observed title `SZA-good days (SiLENTMOON remix)`.
    - Sent websocket `{ "type": "track_ended" }`.
    - Next `play_track` arrived about 2.5 seconds after handshake / about 2.2 seconds after the first track: track id `1932620174`, observed title `Daniel Caesar-Best Part (Vinahouse Edit) (A Sen remix)`, observed artist `A Sen`.
    - No websocket `error` message was observed.
  - `GET /api/radio/audio/1932620174` with `Range: bytes=0-1023` returned `206`, `audio/mpeg`, and `1024` bytes.
- Failure notes:
  - This satisfies the anonymous browser guest no-stall path and the anonymous websocket no-stall path.
  - It does not yet prove logged-in browser playback, direction-retention continuity, or correction playback continuity.

### User Direction

- Status: Partial pass, with latest first-hop explicit direction passing on anonymous websocket
- Evidence:
  - Websocket `song_request` with `play quiet jazz for reading` produced:
    - `request_status`: `planning`.
    - listener-facing acknowledgement meaning "Received, I will re-plan the next few tracks in this direction."
    - matching `dj_message` with a TTS hash.
  - `/api/radio/agent/status` recorded a `user_text` event for the request.
  - Later websocket `song_request` with Chinese text `播放安静爵士阅读` produced:
    - `request_status`: `planning`, text meaning "I will find a stable track in this direction first."
    - `dj_message`: `好，接下来收进安静爵士，适合阅读，我先给你找一首稳的。`
    - `ready`: `按你说的安静爵士阅读氛围，先找一首能稳定播放的。`
    - `segue`: same concrete quiet-jazz host line.
    - Next track id `404783927`, title `Italian Dinner Background Music`, artist `Jazz Piano Bar Academy`.
    - `GET /api/radio/audio/404783927` with range request returned `206`, `audio/mpeg`, and playable bytes.
- Failure notes:
  - The first-hop explicit direction chain now passes for the tested Chinese quiet-jazz request.
  - Direction retention still cannot be marked full pass until the next 3 tracks remain on contract or record deliberate bridges with return requirements.

### Correction

- Status: Partial pass, with latest anonymous websocket replacement passing first-hop playback
- Evidence:
  - Websocket `song_request` with `don't play Frank Ocean tonight` was recorded as `user_text`.
  - `/api/radio/agent/status` showed a listener-facing host acknowledgement meaning "I will avoid Frank Ocean for now and switch direction."
  - Later websocket correction sequence:
    - First request: `播放安静爵士阅读`.
    - Correction: `不要爵士了，换成晚上听的R&B`.
    - Result arrived in about 3.47 seconds.
    - `request_status`: `ready`, text `按你说的 R&B 方向，先找一首人声和律动都稳的。`
    - `segue` next track id `489877341`, title `frank ocean - pinkpuss（pink + white remix）`, artist `LegoG`, url `/api/radio/audio/489877341`.
  - After the request-token promotion guard, a rapid anonymous websocket smoke sent the correction shortly after the first explicit request planning event:
    - R&B `ready` / `segue` arrived at about 2.45 seconds after handshake.
    - The event scan reported `gotRnb: true`, `oldAfterCorrectionCount: 0`.
    - No old quiet-jazz `segue` or `play_track` was emitted after the correction timestamp in that smoke.
- Failure notes:
  - The correction now reaches replacement playback on the tested anonymous websocket path.
  - Full correction loop still cannot be marked pass until the browser playback path and longer post-correction continuity are verified.

### Host Naturalness

- Status: Improved, still partial
- Evidence:
  - Observed listener-facing speech for station opening, user direction acknowledgement, correction acknowledgement, and queue recovery.
  - No observed line included internal terms such as `contract`, `candidate`, `trace`, `pipeline`, or `current station direction`.
  - Latest explicit Chinese direction preferred the concrete program host line over a generic acknowledgement.
  - Browser guest preview previously kept the opening line visible after the second track started. A regression test now covers this path, and the live smoke now shows second-track plain continuation text `让音乐继续，我先不打扰。` instead of stale opening copy.
- Failure notes:
  - One later generated intro appeared truncated in the smoke output. This should be checked in the browser/TTS path before v1.
  - Host speech still needs a small live corpus review; one good line does not prove the DJ persona is stable.

### Diagnostics Visibility

- Status: Pass
- Evidence:
  - `GET /api/radio/agent/status` returned `200`.
  - Response exposed listener-safe readiness:
    - mode: `assisted`
    - planner: `available`
    - speech: `available`
    - summary: listener-facing active planning text
  - Response exposed recent events and host decisions for handshake, playback, queue pressure, user direction, and correction.
- Failure notes:
  - `uid` and artifacts were empty in anonymous smoke; persistent user memory diagnostics still require logged-in verification.

## Summary

- Current live gate result: Hermes AI DJ Beta / v1 candidate, improved but not v1 complete.
- Remaining gaps:
  - User direction first-hop execution now works for the tested Chinese quiet-jazz path, but 3-track retention is not proven.
  - Correction replacement playback now works for the tested anonymous websocket path, and the latest rapid correction smoke did not emit stale old-direction playback after correction; browser playback and longer correction continuity are not proven.
  - Anonymous browser guest playback and no-stall are now verified, but logged-in personalized browser playback remains unverified.
  - Persistent memory and logged-in library ingestion still require a logged-in NetEase session.
- Next implementation should be gate-driven:
  - prove 3-track direction retention across multiple genres;
  - prove live correction replacement playback;
  - prove memory persistence across restart;
  - verify logged-in browser playback.
