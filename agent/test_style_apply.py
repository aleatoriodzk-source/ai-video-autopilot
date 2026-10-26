"""Fase 3: perfis diferentes → parâmetros diferentes; legado/incompleto → comportamento antigo."""
import subprocess, tempfile
from pathlib import Path
import pytest
from style_apply import resolve_plan, structured_of

def T(v, basis="measured", conf="high"):
    return {"value": v, "basis": basis, "confidence": conf if v is not None else "none", "evidence": []} if v is not None else {"value": None, "basis": "not_analyzed", "confidence": "none", "evidence": []}

def prof(avg=2.0, motion="zoom_in", trans="cut", cap=("bottom", "inferred", "medium"), ratio=0.8, hits=((2.0, True), (5.0, False))):
    rule = lambda i: {"index": i, "motion": T(motion), "transition_in": T("start" if i == 0 else trans)}
    return {"version": 2, "metrics": {"avg_shot_s": T(avg), "duration_s": T(9.0), "sound_hits_on_cuts_ratio": T(ratio)},
            "visual": {"motion_default": T(motion), "transitions": T([trans])},
            "captions": {"position": T(cap[0], cap[1], cap[2]) if cap else T(None), "text_hex": T(None)},
            "timeline": [{"start_s": t, "end_s": t, "kind": "sfx", "data": {"on_cut": oc}, "basis": "measured"} for t, oc in hits],
            "scene_rules": [rule(i) for i in range(3)], "limitations": [{"feature": "retenção", "note": "não medida"}]}

SC = [{"idx": i, "motion": "zoom_in", "transition": "cut"} for i in range(4)]

def test_fast_vs_slow_profiles_differ():
    a, b = resolve_plan(prof(avg=1.2, motion="pan_left", trans="flash"), {}, SC), resolve_plan(prof(avg=4.5, motion="zoom_out", trans="cut"), {}, SC)
    assert a["cut_seconds"]["value"] == 1.2 and b["cut_seconds"]["value"] == 4.5
    assert {s["motion"]["value"] for s in a["scenes"]} == {"pan_left"} and {s["motion"]["value"] for s in b["scenes"]} == {"zoom_out"}
    assert a["scenes"][0]["transition"]["value"] == "flash" and b["scenes"][0]["transition"]["value"] == "cut"

def test_dip_to_black_maps_to_fade_and_clamps():
    p = resolve_plan(prof(avg=0.3, trans="dip_to_black"), {}, SC)
    assert p["cut_seconds"]["value"] == 0.8 and p["scenes"][0]["transition"]["value"] == "fade"

def test_caption_inferred_flagged_and_low_ignored():
    p = resolve_plan(prof(cap=("top", "inferred", "medium")), {}, SC)
    assert p["caption"]["value"]["clone"]["bottom_percent"] == 78 and p["caption"]["basis"] == "inferred"
    low = resolve_plan(prof(cap=("top", "inferred", "low")), {}, SC)
    assert low["caption"]["source"] == "default" and any("legenda" in l for l in low["limitations"])

def test_low_confidence_motion_not_applied():
    pr = prof(); pr["scene_rules"] = [{"index": 0, "motion": T("pan_right", "inferred", "low")}]; pr["visual"]["motion_default"] = T(None)
    assert resolve_plan(pr, {}, SC)["scenes"][0]["motion"]["source"] in ("scene", "default")

def test_static_measured_falls_back_with_limitation():
    p = resolve_plan(prof(motion="static"), {}, SC)
    assert p["scenes"][0]["motion"]["source"] != "profile" and any("static" in l for l in p["limitations"])

def test_sfx_from_measured_hits():
    v = resolve_plan(prof(), {}, SC)["sfx"]["value"]
    assert v["mode"] == "kit" and v["ref_s"] == 9.0 and [k["kind"] for k in v["kit"]] == ["whoosh", "impact"]

def test_user_instructions_win():
    sc = [dict(SC[0], status="edited", motion="pan_right", transition="fade")] + SC[1:]
    p = resolve_plan(prof(motion="zoom_out"), {"sfx": "off", "caption_style": "box", "cut_seconds": 3, "user_overrides": ["cut_seconds"]}, sc)
    assert p["scenes"][0]["motion"] == {"value": "pan_right", "source": "user", "basis": "explicit", "note": ""}
    assert p["scenes"][0]["transition"]["value"] == "fade" and p["scenes"][1]["motion"]["value"] == "zoom_out"
    assert p["sfx"]["value"]["mode"] == "off" and p["caption"]["value"]["style"] == "box" and p["cut_seconds"]["value"] == 3.0

def test_legacy_without_v2_keeps_old_behavior():
    legacy = {"profile": {"summary": "antigo", "caption_style": "neon"}}
    assert structured_of(legacy) is None
    s = {"cut_seconds": 2.2, "kit_motion": {"main_move": "pan_left", "moving_share": 0.6}, "kit_transitions": [{"at_s": 1, "kind": "flash"}], "caption_resolved": "neon"}
    p = resolve_plan(None, s, SC)
    assert not p["profile_used"] and p["cut_seconds"]["source"] == "legacy" and p["scenes"][0]["motion"]["value"] == "pan_left"
    assert p["scenes"][0]["transition"]["value"] == "flash" and p["caption"]["value"]["style"] == "neon"

def test_incomplete_profile_uses_defaults():
    pr = {"version": 2, "metrics": {}, "visual": {}, "captions": {}}
    assert structured_of({"profile": {"structured": pr}}) is pr
    p = resolve_plan(pr, {}, SC)
    assert p["cut_seconds"]["source"] == "default" and p["sfx"]["value"]["mode"] == "script" and len(p["limitations"]) >= 3

def test_real_forensics_output_drives_plan():
    import forensics
    d = Path(tempfile.mkdtemp())
    for i, (c, t) in enumerate([("red", 2), ("blue", 3), ("green", 1.5), ("white", 2.5)]):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"color={c}:s=360x640:r=30:d={t}", "-pix_fmt", "yuv420p", str(d / f"{i}.mp4")], check=True)
    (d / "l.txt").write_text("".join(f"file '{i}.mp4'\n" for i in range(4)))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(d / "l.txt"), "-c", "copy", str(d / "v.mp4")], check=True)
    pr = forensics.analyze(d / "v.mp4")
    p = resolve_plan(structured_of({"profile": {"structured": pr}}), {}, SC)
    print("PLANO_REAL", p["cut_seconds"], [s["transition"]["value"] for s in p["scenes"]], p["caption"]["source"])
    assert p["profile_used"] and p["cut_seconds"]["source"] == "profile" and abs(p["cut_seconds"]["value"] - 2.25) < 0.15
