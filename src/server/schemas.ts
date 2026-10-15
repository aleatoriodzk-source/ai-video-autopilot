// Strict JSON schemas for AI outputs (all props required, no extra props).
type S = Record<string, unknown>;
const str: S = { type: "string" };
const num: S = { type: "number" };
const bool: S = { type: "boolean" };
const arr = (items: S): S => ({ type: "array", items });
const obj = (props: Record<string, S>): S => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const enm = (...v: string[]): S => ({ type: "string", enum: v });

/** A finding with its evidence basis so estimates are never presented as data. */
const finding = obj({ value: str, basis: enm("dados", "estimativa", "indisponivel") });

export const styleProfileSchema = obj({
  captions: obj({ font: str, color_hex: str, highlight_hex: str, outline_hex: str, position: enm("top", "center", "bottom"), animation: enm("word_pop", "karaoke", "fade", "static"), words_per_line: num, uppercase: bool, font_size: num }),
  pacing: obj({ avg_scene_s: num, cuts_per_min: num }),
  motion: obj({ default: enm("zoom_in", "zoom_out", "pan_left", "pan_right", "static"), intensity: num }),
  transitions: arr(enm("cut", "fade", "slideleft", "slideright", "zoomin", "circleopen")),
  music: obj({ mood: str, volume_db: num }),
  hook_patterns: arr(str),
  script_structure: arr(str),
  cta_style: str,
  tone: str,
});

export const channelAnalysisSchema = obj({
  niche: finding,
  subniches: arr(str),
  audience: finding,
  recurring_themes: arr(str),
  hook_types: arr(str),
  script_structure: finding,
  avg_duration: finding,
  editing_pace: finding,
  cuts_frequency: finding,
  caption_style: finding,
  visual_assets_usage: finding,
  sound_usage: finding,
  camera_moves: finding,
  narrative_retention: finding,
  titles_thumbnails_cta: finding,
  best_vs_worst: finding,
  limitations: arr(str),
  style_profile: styleProfileSchema,
});

export const shortAnalysisSchema = obj({
  scenes: arr(obj({ start_s: num, end_s: num, description: str, visual_change: str, caption: str, motion: str, transition: str, overlays: str })),
  caption_sync: finding,
  dynamic_caption_style: finding,
  zoom_effects: finding,
  transitions_overlays: finding,
  rhythm: finding,
  hook_and_story: finding,
  signature_elements: arr(str),
  limitations: arr(str),
  style_profile: styleProfileSchema,
});

export const ideasSchema = obj({
  ideas: arr(obj({ title: str, hook: str, angle: str, why_fits: str, factual: bool })),
});

export const scriptSchema = obj({
  title: str,
  hook: str,
  scenes: arr(
    obj({
      narration: str,
      caption: str,
      visual_description: str,
      visual_query: str,
      pause_after_ms: num,
      sfx: str,
      pacing: enm("lento", "normal", "rapido"),
      motion: enm("zoom_in", "zoom_out", "pan_left", "pan_right", "static"),
      transition: enm("cut", "fade", "slideleft", "slideright", "zoomin", "circleopen"),
    }),
  ),
  cta: str,
  references: arr(obj({ claim: str, how_to_verify: str })),
  notes: str,
});

export type StyleProfile = {
  captions: { font: string; color_hex: string; highlight_hex: string; outline_hex: string; position: string; animation: string; words_per_line: number; uppercase: boolean; font_size: number };
  pacing: { avg_scene_s: number; cuts_per_min: number };
  motion: { default: string; intensity: number };
  transitions: string[];
  music: { mood: string; volume_db: number };
  hook_patterns: string[];
  script_structure: string[];
  cta_style: string;
  tone: string;
};

export type ScriptOut = {
  title: string;
  hook: string;
  scenes: { narration: string; caption: string; visual_description: string; visual_query: string; pause_after_ms: number; sfx: string; pacing: string; motion: string; transition: string }[];
  cta: string;
  references: { claim: string; how_to_verify: string }[];
  notes: string;
};
