# AI Radio Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first reliable AI Radio Brain slice so user feedback and vague listening requests are understood through taste, session context, and profile-first candidate selection instead of raw search.

**Architecture:** Add focused engine modules for taste distillation, context summarization, listening intent, and personalized ranking. Keep the current scheduler and WebSocket flow, but route text input through the new brain before calling the specific-song search agent.

**Tech Stack:** Python 3.12, FastAPI WebSocket flow, existing SQLite memory store, unittest/pytest-compatible async tests.

---

## File Structure

- Create `backend/engines/radio_brain.py`: data classes and orchestration for taste, context, session feedback, listening decisions, and ranking.
- Modify `backend/engines/scheduler.py`: add `brain_state` support and profile-first constrained candidate selection.
- Modify `backend/api/ws.py`: route `song_request` through `RadioBrain` before `SongRequestAgent`.
- Modify `backend/main.py`: instantiate `RadioBrain` and wire it into `ws`.
- Create `tests/python/test_radio_brain.py`: unit tests for distillation, intent routing, feedback constraints, and ranker behavior.
- Modify `tests/python/test_scheduler_personalized_pick.py`: tests for profile-first candidate selection with avoid constraints.
- Modify `tests/python/test_ws_user_settings.py`: integration tests for the original failure phrase and precise song requests.

## Task 1: Radio Brain Core

**Files:**
- Create: `backend/engines/radio_brain.py`
- Test: `tests/python/test_radio_brain.py`

- [ ] **Step 1: Write failing tests**

Add tests that assert:

```python
decision = brain.interpret_user_text(
    "能不能不要放这些中文歌了",
    profile=sample_profile,
    user_settings={"timezone_name": "Asia/Hong_Kong", "region_hint": "香港"},
)
self.assertEqual(decision.intent_type, "negative_feedback")
self.assertIn("中文", decision.avoid_languages)
self.assertFalse(decision.allow_search)
self.assertEqual(decision.candidate_strategy, "profile_first")
self.assertIn("中文", decision.ack_text)
```

Also assert that:

```python
decision = brain.interpret_user_text("我想听李云迪的普2", profile=sample_profile, user_settings={})
self.assertEqual(decision.intent_type, "specific_song")
self.assertTrue(decision.allow_search)
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `python -m pytest tests/python/test_radio_brain.py -v`

Expected: FAIL because `backend.engines.radio_brain` does not exist.

- [ ] **Step 3: Implement minimal core**

Create `TasteModel`, `ListeningDecision`, `SessionTasteState`, `ContextSnapshot`, and `RadioBrain`.

Required behavior:

- Detect negative feedback phrases: `不要`, `别放`, `不想听`, `受不了`, `太流行`, `口水歌`, `这些中文歌`.
- Detect Chinese-language rejection and mainstream-Chinese rejection.
- Detect specific requests with explicit markers such as `我想听`, `想听`, `播放`, `点一首` plus a compact title or artist/version phrase.
- Distill profile anchors and recent tracks into `TasteModel`.
- Return deterministic acknowledgement text for negative feedback.

- [ ] **Step 4: Run tests and verify they pass**

Run: `python -m pytest tests/python/test_radio_brain.py -v`

Expected: PASS.

## Task 2: Personalized Ranker and Constraints

**Files:**
- Modify: `backend/engines/radio_brain.py`
- Test: `tests/python/test_radio_brain.py`

- [ ] **Step 1: Write failing tests**

Add tests that assert Chinese candidates are filtered when `avoid_languages=["中文"]`, and non-Chinese profile candidates are preferred:

```python
ranked = brain.rank_candidates(
    [
        {"id": "cn", "name": "中文歌", "ar": [{"name": "华语歌手"}], "language": "中文"},
        {"id": "en", "name": "Exit Music", "ar": [{"name": "Radiohead"}], "language": "英文"},
    ],
    taste_model,
    decision,
)
self.assertEqual(ranked[0]["id"], "en")
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `python -m pytest tests/python/test_radio_brain.py::RadioBrainTests::test_ranker_prefers_candidates_that_satisfy_negative_feedback -v`

Expected: FAIL because `rank_candidates` is missing or does not filter.

