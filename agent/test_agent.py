"""Testes essenciais. Os testes de render exigem FFmpeg no PATH (rodam no seu PC: .venv\\Scripts\\pytest)."""
import shutil
from pathlib import Path

import pytest

import media


def test_size_for_aspects():
    assert media.size_for("9:16") == (1080, 1920)
    assert media.size_for("16:9", "720p") == (1280, 720)


def test_word_timings_cover_speech():
    t = media.word_timings("um dois tres quatro cinco seis sete", 3.5, start=1.0)
    assert t[0]["start"] == 1.0
    assert abs(t[-1]["end"] - 4.5) < 0.01
    assert all(a["end"] <= b["start"] + 1e-6 for a, b in zip(t, t[1:]))


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg ausente")
def test_full_render_produces_valid_mp4(tmp_path: Path):
    w, h = media.size_for("9:16", "720p")
    img, wav = tmp_path / "img.png", tmp_path / "voice.wav"
    media.text_card("", w, h, img)
    media.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=2", "-ar", "48000", "-ac", "1", str(wav)])
    media.scene_clip(img, 2.0, w, h, 30, "zoom_in", tmp_path / "clip.mp4")
    media.write_ass(media.word_timings("teste de legenda sincronizada", 2.0), w, h, tmp_path / "subs.ass")
    media.final_mix(tmp_path / "clip.mp4", wav, "subs.ass", tmp_path / "final.mp4", tmp_path, None)
    rep = media.validate(tmp_path / "final.mp4", 2.0, w, h)
    assert rep["ok"], rep


def test_clean_tts_removes_emoji_and_symbols():
    import media
    out = media.clean_tts("🕵️‍♀️ O segredo § do mar ¶ (pausa) **é** 25%")
    assert out == "O segredo do mar é 25 por cento"
