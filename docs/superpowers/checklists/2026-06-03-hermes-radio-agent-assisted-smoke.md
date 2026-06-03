# Hermes Radio Agent Assisted Smoke

## Start Assisted Backend

- [ ] Start from `C:\Users\lacr1\Desktop\AI音乐\.worktrees\hermes-radio-agent-service`.
- [ ] Build the backend first with `npm run build`.
- [ ] Use the direct assisted command below, not `npm run start:local`, so the smoke always targets the main data directory and fixed port `8000`.

```powershell
$env:DATA_DIR = 'C:\Users\lacr1\Desktop\AI音乐\data'
$env:RADIO_DB_PATH = 'C:\Users\lacr1\Desktop\AI音乐\data\freqme.db'
$env:NETEASE_COOKIE_PATH = 'C:\Users\lacr1\Desktop\AI音乐\data\netease-cookie.json'
$env:RADIO_AGENT_MODE = 'assisted'
node.exe -r dotenv/config dist/src/server.js dotenv_config_path='C:\Users\lacr1\Desktop\AI音乐\.env'
```

- [ ] Open `http://127.0.0.1:8000/` and restore/login as the saved NetEase user.
- [ ] Confirm first music starts quickly, before waiting for a long visible planning cycle.

## Status Evidence

- [ ] Fetch agent status for the active user:

```powershell
$uid = '<uid>'
$status = Invoke-RestMethod "http://127.0.0.1:8000/api/radio/agent/status?uid=$uid"
$status.mode
$status.artifacts.PSObject.Properties.Name
$status.recentEvents | Select-Object -First 5 type, createdAt
$status.recentDecisions | Select-Object -First 5 decisionType, createdAt
```

- [ ] Confirm `$status.mode` is `assisted`.
- [ ] Confirm `$status.artifacts` contains exact keys when context is available: `user_profile.md`, `station_now.md`, and `program_contract.md`.
- [ ] Confirm each artifact entry has `updatedAt` and `sourceVersion`.
- [ ] Let the queue drain or skip until queue pressure occurs, then confirm `$status.recentEvents` contains an event with `type` equal to `queue_low`.
- [ ] Confirm `$status.recentDecisions` contains a decision with `decisionType` equal to `program_window`.

## Assisted Success Evidence

- [ ] After assisted planning has queued a track, confirm the saved trace shows an agent-owned selection reason. This evidence is stored internally because frontend `trackInfo` intentionally strips `selectionReason`.

```powershell
$dbPath = 'C:\Users\lacr1\Desktop\AI音乐\data\freqme.db'
$scriptPath = Join-Path $env:TEMP 'freqme-trace-check.mjs'
@'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
const rows = db.prepare("SELECT trace_json FROM decision_trace ORDER BY created_at DESC LIMIT 10").all();
console.log(rows.map((row) => {
  const trace = JSON.parse(row.trace_json);
  return {
    id: trace.id,
    track: trace.selectedTrack?.name,
    reasonType: trace.selectedTrack?.selectionReason?.type,
    traceId: trace.selectedTrack?.selectionReason?.traceId,
  };
}));
'@ | Set-Content -LiteralPath $scriptPath -Encoding UTF8
node $scriptPath $dbPath
Remove-Item -LiteralPath $scriptPath
```

- [ ] Confirm at least one recent row has `reasonType` equal to `radio_agent_program`.
- [ ] Confirm the same row has a non-empty `traceId`.
- [ ] Confirm any spoken host line in the app, or `hostText` in the saved trace, is short and contains no internal terms such as `candidate`, `trace`, `verification`, `model`, `JSON`, `prompt`, `tool call`, `tool-call`, or `shadow_mode`.
- [ ] Ask "why this song?" in the app.
- [ ] Confirm the answer mentions the current song or artist and gives a listener-facing reason, or falls back gracefully without internal terms.

## Assisted Fallback Evidence

- [ ] If assisted fallback occurs naturally, confirm it is logged in `playback_event`.

```powershell
$dbPath = 'C:\Users\lacr1\Desktop\AI音乐\data\freqme.db'
$scriptPath = Join-Path $env:TEMP 'freqme-fallback-check.mjs'
@'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
console.log(db.prepare("SELECT event_type, reason, created_at FROM playback_event WHERE event_type = 'radio_agent_assisted_fallback' ORDER BY id DESC LIMIT 10").all());
'@ | Set-Content -LiteralPath $scriptPath -Encoding UTF8
node $scriptPath $dbPath
Remove-Item -LiteralPath $scriptPath
```

- [ ] To force a fallback run, restart the backend in a separate smoke attempt with the same command but set `$env:LLM_API_KEY = 'invalid-for-assisted-fallback-smoke'` before starting the server.
- [ ] During the forced fallback run, confirm playback still continues through the legacy/degraded path rather than stopping.
- [ ] Confirm the query above returns `radio_agent_assisted_fallback` rows with a non-empty `reason`, such as `program_window_missing`, `program_executor_no_track`, `trace_save_failed`, or `assisted_queue_failed`.
- [ ] Restart the server again with the normal assisted command.
- [ ] Confirm `$status.artifacts` still exposes durable profile artifacts after restart.
