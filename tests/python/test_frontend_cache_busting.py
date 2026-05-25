from pathlib import Path


def test_radio_script_uses_cache_busting_query():
    html = Path("frontend/index.html").read_text(encoding="utf-8")

    assert 'src="js/radio.js?v=' in html


def test_radio_stylesheet_uses_cache_busting_query():
    html = Path("frontend/index.html").read_text(encoding="utf-8")

    assert 'href="css/radio.css?v=' in html
