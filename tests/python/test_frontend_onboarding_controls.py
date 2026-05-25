from pathlib import Path


def test_onboarding_choices_have_clear_selected_indicator():
    css = Path("frontend/css/radio.css").read_text(encoding="utf-8")

    assert ".choice-card.selected::after" in css
    assert ".choice-card:focus-visible" in css