- [ ] **Step 3: Implement minimal ranker**

Add:

- language inference from explicit `language`, title/artist CJK characters, and profile metadata
- style tag inference from `selection_reason`, `source`, `name`, and artist text
- filtering for avoid languages/styles
- score boost for profile candidates and recent/anchor source
- fallback to original order if every candidate is filtered

- [ ] **Step 4: Run tests and verify they pass**

Run: `python -m pytest tests/python/test_radio_brain.py -v`

Expected: PASS.

## Task 3: Scheduler Profile-First Candidate Selection

**Files:**
- Modify: `backend/engines/scheduler.py`
- Test: `tests/python/test_scheduler_personalized_pick.py`

- [ ] **Step 1: Write failing tests**

Add a test where `user_settings["radio_brain"]["decision"]` contains a negative feedback decision and the profile has one Chinese anchor and one English anchor. Assert the English anchor is selected and `netease.search` is not called.

- [ ] **Step 2: Run tests and verify they fail**

Run: `python -m pytest tests/python/test_scheduler_personalized_pick.py::SchedulerPersonalizedPickTests::test_brain_negative_feedback_prefers_profile_candidate_without_search -v`

Expected: FAIL because scheduler ignores `radio_brain`.

- [ ] **Step 3: Implement scheduler support**

Update scheduler to:

- read `user_settings["radio_brain"]`
- build profile candidate list from `anchor_tracks` and `recent_tracks`
- filter/rank through `RadioBrain.rank_candidates`
- select a playable profile candidate before intent search when candidate strategy is `profile_first`
- preserve existing fallback behavior

- [ ] **Step 4: Run tests and verify they pass**

Run: `python -m pytest tests/python/test_scheduler_personalized_pick.py -v`

Expected: PASS.

## Task 4: WebSocket Routing

**Files:**
- Modify: `backend/api/ws.py`
- Modify: `backend/main.py`
- Test: `tests/python/test_ws_user_settings.py`

- [ ] **Step 1: Write failing tests**

Add an integration test:

- handshake
- send `song_request` with `能不能不要放这些中文歌了`
- assert `request_agent.resolve` is not called
- assert scheduler receives `user_settings["radio_brain"]["decision"]["intent_type"] == "negative_feedback"`
- assert DJ message acknowledges avoiding Chinese songs

Also keep a test that `我想听李云迪的普2` still calls `request_agent.resolve`.

- [ ] **Step 2: Run tests and verify they fail**

Run: `python -m pytest tests/python/test_ws_user_settings.py::WebSocketUserSettingsTests::test_ws_negative_feedback_uses_radio_brain_without_specific_search -v`

Expected: FAIL because WebSocket still calls request agent first.

- [ ] **Step 3: Implement routing**

Update WebSocket flow:

- call `radio_brain.interpret_user_text` first
- for `specific_song`, call `request_agent.resolve`
- for `negative_feedback`, `taste_direction`, and `skip_variant`, store decision in `user_settings["radio_brain"]`, apply scheduler intent, send acknowledgement, fill queue
- do not clear or promote current playback unless the resulting action explicitly plays a prepared item

Update `main.py` to instantiate and wire `radio_brain`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `python -m pytest tests/python/test_ws_user_settings.py -v`

Expected: PASS.

## Task 5: Verification

**Files:**
- All touched files

- [ ] **Step 1: Run focused tests**

Run:

```powershell
python -m pytest tests/python/test_radio_brain.py tests/python/test_scheduler_personalized_pick.py tests/python/test_ws_user_settings.py tests/python/test_song_request_agent.py -v
```

Expected: PASS.

- [ ] **Step 2: Run broader Python tests**

Run:

```powershell
python -m pytest tests/python -v
```

Expected: PASS or document unrelated existing failures.

- [ ] **Step 3: Restart app**

Stop the current `uvicorn backend.main:app` process for this workspace if it is running, then start:

```powershell
$env:NETEASE_BRIDGE_PORT='3001'; $env:PORT='3001'; python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Expected:

- `GET http://127.0.0.1:8000/health` returns `{"status":"ok"}`
- `GET http://127.0.0.1:8000/` returns status `200`
