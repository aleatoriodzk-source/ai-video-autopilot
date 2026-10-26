/**
 * Perfil de Estilo Estruturado (v2) — "DNA de edição" reutilizável.
 * Fica dentro da coluna JSON já existente `style_profiles.profile`; nenhum campo legado é apagado.
 * Cada valor carrega sua origem (medido / inferido / padrão / não analisado) e uma confiança
 * por rubrica de evidência (alta/média/baixa) — nunca porcentagem fingindo probabilidade.
 */

export const STYLE_PROFILE_VERSION = 2 as const;

export type Basis = "measured" | "inferred" | "default" | "not_analyzed";
export type Confidence = "high" | "medium" | "low" | "none";

export type Trait<T> = {
  value: T | null;
  basis: Basis;
  confidence: Confidence;
  /** Como o valor foi obtido (ex.: "ffmpeg scene>0.3", "5 frames de legenda"). */
  evidence: string[];
};

export type TimelineEvent = {
  start_s: number;
  end_s: number;
  kind: "cut" | "shot" | "caption" | "sfx" | "music" | "motion" | "transition" | "speech" | "other";
  data: Record<string, unknown>;
  basis: Basis;
};

export type SceneRule = {
  index: number;
  duration_s: Trait<number>;
  aspect: Trait<string>;
  motion: Trait<string>;
  transition_in: Trait<string>;
  caption_style: Trait<string>;
  sfx: Trait<string>;
  media_kind: Trait<string>;
};

export type Limitation = {
  feature: string;
  reason: "sampling_insufficient" | "low_resolution" | "unsupported_effect" | "no_data" | "other";
  note: string;
};

export type StructuredStyleProfile = {
  version: typeof STYLE_PROFILE_VERSION;
  source: { reference_id: string | null; analysis_id: string | null; migrated_from_legacy: boolean };
  /** Métricas objetivas medidas do arquivo (FFmpeg/OpenCV). Ritmo de edição, não retenção de público. */
  metrics: {
    duration_s: Trait<number>;
    cuts_per_min: Trait<number>;
    cuts_per_min_by_third: Trait<[number, number, number]>;
    avg_shot_s: Trait<number>;
    words_per_second: Trait<number>;
    sound_hits_on_cuts_ratio: Trait<number>;
  };
  visual: {
    aspect_mix: Trait<string[]>;
    framing: Trait<string>;
    motion_default: Trait<string>;
    motion_intensity: Trait<number>;
    transitions: Trait<string[]>;
    color_grade: Trait<string>;
    media_rule: Trait<string>;
  };
  captions: {
    font: Trait<string>;
    text_hex: Trait<string>;
    highlight_hex: Trait<string>;
    outline_hex: Trait<string>;
    position: Trait<string>;
    animation: Trait<string>;
    words_per_line: Trait<number>;
    uppercase: Trait<boolean>;
    font_size: Trait<number>;
  };
  audio: {
    music_mood: Trait<string>;
    music_volume_db: Trait<number>;
    sfx_kinds: Trait<string[]>;
  };
  narrative: {
    tone: Trait<string>;
    hook_patterns: Trait<string[]>;
    structure: Trait<string[]>;
    cta_style: Trait<string>;
  };
  timeline: TimelineEvent[];
  scene_rules: SceneRule[];
  limitations: Limitation[];
};

const BASES: Basis[] = ["measured", "inferred", "default", "not_analyzed"];
const CONFS: Confidence[] = ["high", "medium", "low", "none"];

export function trait<T>(value: T | null, basis: Basis = value == null ? "not_analyzed" : "inferred", confidence?: Confidence, evidence: string[] = []): Trait<T> {
  const conf = confidence ?? (basis === "measured" ? "high" : basis === "inferred" ? "low" : "none");
  return { value, basis, confidence: value == null ? "none" : conf, evidence };
}
const na = <T,>(): Trait<T> => trait<T>(null, "not_analyzed", "none");

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const numOr = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const boolOr = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const strArr = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

