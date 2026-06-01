# Continuous AI Radio Host Smoke Checklist

- Start the local server.
- Open `http://127.0.0.1:8002/` with a logged-in NetEase account.
- Confirm the first track starts before deep planning finishes.
- Ask: `我现在要专注写代码，别太 emo，也不要 edm/dubstep，来点安静但有推动力的`.
- Confirm the resulting plan does not contain emo as a positive direction.
- Ask: `你为什么给我放这首？`.
- Confirm the answer explains the current track and does not trigger a new `play_track`.
- Ask: `不是这种，太电了；我要没有人声的安静专注背景，像工作流，不要 emo，不要 edm`.
- Confirm queued incompatible tracks are cleared and the next track is instrumental/focus.
- Let two next tracks play and confirm the direction persists.
- Check `playback_event` and `decision_trace` rows for traceability.
