import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { xrayVideo, type Xray } from "@/lib/lab.functions";
import { generateScript } from "@/lib/ai.functions";

type Saved = { id: string; title: string; duration: number; at: number; xray: Xray };
const KEY = "lab_xrays_v1";
const btn = "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const ghost = "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50";

function seek(v: HTMLVideoElement, t: number) {
  return new Promise<void>((res) => {
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done);
    v.currentTime = t;
    setTimeout(done, 3000);
  });
}

/** Watches the video in the browser: detects cuts and grabs key frames for the AI. */
async function watch(src: string, onP: (p: number) => void) {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous"; v.muted = true; v.preload = "auto"; v.src = src;
  await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error("Não consegui abrir o vídeo")); });
  const dur = v.duration || 1;
  const tiny = document.createElement("canvas"); tiny.width = 24; tiny.height = 24;
  const tc = tiny.getContext("2d", { willReadFrequently: true })!;
  const big = document.createElement("canvas");
  const w = 360; big.width = w; big.height = Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth));
  const bc = big.getContext("2d")!;
  const step = Math.max(0.4, dur / 240);
  const want = Math.min(32, Math.max(8, Math.round(dur / 2)));
  const every = dur / want;
  let prev: Uint8ClampedArray | null = null;
  const cuts: number[] = [];
  const frames: { t: number; img: string }[] = [];
  let nextGrab = 0;
  for (let t = 0; t < dur; t += step) {
    await seek(v, t);
    tc.drawImage(v, 0, 0, 24, 24);
    const d = tc.getImageData(0, 0, 24, 24).data;
    let cut = false;
    if (prev) {
      let s = 0; for (let k = 0; k < d.length; k += 4) s += Math.abs(d[k]! - prev[k]!) + Math.abs(d[k + 1]! - prev[k + 1]!) + Math.abs(d[k + 2]! - prev[k + 2]!);
      if (s / (576 * 3) > 38) { cuts.push(t); cut = true; }
    }
    prev = d;
    if (t >= nextGrab || (cut && frames.length < 40)) {
      bc.drawImage(v, 0, 0, big.width, big.height);
      frames.push({ t, img: big.toDataURL("image/jpeg", 0.6) });
      nextGrab = t + every;
    }
    onP(Math.min(99, Math.round((t / dur) * 100)));
  }
  const pick = frames.length > 40 ? frames.filter((_, k) => k % Math.ceil(frames.length / 40) === 0) : frames;
  return { dur, cuts, frames: pick };
}