function readTrait<T>(raw: unknown, check: (v: unknown) => T | null): Trait<T> {
  if (!isObj(raw)) return na<T>();
  const value = check(raw.value);
  const basis = BASES.includes(raw.basis as Basis) ? (raw.basis as Basis) : value == null ? "not_analyzed" : "inferred";
  const confidence = CONFS.includes(raw.confidence as Confidence) ? (raw.confidence as Confidence) : undefined;
  return trait<T>(value, value == null ? "not_analyzed" : basis, confidence, strArr(raw.evidence) ?? []);
}

const thirds = (v: unknown): [number, number, number] | null =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as [number, number, number]) : null;

export function emptyProfile(): StructuredStyleProfile {
  return {
    version: STYLE_PROFILE_VERSION,
    source: { reference_id: null, analysis_id: null, migrated_from_legacy: false },
    metrics: { duration_s: na(), cuts_per_min: na(), cuts_per_min_by_third: na(), avg_shot_s: na(), words_per_second: na(), sound_hits_on_cuts_ratio: na() },
    visual: { aspect_mix: na(), framing: na(), motion_default: na(), motion_intensity: na(), transitions: na(), color_grade: na(), media_rule: na() },
    captions: { font: na(), text_hex: na(), highlight_hex: na(), outline_hex: na(), position: na(), animation: na(), words_per_line: na(), uppercase: na(), font_size: na() },
    audio: { music_mood: na(), music_volume_db: na(), sfx_kinds: na() },
    narrative: { tone: na(), hook_patterns: na(), structure: na(), cta_style: na() },
    timeline: [],
    scene_rules: [],
    limitations: [],
  };
}

/** Converte o perfil antigo (StyleProfile gerado pela IA) — tudo marcado como inferido, confiança baixa. */
export function fromLegacy(legacy: unknown): StructuredStyleProfile {
  const p = emptyProfile();
  p.source.migrated_from_legacy = true;
  if (!isObj(legacy)) return p;
  const inf = <T,>(v: T | null) => trait<T>(v, v == null ? "not_analyzed" : "inferred", v == null ? "none" : "low", v == null ? [] : ["perfil legado gerado por IA"]);
  const c = isObj(legacy.captions) ? legacy.captions : {};
  const pa = isObj(legacy.pacing) ? legacy.pacing : {};
  const mo = isObj(legacy.motion) ? legacy.motion : {};
  const mu = isObj(legacy.music) ? legacy.music : {};
  p.metrics.cuts_per_min = inf(numOr(pa.cuts_per_min));
  p.metrics.avg_shot_s = inf(numOr(pa.avg_scene_s));
  p.visual.motion_default = inf(strOr(mo.default));
  p.visual.motion_intensity = inf(numOr(mo.intensity));
  p.visual.transitions = inf(strArr(legacy.transitions));
  p.captions = {
    font: inf(strOr(c.font)), text_hex: inf(strOr(c.color_hex)), highlight_hex: inf(strOr(c.highlight_hex)),
    outline_hex: inf(strOr(c.outline_hex)), position: inf(strOr(c.position)), animation: inf(strOr(c.animation)),
    words_per_line: inf(numOr(c.words_per_line)), uppercase: inf(boolOr(c.uppercase)), font_size: inf(numOr(c.font_size)),
  };
  p.audio.music_mood = inf(strOr(mu.mood));
  p.audio.music_volume_db = inf(numOr(mu.volume_db));
  p.narrative = { tone: inf(strOr(legacy.tone)), hook_patterns: inf(strArr(legacy.hook_patterns)), structure: inf(strArr(legacy.script_structure)), cta_style: inf(strOr(legacy.cta_style)) };
  p.limitations.push({ feature: "métricas temporais", reason: "no_data", note: "Perfil antigo: valores estimados por IA, sem medição FFmpeg." });
  return p;
}

const isV2 = (raw: unknown): raw is Obj => isObj(raw) && raw.version === STYLE_PROFILE_VERSION;

