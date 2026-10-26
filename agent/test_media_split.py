from media import MIN_PIECE_S, split_plan


def test_short_scene_now_split():
    p, why = split_plan(3.5, 2.25, 8)
    assert p == [2.25, 1.25] and "2 planos" in why


def test_sum_equals_narration():
    for d in (3.5, 4.1, 5.0, 7.3):
        p, _ = split_plan(d, 2.25, 10)
        assert abs(sum(p) - d) < 1e-6 and min(p) >= MIN_PIECE_S


def test_remainder_merged():
    assert split_plan(5.0, 2.25, 10)[0] == [2.25, 2.75]


def test_too_short_records_reason():
    p, why = split_plan(2.8, 2.25, 10)
    assert p == [2.8] and "menor que alvo" in why


def test_no_target_and_short_source():
    assert split_plan(3.5, 0, 10) == ([3.5], "sem duração-alvo de plano")
    p, why = split_plan(3.5, 2.25, 1.0)
    assert p == [3.5] and "fonte" in why


def test_different_targets_differ():
    assert split_plan(6, 1.5, 10)[0] == [1.5] * 4
    assert split_plan(6, 3.0, 10)[0] == [3.0, 3.0]
