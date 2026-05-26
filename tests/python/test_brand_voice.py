from pathlib import Path


def test_backend_host_identity_uses_freqme():
    llm_router = Path("backend/adapters/llm_router.py").read_text(encoding="utf-8")
    dj_engine = Path("backend/engines/dj.py").read_text(encoding="utf-8")

    combined = f"{llm_router}\n{dj_engine}"
    assert "FREQME" in combined
    assert "小米 memo" not in combined
