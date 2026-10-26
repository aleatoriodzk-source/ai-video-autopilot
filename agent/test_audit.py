from audit import audit, scene_checks


def T(v, basis="measured", conf="high"):
    return {"value": v, "basis": basis, "confidence": conf, "evidence": []}


def prof(avg, motion="zoom_in", pos="bottom", wps=None, framing="full_frame"):
    return {"metrics": {"avg_shot_s": T(avg), "cuts_per_min_by_third": T([20, 20, 20]), "words_per_second": T(wps) if wps else T(None, "not_analyzed", "none")},
            "visual": {"motion_default": T(motion), "framing": T(framing)}, "captions": {"position": T(pos)}, "timeline": []}


def shots(*starts):
    return [{"kind": "shot", "start_s": s} for s in starts]


def test_rhythm_within_and_outside_tolerance():
    out = prof(2.4)
    assert {d["key"]: d["status"] for d in audit(prof(2.25), out, {}, [3])["dimensions"]}["cut_rhythm"] == "pass"
    out = prof(3.5)
    assert {d["key"]: d["status"] for d in audit(prof(2.25), out, {}, [3])["dimensions"]}["cut_rhythm"] == "deviation"


def test_no_reference_is_not_verified_never_pass():
    d = {x["key"]: x["status"] for x in audit(None, prof(2.0), {}, [3])["dimensions"]}
    assert d["cut_rhythm"] == d["motion"] == d["captions"] == "not_verified"


def test_inferred_motion_low_not_verified():
    ref = prof(2.0)
    ref["visual"]["motion_default"] = T("zoom_in", "inferred", "low")
    assert {x["key"]: x["status"] for x in audit(ref, prof(2.0), {}, [3])["dimensions"]}["motion"] == "not_verified"


def test_av_sync_detects_missing_boundary_cut():
    out = prof(2.0); out["timeline"] = shots(0, 3.0)
    d = {x["key"]: x for x in audit(prof(2.0), out, {}, [3, 3, 3])["dimensions"]}
    assert d["av_sync"]["status"] == "deviation" and "6.0" in d["av_sync"]["note"]


def test_scene_checks_flag_missing_internal_cut_and_black():
    out = {"timeline": shots(0, 3.5)}
    r = scene_checks(out, [3.5, 3.5], {0: {"pieces": [2.25, 1.25]}}, [(4.0, 5.0)])
    assert r[0]["issues"] and "cortes internos" in r[0]["issues"][0]
    assert r[1]["issues"] == ["quadros pretos: 1.00s"]


def test_letterbox_output_is_deviation():
    d = {x["key"]: x["status"] for x in audit(prof(2.0), prof(2.0, framing="letterbox"), {}, [3])["dimensions"]}
    assert d["framing"] == "deviation"
