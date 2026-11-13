import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type VideoOpts = { voice: string; voice_rate: string; caption_style: string; sfx: "on" | "off"; music: string };
export const defaultOpts: VideoOpts = { voice: "pt-BR-AntonioNeural", voice_rate: "+10%", caption_style: "auto", sfx: "on", music: "auto" };

const EDGE = [
  ["pt-BR-AntonioNeural", "Antonio (masculina, firme)"],
  ["pt-BR-FranciscaNeural", "Francisca (feminina, clara)"],
  ["pt-BR-ThalitaMultilingualNeural", "Thalita (feminina, jovem)"],
];

/** Converts the chosen options into production settings understood by the PC agent. */
export function optsToSettings(o: VideoOpts, kitMusicPath?: string | null) {
  const voice = o.voice.startsWith("clone:") ? { voice_id: o.voice.slice(6) } : { voice: o.voice, voice_rate: o.voice_rate };
  const music = o.music.startsWith("lib:") ? { music_path: o.music.slice(4), music_mood: "auto" }
    : o.music === "kit" && kitMusicPath ? { music_path: kitMusicPath, music_mood: "auto" } : { music_mood: o.music === "none" ? "none" : "auto" };
  return { ...voice, ...music, caption_style: o.caption_style, sfx: o.sfx };
}

const sel = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

export function VideoOptions({ value, onChange, kitMusic }: { value: VideoOpts; onChange: (v: VideoOpts) => void; kitMusic?: boolean }) {
  const { data: clones } = useQuery({
    queryKey: ["ready-voices"],
    queryFn: async () => (await supabase.from("voices").select("id,name").eq("status", "ready").order("created_at", { ascending: false })).data ?? [],
  });
  const { data: tracks } = useQuery({
    queryKey: ["lib-music"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return [];
      const dir = `${u.user.id}/biblioteca/musica`;
      const { data } = await supabase.storage.from("media").list(dir);
      return (data ?? []).filter((f) => f.name && !f.name.startsWith(".")).map((f) => ({ path: `${dir}/${f.name}`, name: f.name.replace(/^\d+-/, "").replace(/\.[^.]+$/, "") }));
    },
  });
  const set = (k: keyof VideoOpts, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="space-y-1 text-xs text-muted-foreground">Voz
        <select className={sel} value={value.voice} onChange={(e) => set("voice", e.target.value)}>
          {(clones ?? []).length > 0 && <optgroup label="Vozes clonadas">{clones!.map((c) => <option key={c.id} value={`clone:${c.id}`}>{c.name}</option>)}</optgroup>}
          <optgroup label="Vozes prontas">{EDGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</optgroup>
        </select>
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">Velocidade da fala
        <select className={sel} value={value.voice_rate} disabled={value.voice.startsWith("clone:")} onChange={(e) => set("voice_rate", e.target.value)}>
          {["+0%", "+5%", "+10%", "+15%", "+20%"].map((r) => <option key={r} value={r}>{r === "+0%" ? "Normal" : r}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">Legenda
        <select className={sel} value={value.caption_style} onChange={(e) => set("caption_style", e.target.value)}>
          <option value="auto">Igual à referência</option><option value="karaoke">Karaokê (palavra falada acende)</option><option value="box">Caixa escura</option><option value="hormozi">Amarelo forte (Hormozi)</option><option value="neon">Verde neon (CapCut)</option><option value="red">Vermelho impacto</option><option value="clean">Branco minimalista</option><option value="none">Sem legenda</option>
        </select>
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">Música de fundo
        <select className={sel} value={value.music} onChange={(e) => set("music", e.target.value)}>
          {kitMusic && <option value="kit">Música isolada do vídeo de referência</option>}
          <option value="auto">Automática pelo clima do vídeo</option>
          {(tracks ?? []).map((t) => <option key={t.path} value={`lib:${t.path}`}>Minha trilha: {t.name}</option>)}
          <option value="none">Sem música</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={value.sfx === "on"} onChange={(e) => set("sfx", e.target.checked ? "on" : "off")} /> Efeitos sonoros nos cortes
      </label>
    </div>
  );
}

/** Troca a voz de uma produção já criada (antes de iniciar ou refazer). */
export function VoicePicker({ productionId, settings, onSaved }: { productionId: string; settings: Record<string, unknown> | null; onSaved?: () => void }) {
  const { data: clones } = useQuery({
    queryKey: ["ready-voices"],
    queryFn: async () => (await supabase.from("voices").select("id,name").eq("status", "ready").order("created_at", { ascending: false })).data ?? [],
  });
  const cur = settings?.["voice_id"] ? `clone:${settings["voice_id"]}` : String(settings?.["voice"] ?? defaultOpts.voice);
  async function save(v: string) {
    const next: Record<string, unknown> = { ...(settings ?? {}) };
    if (v.startsWith("clone:")) { next["voice_id"] = v.slice(6); delete next["voice"]; } else { next["voice"] = v; delete next["voice_id"]; }
    await supabase.from("productions").update({ settings: next as never }).eq("id", productionId);
    onSaved?.();
  }
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">Voz da narração
      <select className={sel + " w-auto"} value={cur} onChange={(e) => save(e.target.value)}>
        {(clones ?? []).length > 0 && <optgroup label="Vozes clonadas">{clones!.map((c) => <option key={c.id} value={`clone:${c.id}`}>{c.name}</option>)}</optgroup>}
        <optgroup label="Vozes prontas">{EDGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</optgroup>
      </select>
    </label>
  );
}
