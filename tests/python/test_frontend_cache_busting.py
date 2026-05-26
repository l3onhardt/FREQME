from pathlib import Path


def test_radio_script_uses_cache_busting_query():
    html = Path("frontend/index.html").read_text(encoding="utf-8")

    assert 'src="js/radio.js?v=' in html


def test_radio_stylesheet_uses_cache_busting_query():
    html = Path("frontend/index.html").read_text(encoding="utf-8")

    assert 'href="css/radio.css?v=' in html


def test_frontend_brand_uses_freqme():
    html = Path("frontend/index.html").read_text(encoding="utf-8")
    script = Path("frontend/js/radio.js").read_text(encoding="utf-8")

    assert "<title>FREQME</title>" in html
    assert 'id="scene-label">FREQME</div>' in html
    assert "FREQME" in script
    assert "小米memo电台" not in html
    assert "小米memo电台" not in script
