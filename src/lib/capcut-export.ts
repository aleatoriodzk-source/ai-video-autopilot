/** Builds a CapCut-friendly package: SRT captions + a draft timeline JSON (scenes, times, media hints). */
export type ExportScene = { narration: string; caption: string; duration: number; media?: string | null };

const ts = (s: number) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(sec)},${p(r, 3)}`;
};

export function toSrt(scenes: ExportScene[]) {
  let t = 0;
  return scenes.map((s, i) => { const a = t; t += s.duration; return `${i + 1}\n${ts(a)} --> ${ts(t)}\n${(s.caption || s.narration).trim()}\n`; }).join("\n");
}

export function toDraft(scenes: ExportScene[], aspect: string, title: string) {
  const [w, h] = aspect === "16:9" ? [1920, 1080] : [1080, 1920];
  let t = 0;
  const US = 1_000_000;
  const segs = scenes.map((s, i) => { const start = t; t += s.duration; return { id: `scene-${i + 1}`, start_us: Math.round(start * US), duration_us: Math.round(s.duration * US), text: (s.caption || s.narration).trim(), narration: s.narration, media: s.media ?? null }; });
  return { name: title, canvas: { width: w, height: h, ratio: aspect }, duration_us: Math.round(t * US), tracks: [
    { type: "video", segments: segs.map(({ id, start_us, duration_us, media }) => ({ id, start_us, duration_us, media })) },
    { type: "text", segments: segs.map(({ id, start_us, duration_us, text }) => ({ id, start_us, duration_us, text })) },
  ] };
}

export function download(name: string, body: string, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
