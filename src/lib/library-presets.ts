// Catálogo inicial da Biblioteca. `ffmpeg` = filtro que o agente aplicará; `css` = prévia no navegador.
export type ColorPreset = { id: string; name: string; desc: string; css: string; ffmpeg: string };
export type CaptionPreset = { id: string; name: string; desc: string; font: string; color: string; highlight: string; box: boolean; upper: boolean };
export type SfxPreset = { id: string; name: string; kind: "whoosh" | "boom" | "riser" | "click" | "drop" };
export type MusicMood = { id: string; name: string; desc: string; duckDb: number };

export const COLORS: ColorPreset[] = [
  { id: "natural", name: "Natural", desc: "Sem tratamento", css: "none", ffmpeg: "" },
  { id: "sharp4k", name: "4K Ultra-Sharp", desc: "Nitidez de cinema", css: "contrast(1.12) saturate(1.1)", ffmpeg: "unsharp=5:5:1.0,eq=contrast=1.08:saturation=1.08" },
  { id: "noir", name: "Preto e Branco Noir", desc: "Dramático, alto contraste", css: "grayscale(1) contrast(1.35)", ffmpeg: "hue=s=0,eq=contrast=1.3" },
  { id: "teal", name: "Teal & Orange", desc: "Visual de blockbuster", css: "sepia(0.25) hue-rotate(-15deg) saturate(1.3) contrast(1.1)", ffmpeg: "colorbalance=rs=-0.1:bs=0.12:rh=0.12:bh=-0.1,eq=saturation=1.2" },
  { id: "moody", name: "Dark Moody", desc: "Sombrio, suspense", css: "brightness(0.82) contrast(1.2) saturate(0.8)", ffmpeg: "eq=brightness=-0.06:contrast=1.2:saturation=0.8" },
  { id: "bleach", name: "Bleach Bypass", desc: "Dessaturado e duro", css: "saturate(0.45) contrast(1.4)", ffmpeg: "eq=saturation=0.45:contrast=1.35" },
  { id: "vintage", name: "Vintage 35mm", desc: "Película antiga", css: "sepia(0.45) contrast(0.95) brightness(1.05)", ffmpeg: "curves=preset=vintage,noise=alls=8:allf=t" },
  { id: "pop", name: "Pop Saturado", desc: "Cores vivas", css: "saturate(1.6) contrast(1.08)", ffmpeg: "eq=saturation=1.55:contrast=1.06" },
];

export const CAPTIONS: CaptionPreset[] = [
  { id: "hormozi", name: "Hormozi Pop", desc: "Palavra ativa em destaque", font: "Montserrat", color: "#FFFFFF", highlight: "#FFE600", box: false, upper: true },
  { id: "dossie", name: "Dossiê / Doc", desc: "Tarja sólida séria", font: "Roboto Condensed", color: "#FFFFFF", highlight: "#FF3B3B", box: true, upper: false },
  { id: "minimal", name: "Minimalista", desc: "Limpo e elegante", font: "Inter", color: "#FFFFFF", highlight: "#FFFFFF", box: false, upper: false },
  { id: "capcut-bebas", name: "CapCut Bebas", desc: "Fonte viral de Shorts", font: "Bebas Neue", color: "#FFFFFF", highlight: "#FFE600", box: false, upper: true },
  { id: "capcut-anton", name: "CapCut Anton", desc: "Grossa e impactante", font: "Anton", color: "#FFFFFF", highlight: "#FF2E2E", box: false, upper: true },
  { id: "capcut-italic", name: "Montserrat Black Itálico", desc: "Estilo esporte/edit", font: "Montserrat", color: "#FFFFFF", highlight: "#00E5FF", box: false, upper: true },
  { id: "capcut-archivo", name: "Archivo Black", desc: "Pesada estilo CoreSans", font: "Archivo Black", color: "#FFFFFF", highlight: "#7CFF4F", box: false, upper: false },
  { id: "capcut-oswald", name: "Oswald Doc", desc: "Documentário dark", font: "Oswald", color: "#F5F5F5", highlight: "#FFB300", box: true, upper: true },
  { id: "neon", name: "Neon", desc: "Brilho ciano", font: "Bebas Neue", color: "#E8FFFF", highlight: "#00F0FF", box: false, upper: true },
];

export const SFX: SfxPreset[] = [
  { id: "whoosh", name: "Whoosh de transição", kind: "whoosh" },
  { id: "boom", name: "Boom dramático", kind: "boom" },
  { id: "drop", name: "Bass Drop", kind: "drop" },
  { id: "riser", name: "Riser de tensão", kind: "riser" },
  { id: "click", name: "Click", kind: "click" },
];

export const MUSIC: MusicMood[] = [
  { id: "suspense", name: "Suspense / Investigação", desc: "Tensão contínua", duckDb: -18 },
  { id: "epic", name: "Ação / Épico", desc: "Clímax e impacto", duckDb: -18 },
  { id: "curious", name: "Curiosidades", desc: "Leve e rápido", duckDb: -20 },
];

export type LibraryChoice = { color: string; caption: string; sfx: string[]; music: string; duckDb: number };
export const DEFAULT_CHOICE: LibraryChoice = { color: "natural", caption: "hormozi", sfx: ["whoosh", "boom"], music: "suspense", duckDb: -18 };
