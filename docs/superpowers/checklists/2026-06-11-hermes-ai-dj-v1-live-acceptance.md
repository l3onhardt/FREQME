# Hermes AI DJ v1 Live Acceptance Checklist

**Date:** 2026-06-11
**Branch:** `codex/hermes-radio-agent-service`
**Status:** Checked with failures

This checklist records live browser and websocket evidence for the bounded Hermes-style AI DJ v1 gates. Unit tests are not enough for v1 status; playback and websocket behavior must be checked in the running app.

## Environment

- Local URL: `http://127.0.0.1:8000/`
- Server command: `npm run dev`
- Browser: Codex in-app browser
- Notes:
  - Server started successfully and listened on `127.0.0.1:8000`.
  - Browser page loaded, but visible UI stayed on the NetEase QR login screen.
  - Websocket smoke tests could still start an anonymous/backend fallback radio session.
  - Audio proxy supports `GET` with range requests. `HEAD /api/radio/audio/:id` returned 404 because that route only implements `GET`.

## Checks

### Fast Start

- Status: Partial pass
- Evidence:
  - Websocket handshake returned `session_start`.
  - The server emitted `play_track` in backend smoke without a browser login:
    - Track id `3358758858`, observed title `My Jinji`, observed artist `Sunset Rollercoaster`.
    - Later smoke: track id `1932620174`, observed title `Daniel Caesar-Best Part (Vinahouse Edit)`, observed artist `A Sen`.
  - `GET /api/radio/audio/3358758858` with `Range: bytes=0-1023` returned `206 Partial Content`, `audio/mpeg`, and `1024` bytes.
- Failure notes:
  - The in-app browser UI itself remained on the QR login screen, so full visible playback UX was not verified from page controls.

### No End Stall

- Status: Fail
- Evidence:
  - After a websocket `track_ended` message, the server recorded:
    - `track_completed` for track id `1932620174`.
    - two `queue_low` events with an empty ready queue.
    - host decisions with a listener-facing recovery handoff meaning "I will connect one stable song and keep the station going."
  - In the 15 second smoke window after `track_ended`, no new `play_track` message arrived.
- Failure notes:
  - This does not satisfy the v1 no-stall gate. The agent noticed queue pressure and produced host intent, but no playable next item reached the websocket.

### User Direction

- Status: Partial pass
- Evidence:
  - Websocket `song_request` with `play quiet jazz for reading` produced:
    - `request_status`: `planning`.
    - listener-facing acknowledgement meaning "Received, I will re-plan the next few tracks in this direction."
    - matching `dj_message` with a TTS hash.
  - `/api/radio/agent/status` recorded a `user_text` event for the request.
- Failure notes:
  - The smoke did not observe a queued replacement `play_track` for the requested direction before the wait ended, so direction retention cannot be marked pass.

### Correction

- Status: Partial pass
- Evidence:
  - Websocket `song_request` with `don't play Frank Ocean tonight` was recorded as `user_text`.
  - `/api/radio/agent/status` showed a listener-facing host acknowledgement meaning "I will avoid Frank Ocean for now and switch direction."
- Failure notes:
  - The smoke did not observe incompatible queued items being removed or a replacement `play_track` reaching the websocket, so the full correction loop cannot be marked pass.

### Host Naturalness

- Status: Partial pass
- Evidence:
  - Observed listener-facing speech for station opening, user direction acknowledgement, correction acknowledgement, and queue recovery.
  - No observed line included internal terms such as `contract`, `candidate`, `trace`, `pipeline`, or `current station direction`.
- Failure notes:
  - One later generated intro appeared truncated in the smoke output. This should be checked in the browser/TTS path before v1.

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

- Current live gate result: Failed v1 live gate.
- Remaining gaps:
  - No-stall failed: `track_ended` did not produce a new `play_track` within 15 seconds.
  - User direction and correction produced acknowledgements, but replacement playback was not observed.
  - Full browser playback UX remains unverified because the visible page stayed on the QR login screen.
  - Persistent memory and logged-in library ingestion still require a logged-in NetEase session.
