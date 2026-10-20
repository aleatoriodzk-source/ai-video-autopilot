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


/** "DNA do formato": everything needed to recreate the format with brand-new content. */
export const formatDnaSchema = obj({
  niche: str,
  subniche: str,
  audience: str,
  promise: str,
  hook: obj({ type: str, first_line_pattern: str, seconds: num, why_it_works: str, templates: arr(str) }),
  structure: arr(obj({ part: str, percent: num, purpose: str, how: str })),
  narration: obj({ person: str, tone: str, words_per_second: num, sentence_length: str, rhetorical_devices: arr(str), vocabulary: str }),
  retention: arr(str),
  open_loops: arr(str),
  editing: obj({ cuts_per_min: num, zoom_usage: str, transitions: str, broll_ratio: str, overlays: str }),
  captions: obj({ style: str, words_per_line: num, emphasis: str }),
  audio: obj({ music: str, sfx: arr(str), voice: str }),
  visual_sources: arr(obj({ kind: str, best_source: str, example_query: str })),
  cta: str,
  title_pattern: str,
  do_list: arr(str),
  dont_list: arr(str),
  new_video_ideas: arr(str),
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
  video_comparison: arr(obj({ title: str, views: str, duration_s: num, avg_scene_s: num, hook: str, performance: enm("acima", "media", "abaixo", "sem_dados"), why: str })),
  common_patterns: arr(str),
  winning_formula: str,
  limitations: arr(str),
  format_dna: formatDnaSchema,
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
  format_dna: formatDnaSchema,
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
