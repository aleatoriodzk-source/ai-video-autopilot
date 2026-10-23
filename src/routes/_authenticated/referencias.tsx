import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { channelIdeas, generateScript } from "@/lib/ai.functions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge, Empty } from "@/components/app/ui";
import { requestAnalysis, startProduction } from "@/lib/jobs";
import { DnaView } from "@/components/app/DnaView";

export const Route = createFileRoute("/_authenticated/referencias")({
  head: () => ({
    meta: [
      { title: "Referências — Estúdio Automático" },
      { name: "description", content: "Cadastre canais e vídeos de referência do YouTube e TikTok." },
      { property: "og:title", content: "Referências — Estúdio Automático" },
      { property: "og:description", content: "Cadastre canais e vídeos de referência do YouTube e TikTok." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Referencias,
});

function detect(url: string) {
  const u = url.toLowerCase();
  const platform = u.includes("tiktok.com") ? "tiktok" : u.includes("youtu") ? "youtube" : "other";
  const isChannel = /youtube\.com\/(@|channel\/|c\/|user\/)/.test(u) || (/tiktok\.com\/@[^/]+\/?$/.test(u));
  return { platform, kind: isChannel ? "channel" : "video" } as const;
}

function Referencias() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: refs } = useQuery({
    queryKey: ["refs"],
    refetchInterval: 8000,
    queryFn: async () => (await supabase.from("reference_sources").select("*").or("notes.is.null,notes.neq.lab").order("created_at", { ascending: false })).data ?? [],
  });

  const [open, setOpen] = useState<string | null>(null);
  const { data: reports } = useQuery({
    queryKey: ["analyses-done"],
    refetchInterval: 8000,
    queryFn: async () => (await supabase.from("analyses").select("reference_id, report, created_at").eq("status", "done").order("created_at", { ascending: false })).data ?? [],
  });
  const reportOf = (id: string) => reports?.find((a) => a.reference_id === id)?.report;

  const [plat, setPlat] = useState<"youtube" | "tiktok">("youtube");
  const [ideas, setIdeas] = useState<Record<string, { title: string; hook: string; angle: string; why_fits: string; factual: boolean }[]>>({});
  const [wish, setWish] = useState("");
  const [thinking, setThinking] = useState<string | null>(null);
  const navigate = useNavigate();

  async function suggest(id: string) {
    setThinking(id);
    try {
      const r = await channelIdeas({ data: { referenceId: id, wish } });
      if (!r.ok) throw new Error(r.error);
      setIdeas((m) => ({ ...m, [id]: r.ideas }));
    } catch (e) { toast.error((e as Error).message); } finally { setThinking(null); }
  }

  async function makeProduction(refId: string, platform: string, idea: { title: string; hook: string; angle: string }) {
    const { data: u } = await supabase.auth.getUser();
    const short = platform === "tiktok" || /\/shorts/.test(refs?.find((x) => x.id === refId)?.urls[0] ?? "");
    const settings = { target_seconds: short ? 65 : 300, style: short ? "tiktok" : "youtube", voice: "pt-BR-AntonioNeural", voice_rate: "+5%", music_mood: "auto", caption_style: "auto", media_rule: "auto", sfx: "on", base_captions: "hide", source_mode: "search" };
    const topic = `${idea.title}. Gancho: ${idea.hook}. Ângulo: ${idea.angle}`.slice(0, 480);
    const { data: p, error } = await supabase.from("productions").insert({ user_id: u.user!.id, title: idea.title.slice(0, 80), topic, aspect: short ? "9:16" : "16:9", mode: "auto", reference_id: refId, settings }).select("id").single();
    if (error) throw error;
    const s = await generateScript({ data: { productionId: p.id, topic } });
    if (!s.ok) throw new Error(s.error);
    return p.id;
  }

  async function createFrom(refId: string, platform: string, idea: { title: string; hook: string; angle: string }) {
    setThinking(refId + idea.title);
    try {
      await makeProduction(refId, platform, idea);
      toast.success("Roteiro criado no estilo do canal");
      navigate({ to: "/producoes" });
    } catch (e) { toast.error((e as Error).message); } finally { setThinking(null); }
  }

  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [batch, setBatch] = useState<string | null>(null);
  async function runBatch(refId: string, platform: string) {
    const list = (ideas[refId] ?? []).filter((i) => picked[refId]?.includes(i.title));
    if (!list.length) return;
    setThinking(refId + ":batch");
    let ok = 0;
    for (const [n, idea] of list.entries()) {
      setBatch(`Escrevendo roteiro ${n + 1} de ${list.length}…`);
      try {
        const pid = await makeProduction(refId, platform, idea);
        await startProduction(pid, { needsAnalysis: false, referenceId: refId });
        ok++;
      } catch (e) { toast.error(`"${idea.title}": ${(e as Error).message}`); }
    }
    setBatch(null); setThinking(null);
    setPicked((m) => ({ ...m, [refId]: [] }));
    if (ok) { toast.success(`${ok} vídeo(s) na fila. O agente faz um depois do outro.`); navigate({ to: "/producoes" }); }
  }

  async function add() {
    const urls = text.split(/\s+/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const h = s.match(/^@([\w.\-]{2,60})$/);
      if (!h) return s;
      return plat === "tiktok" ? `https://www.tiktok.com/@${h[1]}` : `https://www.youtube.com/@${h[1]}/videos`;
    }).filter((s) => /^https?:\/\//.test(s));
    if (!urls.length) { toast.error("Cole um link (https://...) ou digite o @ do canal"); return; }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const d = detect(urls[0] ?? "");
      const kind = urls.length > 1 ? "channel" : d.kind;
      const { error } = await supabase.from("reference_sources").insert({ user_id: u.user!.id, urls, platform: d.platform, kind, title: title || null });
      if (error) throw error;
      setText(""); setTitle("");
      toast.success("Referência salva");
      qc.invalidateQueries({ queryKey: ["refs"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("video/")) { toast.error("Envie um arquivo de vídeo (MP4, MOV, WEBM)"); return; }
    if (file.size > 2 * 1024 ** 3) { toast.error("Arquivo maior que 2 GB"); return; }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${u.user!.id}/refs/${Date.now()}.${ext}`;
      const up = await supabase.storage.from("media").upload(path, file, { contentType: file.type });
      if (up.error) throw up.error;
      const { error } = await supabase.from("reference_sources").insert({ user_id: u.user!.id, urls: [`storage:${path}`], platform: "other", kind: "video", title: title || file.name });
      if (error) throw error;
      setTitle("");
      toast.success("Vídeo enviado. Clique em Analisar para o agente estudar o estilo.");
      qc.invalidateQueries({ queryKey: ["refs"] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function analyze(id: string, kind: string) {
    try {
      await requestAnalysis(id, kind === "channel" ? "channel" : "short");
      toast.success("Análise enviada para a fila. O agente local fará o download e a análise.");
      qc.invalidateQueries({ queryKey: ["refs"] });
    } catch (e) { toast.error((e as Error).message); }
  }

  async function remove(id: string) {
    if (!window.confirm("Excluir esta referência e as análises dela?")) return;
    const { error } = await supabase.from("reference_sources").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Referência excluída");
    qc.invalidateQueries({ queryKey: ["refs"] });
  }

  return (
    <div>
      <PageHeader title="Referências" subtitle="Cole links de canais ou vídeos do YouTube/TikTok. Vários links do mesmo criador viram uma única referência. O download e a análise são feitos pelo agente local no seu computador." />
      <div className="panel mb-6 space-y-3 p-4">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nome (opcional), ex.: Canal de curiosidades" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Se digitar só o @, é canal do:</span>
          {(["youtube", "tiktok"] as const).map((p) => (
            <button key={p} onClick={() => setPlat(p)} className={`rounded-md border px-3 py-1 ${plat === p ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent"}`}>{p === "youtube" ? "YouTube" : "TikTok"}</button>
          ))}
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="@nomedocanal  ou  https://www.youtube.com/@canal  ou  https://www.tiktok.com/@perfil/video/..." className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" />
        <button disabled={busy} onClick={add} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Salvar referência</button>
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files[0]); }}
          className="flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed border-border p-5 text-center text-sm hover:bg-accent"
        >
          <span className="font-medium">{busy ? "Enviando…" : "Ou arraste um vídeo aqui (MP4) / clique para escolher"}</span>
          <span className="text-xs text-muted-foreground">Sem bloqueio do YouTube/TikTok: o agente analisa cortes, ritmo e falas do arquivo.</span>
          <input type="file" accept="video/*" className="hidden" disabled={busy} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
      </div>
      {!refs?.length ? <Empty>Nenhuma referência cadastrada.</Empty> : (
        <div className="space-y-2">
          {refs.map((r) => (
            <div key={r.id} className="panel p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{r.title ?? r.urls[0]}</div>
                <div className="text-xs text-muted-foreground">{r.platform} · {r.kind === "channel" ? "canal/perfil" : "vídeo"} · {r.urls.length} link(s)</div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={reportOf(r.id) && r.status !== "queued" && r.status !== "running" ? "done" : r.status} />
                {reportOf(r.id) ? <button onClick={() => setOpen(open === r.id ? null : r.id)} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground">{open === r.id ? "Fechar DNA" : "Ver DNA do formato"}</button> : null}
                <button onClick={() => analyze(r.id, r.kind)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">{reportOf(r.id) ? "Analisar de novo" : "Analisar"}</button>
                <button onClick={() => remove(r.id)} className="rounded-md border border-destructive/50 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10">Excluir</button>
              </div>
            </div>
            {open === r.id ? <div className="mt-4 border-t border-border pt-4"><DnaView report={reportOf(r.id)} /></div> : null}
            {reportOf(r.id) ? (
              <div className="mt-4 space-y-3 border-t border-border pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <input value={wish} onChange={(e) => setWish(e.target.value)} placeholder="Preferência (opcional), ex.: temas de terror" className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs" />
                  <button disabled={thinking === r.id} onClick={() => suggest(r.id)} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">{thinking === r.id ? "Pensando…" : ideas[r.id] ? "Sugerir outros temas" : "Sugerir temas no estilo deste canal"}</button>
                </div>
                {ideas[r.id]?.length ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2 text-xs">
                    <span className="text-muted-foreground">Modo fábrica: marque vários temas e o agente faz todos, um depois do outro.</span>
                    <button disabled={!!thinking || !picked[r.id]?.length} onClick={() => runBatch(r.id, r.platform)} className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50">{thinking === r.id + ":batch" ? batch : `Gerar lote (${picked[r.id]?.length ?? 0})`}</button>
                  </div>
                ) : null}
                {ideas[r.id]?.map((i) => (
                  <div key={i.title} className="rounded-md border border-border p-3">
                    <label className="flex cursor-pointer items-start gap-2 font-medium">
                      <input type="checkbox" className="mt-1" checked={!!picked[r.id]?.includes(i.title)} onChange={(e) => setPicked((m) => ({ ...m, [r.id]: e.target.checked ? [...(m[r.id] ?? []), i.title] : (m[r.id] ?? []).filter((t) => t !== i.title) }))} />
                      {i.title}
                    </label>
                    <div className="mt-1 text-xs">Gancho: “{i.hook}”</div>
                    <div className="mt-1 text-xs text-muted-foreground">{i.why_fits}{i.factual ? " · precisa conferir fatos" : ""}</div>
                    <button disabled={!!thinking} onClick={() => createFrom(r.id, r.platform, i)} className="mt-2 rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50">{thinking === r.id + i.title ? "Escrevendo roteiro…" : "Criar vídeo com este tema"}</button>
                  </div>
                ))}
              </div>
            ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
