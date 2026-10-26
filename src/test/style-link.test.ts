import { describe, expect, it } from "vitest";
import { emptyProfile, trait } from "@/lib/style-profile";
import { pickStructured, profileToSave, resolveStyleLink, type StyleCandidate } from "@/lib/style-link";

const A = "user-a", B = "user-b", R = "ref-1";
const v2 = () => ({ ...emptyProfile(), metrics: { ...emptyProfile().metrics, avg_shot_s: trait(2.25, "measured", "high") } });
const cand = (id: string, user: string, ref: string, structured = true): StyleCandidate => ({ id, user_id: user, profile: structured ? { tone: "x", structured: v2() } : { tone: "x" }, analyses: { reference_id: ref, user_id: user } });
const prod = { user_id: A, style_id: null, reference_id: R };

describe("perfil v2 na análise", () => {
  it("pega o perfil v2 da coleta e marca referência/análise", () => {
    const p = pickStructured({ videos: [{ structured: null }, { structured: v2() }] }, { referenceId: R, analysisId: "an" });
    expect(p?.metrics.avg_shot_s.value).toBe(2.25);
    expect(p?.source).toEqual({ reference_id: R, analysis_id: "an", migrated_from_legacy: false });
  });
  it("sem v2 na coleta, grava o legado sem mudanças", () => {
    const legacy = { tone: "calmo" };
    expect(pickStructured({ videos: [{}] }, { referenceId: R, analysisId: "an" })).toBeNull();
    expect(profileToSave(legacy, null)).toBe(legacy);
  });
  it("com v2, mantém todos os campos legados", () => {
    const legacy = { tone: "calmo", captions: { position: "bottom" } };
    const out = profileToSave(legacy, v2()) as Record<string, unknown>;
    expect(out["tone"]).toBe("calmo");
    expect(out["captions"]).toEqual({ position: "bottom" });
    expect(out["structured"]).toBeTruthy();
  });
});

describe("associação produção → perfil", () => {
  it("associa o único perfil do mesmo usuário e mesma referência", () => {
    expect(resolveStyleLink(prod, [cand("ok", A, R), cand("x", B, R), cand("y", A, "ref-2"), cand("z", A, R, false)])).toEqual({ styleId: "ok", reason: "matched" });
  });
  it("nunca usa perfil de outro usuário", () => {
    expect(resolveStyleLink(prod, [cand("x", B, R)]).styleId).toBeNull();
  });
  it("nunca usa perfil de outra referência", () => {
    expect(resolveStyleLink(prod, [cand("y", A, "ref-2")]).styleId).toBeNull();
  });
  it("ambíguo não associa", () => {
    expect(resolveStyleLink(prod, [cand("a", A, R), cand("b", A, R)])).toEqual({ styleId: null, reason: "ambiguous" });
  });
  it("mantém style_id existente e ignora produção sem referência", () => {
    expect(resolveStyleLink({ ...prod, style_id: "s" }, [cand("a", A, R)]).styleId).toBe("s");
    expect(resolveStyleLink({ ...prod, reference_id: null }, [cand("a", A, R)]).reason).toBe("no_reference");
  });
});