/** Valida um perfil v2 campo a campo; campos ausentes/inválidos viram "não analisado". */
export function parseStructured(raw: Obj): StructuredStyleProfile {
  const p = emptyProfile();
  const sec = (k: string) => (isObj(raw[k]) ? (raw[k] as Obj) : {});
  const src = sec("source");
  p.source = { reference_id: strOr(src.reference_id), analysis_id: strOr(src.analysis_id), migrated_from_legacy: src.migrated_from_legacy === true };
  const m = sec("metrics"), v = sec("visual"), c = sec("captions"), a = sec("audio"), n = sec("narrative");
  p.metrics = {
    duration_s: readTrait(m.duration_s, numOr), cuts_per_min: readTrait(m.cuts_per_min, numOr),
    cuts_per_min_by_third: readTrait(m.cuts_per_min_by_third, thirds), avg_shot_s: readTrait(m.avg_shot_s, numOr),
    words_per_second: readTrait(m.words_per_second, numOr), sound_hits_on_cuts_ratio: readTrait(m.sound_hits_on_cuts_ratio, numOr),
  };
  p.visual = {
    aspect_mix: readTrait(v.aspect_mix, strArr), framing: readTrait(v.framing, strOr), motion_default: readTrait(v.motion_default, strOr),
    motion_intensity: readTrait(v.motion_intensity, numOr), transitions: readTrait(v.transitions, strArr),
    color_grade: readTrait(v.color_grade, strOr), media_rule: readTrait(v.media_rule, strOr),
  };
  p.captions = {
    font: readTrait(c.font, strOr), text_hex: readTrait(c.text_hex, strOr), highlight_hex: readTrait(c.highlight_hex, strOr),
    outline_hex: readTrait(c.outline_hex, strOr), position: readTrait(c.position, strOr), animation: readTrait(c.animation, strOr),
    words_per_line: readTrait(c.words_per_line, numOr), uppercase: readTrait(c.uppercase, boolOr), font_size: readTrait(c.font_size, numOr),
  };
  p.audio = { music_mood: readTrait(a.music_mood, strOr), music_volume_db: readTrait(a.music_volume_db, numOr), sfx_kinds: readTrait(a.sfx_kinds, strArr) };
  p.narrative = { tone: readTrait(n.tone, strOr), hook_patterns: readTrait(n.hook_patterns, strArr), structure: readTrait(n.structure, strArr), cta_style: readTrait(n.cta_style, strOr) };
  p.timeline = (Array.isArray(raw.timeline) ? raw.timeline : []).filter(isObj).flatMap((e) => {
    const s = numOr(e.start_s), en = numOr(e.end_s);
    if (s == null || en == null || en < s || s < 0) return [];
    return [{ start_s: s, end_s: en, kind: (strOr(e.kind) ?? "other") as TimelineEvent["kind"], data: isObj(e.data) ? e.data : {}, basis: BASES.includes(e.basis as Basis) ? (e.basis as Basis) : "inferred" }];
  });
  p.scene_rules = (Array.isArray(raw.scene_rules) ? raw.scene_rules : []).filter(isObj).flatMap((r) => {
    const index = numOr(r.index);
    if (index == null || index < 0) return [];
    return [{
      index, duration_s: readTrait(r.duration_s, numOr), aspect: readTrait(r.aspect, strOr), motion: readTrait(r.motion, strOr),
      transition_in: readTrait(r.transition_in, strOr), caption_style: readTrait(r.caption_style, strOr), sfx: readTrait(r.sfx, strOr), media_kind: readTrait(r.media_kind, strOr),
    }];
  });
  p.limitations = (Array.isArray(raw.limitations) ? raw.limitations : []).filter(isObj).flatMap((l) => {
    const feature = strOr(l.feature);
    return feature ? [{ feature, reason: (strOr(l.reason) ?? "other") as Limitation["reason"], note: strOr(l.note) ?? "" }] : [];
  });
  return p;
}

/**
 * Lê qualquer conteúdo de `style_profiles.profile`: v2 é validado; legado é convertido; lixo vira perfil vazio.
 * Pura e sem efeitos — nunca escreve no banco.
 */
export function readStyleProfile(raw: unknown): StructuredStyleProfile {
  if (isV2(raw)) return parseStructured(raw);
  if (isObj(raw) && isObj(raw.structured) && isV2(raw.structured)) return parseStructured(raw.structured);
  return fromLegacy(raw);
}

/**
 * Monta o JSON a gravar mantendo os campos legados intactos (leitores antigos continuam funcionando)
 * e acrescentando o perfil estruturado em `structured`.
 */
export function withStructured(legacy: unknown, structured: StructuredStyleProfile): Record<string, unknown> {
  const base = isObj(legacy) && !isV2(legacy) ? { ...legacy } : {};
  return { ...base, structured };
}
