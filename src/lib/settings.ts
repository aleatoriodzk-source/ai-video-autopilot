import type { Limits, Prices } from "./costs";

export type AppSettings = {
  voice: { provider: "piper" | "elevenlabs"; piper_voice: string; length_scale: number; sentence_silence: number; noise_scale: number; elevenlabs_voice_id: string };
  ai: { text_provider: "auto" | "gemini" | "openai" | "anthropic" | "lovable"; allow_ai_images: boolean; confirm_paid: boolean; image_model: string };
  visuals: { prefer: ("upload" | "pexels" | "ai_image")[]; avoid_repeat_window: number };
  export: { resolution: "720p" | "1080p"; fps: number; crf: number; music_volume_db: number; voice_target_lufs: number; output_dir: string };
  prices: Prices;
  limits: Limits;
};

export const DEFAULT_SETTINGS: AppSettings = {
  voice: { provider: "piper", piper_voice: "pt_BR-faber-medium", length_scale: 1.0, sentence_silence: 0.3, noise_scale: 0.667, elevenlabs_voice_id: "" },
  ai: { text_provider: "auto", allow_ai_images: false, confirm_paid: true, image_model: "lovable/image-fast" },
  visuals: { prefer: ["upload", "pexels", "ai_image"], avoid_repeat_window: 4 },
  export: { resolution: "1080p", fps: 30, crf: 20, music_volume_db: -20, voice_target_lufs: -16, output_dir: "" },
  prices: { ai_text_per_mtok: null, ai_image_each: null, tts_per_kchar: null },
  limits: { max_usd_per_task: null, max_usd_per_month: null, max_ai_images_per_video: 6 },
};

export function mergeSettings(data: unknown): AppSettings {
  const d = (data ?? {}) as Partial<AppSettings>;
  return {
    voice: { ...DEFAULT_SETTINGS.voice, ...(d.voice ?? {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(d.ai ?? {}) },
    visuals: { ...DEFAULT_SETTINGS.visuals, ...(d.visuals ?? {}) },
    export: { ...DEFAULT_SETTINGS.export, ...(d.export ?? {}) },
    prices: { ...DEFAULT_SETTINGS.prices, ...(d.prices ?? {}) },
    limits: { ...DEFAULT_SETTINGS.limits, ...(d.limits ?? {}) },
  };
}

export const PIPER_VOICES = [
  { id: "pt_BR-faber-medium", label: "Faber (masculina, média)" },
  { id: "pt_BR-cadu-medium", label: "Cadu (masculina, média)" },
  { id: "pt_BR-jeff-medium", label: "Jeff (masculina, média)" },
  { id: "pt_BR-edresson-low", label: "Edresson (masculina, baixa qualidade)" },
];