export function LabXray() {
  const nav = useNavigate();
  const [src, setSrc] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(0);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [cur, setCur] = useState<Saved | null>(null);
  const [topic, setTopic] = useState("");
  const [now, setNow] = useState(0);
  const player = useRef<HTMLVideoElement>(null);

  useEffect(() => { try { setSaved(JSON.parse(localStorage.getItem(KEY) ?? "[]")); } catch { /* vazio */ } }, []);
  const persist = (l: Saved[]) => { setSaved(l); localStorage.setItem(KEY, JSON.stringify(l.slice(0, 30))); };

  const { data: refs } = useQuery({
    queryKey: ["lab-xray-refs"],
    queryFn: async () => {
      const { data } = await supabase.from("reference_sources").select("id,title,urls,created_at").order("created_at", { ascending: false }).limit(60);
      return (data ?? []).filter((r) => (r.urls ?? []).some((u) => u.startsWith("storage:")));
    },
  });

  async function pickRef(id: string) {
    const r = refs?.find((x) => x.id === id); if (!r) return;
    const path = r.urls.find((u) => u.startsWith("storage:"))!.slice(8);
    const { data, error } = await supabase.storage.from("media").createSignedUrl(path, 3600);
    if (error || !data) { toast.error("Não consegui abrir esse vídeo"); return; }
    setSrc(data.signedUrl); setTitle(r.title ?? "Referência"); setCur(null);
  }

  async function run() {
    if (!src) return;
    setBusy(true); setProg(0);
    try {
      const w = await watch(src, setProg);
      setProg(100);
      toast.info(`Assisti o vídeo: ${w.cuts.length} cortes. A IA está dissecando…`);
      const r = await xrayVideo({ data: { frames: w.frames, duration: w.dur, title, cuts: w.cuts } });
      if (!r.ok) throw new Error(r.error);
      const s: Saved = { id: crypto.randomUUID(), title: title || "Vídeo", duration: w.dur, at: Date.now(), xray: r.xray };
      setCur(s); persist([s, ...saved]);
      toast.success("Raio-X pronto");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function create() {
    if (!cur || !topic.trim()) { toast.error("Escreva o tema do novo vídeo"); return; }
    setBusy(true);
    try {
      const uid = (await supabase.auth.getUser()).data.user!.id;
      const short = cur.duration <= 75;
      const x = cur.xray;
      const settings = { target_seconds: short ? 65 : Math.round(cur.duration), lab_formula: x.formula, lab_hook: `${x.hook.visual} — ${x.hook.trigger}`, ...(x.dna.avg_scene_s > 0 ? { cut_seconds: Math.round(x.dna.avg_scene_s * 10) / 10 } : {}) };
      const { data: p, error } = await supabase.from("productions").insert({ user_id: uid, title: topic.trim().slice(0, 80), topic: topic.trim(), aspect: short ? "9:16" : "16:9", mode: "auto", settings }).select("id").single();
      if (error) throw error;
      toast.info("Escrevendo o roteiro com a fórmula…");
      const r = await generateScript({ data: { productionId: p.id, topic: topic.trim() } });
      if (!r.ok) throw new Error(`Produção criada, mas o roteiro falhou: ${r.error}`);
      nav({ to: "/producoes" });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  const x = cur?.xray;
  const ranking = [...saved].sort((a, b) => b.xray.hook.score - a.xray.hook.score).slice(0, 6);

  return (
    <section className="mb-8 rounded-xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">Raio-X Viral & Previsor de Retenção</h2>
      <p className="mb-3 text-sm text-muted-foreground">A IA assiste o vídeo, separa cada cena, dá nota ao gancho e mostra onde o público rolaria a tela.</p>
      <div className="flex flex-wrap gap-2">
        <select className="rounded-md border border-input bg-background px-3 py-2 text-sm" defaultValue="" onChange={(e) => pickRef(e.target.value)}>
          <option value="" disabled>Escolher vídeo já enviado…</option>
          {refs?.map((r) => <option key={r.id} value={r.id}>{r.title ?? (r.urls[0] ?? "").split("/").pop()}</option>)}
        </select>
        <label className={ghost + " cursor-pointer"}>Enviar MP4
          <input type="file" accept="video/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setSrc(URL.createObjectURL(f)); setTitle(f.name); setCur(null); } }} />
        </label>
        <button className={btn} disabled={!src || busy} onClick={run}>{busy && prog < 100 ? `Assistindo… ${prog}%` : busy ? "Dissecando…" : "Fazer Raio-X"}</button>
      </div>

      {src && (
        <div className="mt-4 grid gap-4 md:grid-cols-[260px_1fr]">
          <video ref={player} src={src} crossOrigin="anonymous" controls className="max-h-[460px] w-full rounded-lg bg-muted" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
          {x ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap gap-3">
                <Stat label="Potencial viral" v={x.virality} />
                <Stat label="Gancho 0-3s" v={x.hook.score} />
                <Stat label="Cortes/min" v={x.dna.cuts_per_min} raw />
                <Stat label="Cenas" v={x.scenes.length} raw />
              </div>
              <Curve data={x.retention} dur={cur!.duration} now={now} onSeek={(t) => { if (player.current) player.current.currentTime = t; }} />
              <div className="rounded-md bg-muted p-3">
                <b>Gancho:</b> {x.hook.visual} · <i>{x.hook.trigger}</i><br />{x.hook.verdict}<br /><span className="text-primary">Melhorar: {x.hook.fix}</span>
              </div>
            </div>
          ) : <p className="text-sm text-muted-foreground">Clique em “Fazer Raio-X”.</p>}
        </div>
      )}

      {x && (
        <div className="mt-4 space-y-4 text-sm">
          <div>
            <h3 className="mb-2 font-semibold">Cena a cena</h3>
            <div className="max-h-80 space-y-1 overflow-auto">
              {x.scenes.map((s, k) => (
                <button key={k} onClick={() => { if (player.current) player.current.currentTime = s.start; }} className={`grid w-full grid-cols-[70px_1fr_60px] gap-2 rounded-md p-2 text-left hover:bg-muted ${now >= s.start && now < s.end ? "bg-muted" : ""}`}>
                  <span className="text-muted-foreground">{s.start.toFixed(1)}–{s.end.toFixed(1)}s</span>
                  <span><b>{s.shot}</b> — {s.action}{s.sfx ? ` · SFX: ${s.sfx}` : ""}{s.transition ? ` · ${s.transition}` : ""}</span>
                  <span className="text-right">⚡{s.energy}/10</span>
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <h3 className="mb-1 font-semibold">DNA</h3>
              <p>Cena média: {x.dna.avg_scene_s}s · {x.dna.pacing}</p><p>Conteúdo: {x.dna.content_mix}</p><p>Música: {x.dna.music}</p><p>SFX: {x.dna.sfx_pattern}</p><p>Legenda: {x.dna.caption_style}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <h3 className="mb-1 font-semibold">Fórmula de Ouro</h3>
              <ol className="list-decimal pl-5">{x.formula.map((f, k) => <li key={k}>{f}</li>)}</ol>
              {x.weak_points.length > 0 && <><h3 className="mt-2 font-semibold">Pontos fracos</h3><ul className="list-disc pl-5">{x.weak_points.map((f, k) => <li key={k}>{f}</li>)}</ul></>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <input className="min-w-60 flex-1 rounded-md border border-input bg-background px-3 py-2" placeholder="Tema do novo vídeo com esta fórmula" value={topic} onChange={(e) => setTopic(e.target.value)} />
            <button className={btn} disabled={busy} onClick={create}>Criar produção a partir desta análise</button>
          </div>
        </div>
      )}

      {saved.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 font-semibold">Teste A/B de ganchos (melhor primeiro)</h3>
          <div className="space-y-1 text-sm">
            {ranking.map((s, k) => (
              <button key={s.id} onClick={() => setCur(s)} className="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-muted">
                <span className="w-6 font-bold">{k + 1}º</span>
                <span className="flex-1 truncate">{s.title} — {s.xray.hook.trigger}</span>
                <span className="font-semibold">{s.xray.hook.score}</span>
                <span className="text-muted-foreground">viral {s.xray.virality}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, v, raw }: { label: string; v: number; raw?: boolean }) {
  return <div className="rounded-md border border-border px-3 py-2"><div className="text-xs text-muted-foreground">{label}</div><div className="text-xl font-bold">{Math.round(v)}{raw ? "" : "/100"}</div></div>;
}

function Curve({ data, dur, now, onSeek }: { data: { second: number; attention: number; risk: string }[]; dur: number; now: number; onSeek: (t: number) => void }) {
  const W = 600, H = 120;
  const pts = data.map((d) => `${(d.second / dur) * W},${H - (d.attention / 100) * H}`).join(" ");
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">Curva de atenção segundo a segundo (pontos vermelhos = risco de rolar a tela, clique para ir)</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full rounded-md bg-muted">
        <polyline points={pts} fill="none" className="stroke-primary" strokeWidth={2} />
        {data.filter((d) => d.risk).map((d, k) => (
          <circle key={k} cx={(d.second / dur) * W} cy={H - (d.attention / 100) * H} r={5} className="cursor-pointer fill-destructive" onClick={() => onSeek(d.second)}><title>{`${d.second}s: ${d.risk}`}</title></circle>
        ))}
        <line x1={(now / dur) * W} x2={(now / dur) * W} y1={0} y2={H} className="stroke-foreground" strokeWidth={1} />
      </svg>
    </div>
  );
}
