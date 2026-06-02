# Long-Term Radio Agent Shadow Smoke

- [ ] Start local server from `C:\Users\lacr1\Desktop\AI音乐\.worktrees\hermes-radio-agent-service`.
- [ ] Open `http://127.0.0.1:8000/`.
- [ ] Log in or restore account.
- [ ] Confirm first track starts before library scan completes.
- [ ] Confirm UI remains usable while agent status says profile/library work is running.
- [ ] Confirm `/api/radio/agent/status?uid=<uid>` returns shadow mode status.
- [ ] Confirm radio playback still uses legacy fallback when shadow runtime fails.
- [ ] Skip one track.
- [ ] Confirm skip is recorded as session evidence, not long-term dislike.
- [ ] Ask "why this song?"
- [ ] Confirm legacy answer still works and shadow trace exists for future explanation.
- [ ] Restart server.
- [ ] Confirm agent artifacts and recent events persist.
