import { describe, expect, it } from "vitest";
import { emptyProfile, fromLegacy, readStyleProfile, STYLE_PROFILE_VERSION, trait, withStructured } from "@/lib/style-profile";

const legacy = {
  captions: { font: "Montserrat", color_hex: "#FFFFFF", highlight_hex: "#FFD400", outline_hex: "#000000", position: "bottom", animation: "word_pop", words_per_line: 3, uppercase: true, font_size: 72 },
  pacing: { avg_scene_s: 2.1, cuts_per_min: 28 },
  motion: { default: "zoom_in", intensity: 0.4 },
  transitions: ["cut", "fade"],
  music: { mood: "suspense", volume_db: -18 },
  hook_patterns: ["pergunta"],
  script_structure: ["gancho", "desenvolvimento", "cta"],
  cta_style: "siga",
  tone: "misterioso",
};

describe("perfil legado", () => {
  it("converte valores antigos marcando como inferidos com confiança baixa", () => {
    const p = readStyleProfile(legacy);
    expect(p.version).toBe(2);
    expect(p.source.migrated_from_legacy).toBe(true);
    expect(p.metrics.cuts_per_min).toMatchObject({ value: 28, basis: "inferred", confidence: "low" });
    expect(p.captions.uppercase.value).toBe(true);
    expect(p.visual.transitions.value).toEqual(["cut", "fade"]);
  });
  it("nunca marca valor legado como medido", () => {
    const p = fromLegacy(legacy);
    const all = [...Object.values(p.metrics), ...Object.values(p.captions), ...Object.values(p.visual)];
    expect(all.some((t) => t.basis === "measured")).toBe(false);
  });
  it("campos ausentes viram 'não analisado' sem quebrar", () => {
    const p = readStyleProfile({ pacing: {} });
    expect(p.metrics.cuts_per_min).toMatchObject({ value: null, basis: "not_analyzed", confidence: "none" });
    expect(p.metrics.duration_s.basis).toBe("not_analyzed");
  });
  it("conteúdo inválido (null, texto) devolve perfil vazio seguro", () => {
    expect(readStyleProfile(null).metrics.cuts_per_min.value).toBeNull();
    expect(readStyleProfile("lixo").timeline).toEqual([]);
  });
});

describe("perfil v2", () => {
  it("ida e volta preserva métricas, linha do tempo, regras por cena e limitações", () => {
    const p = emptyProfile();
    p.metrics.cuts_per_min = trait(31.5, "measured", "high", ["ffmpeg scene>0.3"]);
    p.metrics.cuts_per_min_by_third = trait<[number, number, number]>([40, 28, 25], "measured");
    p.timeline.push({ start_s: 0, end_s: 1.8, kind: "shot", data: { aspect: "9:16" }, basis: "measured" });
    p.scene_rules.push({ ...emptyProfile().scene_rules[0], index: 0, duration_s: trait(1.8, "measured"), aspect: trait("9:16", "measured"), motion: trait("zoom_in", "inferred", "medium"), transition_in: trait("cut", "measured"), caption_style: trait<string>(null), sfx: trait("whoosh", "inferred"), media_kind: trait("image", "inferred") });
    p.limitations.push({ feature: "efeito 3D", reason: "unsupported_effect", note: "aproximado por 2D" });
    const back = readStyleProfile(JSON.parse(JSON.stringify(p)));
    expect(back).toEqual(p);
  });
  it("valor medido sem confiança explícita recebe confiança alta; inferido recebe baixa", () => {
    expect(trait(10, "measured").confidence).toBe("high");
    expect(trait("x", "inferred").confidence).toBe("low");
  });
  it("descarta eventos de linha do tempo com tempos inválidos", () => {
    const raw = { version: STYLE_PROFILE_VERSION, timeline: [{ start_s: 5, end_s: 2, kind: "cut" }, { start_s: -1, end_s: 1 }, { start_s: 1, end_s: 2, kind: "cut" }] };
    expect(readStyleProfile(raw).timeline).toHaveLength(1);
  });
  it("valor com tipo errado é rejeitado e vira não analisado", () => {
    const raw = { version: 2, metrics: { cuts_per_min: { value: "muitos", basis: "measured", confidence: "high" } } };
    expect(readStyleProfile(raw).metrics.cuts_per_min).toMatchObject({ value: null, basis: "not_analyzed", confidence: "none" });
  });
});

describe("compatibilidade de gravação", () => {
  it("mantém campos legados intactos ao acrescentar o perfil estruturado", () => {
    const out = withStructured(legacy, fromLegacy(legacy));
    expect(out.captions).toEqual(legacy.captions);
    expect(out.pacing).toEqual(legacy.pacing);
    expect(readStyleProfile(out).source.migrated_from_legacy).toBe(true);
  });
});
