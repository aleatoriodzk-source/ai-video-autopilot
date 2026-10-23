/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge, Empty } from "@/components/app/ui";
import { DnaView } from "@/components/app/DnaView";
import { channelIdeas } from "@/lib/ai.functions";

export const Route = createFileRoute("/_authenticated/laboratorio")({
  head: () => ({
    meta: [
      { title: "Laboratório — Estúdio Automático" },
      { name: "description", content: "Envie um vídeo viral e o laboratório desmonta voz, legenda, cortes, filtros e efeitos para clonar o estilo." },
      { property: "og:title", content: "Laboratório — Estúdio Automático" },
      { property: "og:description", content: "Desmonte um vídeo viral em camadas e clone o estilo completo." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Lab,
});

const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const btn = "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";

function Lab() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [kitFor, setKitFor] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [ideas, setIdeas] = useState<Record<string, any[]>>({});
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [audio, setAudio] = useState<Record<string, string>>({});

  async function listen(v: any) {
    const { data, error } = await supabase.storage.from("media").createSignedUrl(v.sample_path, 3600);
    if (error || !data) { toast.error("Não consegui abrir a amostra"); return; }
    setAudio((a) => ({ ...a, [v.id]: data.signedUrl }));
  }

  async function loadIdeas(id: string) {
    setIdeasBusy(true);
    const r = await channelIdeas({ data: { referenceId: id } });
    setIdeasBusy(false);
    if (!r.ok) { toast.error(r.error); return; }
    setIdeas((m) => ({ ...m, [id]: r.ideas }));
  }

  const { data } = useQuery({
    queryKey: ["lab"],
    refetchInterval: 8000,
    queryFn: async () => {
      const { data: refs } = await supabase.from("reference_sources").select("id,title,status,created_at").eq("notes", "lab").order("created_at", { ascending: false });
      const ids = (refs ?? []).map((r) => r.id);
      if (!ids.length) return [];
      const [{ data: an }, { data: vs }] = await Promise.all([
        supabase.from("analyses").select("id,reference_id,status,report,error,created_at").in("reference_id", ids).order("created_at", { ascending: false }),
        supabase.from("voices").select("id,reference_id,status,stats,error,sample_path").in("reference_id", ids),
      ]);
      return (refs ?? []).map((r) => ({ ...r, analysis: (an ?? []).find((a) => a.reference_id === r.id), voice: (vs ?? []).find((v) => v.reference_id === r.id) }));
    },
  });

  async function dissect() {
    const label = name.trim() || file?.name || "Vídeo do laboratório";
    if (!file && !/^https?:\/\//.test(link.trim())) { toast.error("Envie um vídeo ou cole um link do TikTok/YouTube"); return; }
    setBusy(true);
    try {
      const uid = (await supabase.auth.getUser()).data.user!.id;
      let url = link.trim();
      if (file) {
        const path = `${uid}/lab/${Date.now()}_${file.name.replace(/[^\w.-]/g, "_")}`;
        const up = await supabase.storage.from("media").upload(path, file, { contentType: file.type });
        if (up.error) throw up.error;
        url = `storage:${path}`;
      }
      const platform = /tiktok/.test(url) ? "tiktok" : /youtu/.test(url) ? "youtube" : "other";
      const { data: r, error } = await supabase.from("reference_sources").insert({ user_id: uid, urls: [url], platform, kind: "video", title: `Lab: ${label}`.slice(0, 90), notes: "lab", status: "queued" }).select("id").single();
      if (error) throw error;
      const { data: a, error: e1 } = await supabase.from("analyses").insert({ user_id: uid, reference_id: r.id, kind: "short" }).select("id").single();
      if (e1) throw e1;
      const { data: v, error: e2 } = await supabase.from("voices").insert({ user_id: uid, name: `Lab: ${label}`.slice(0, 60), reference_id: r.id }).select("id").single();
      if (e2) throw e2;
      const { error: e3 } = await supabase.from("jobs").insert([
        { user_id: uid, type: "analyze_reference", reference_id: r.id, analysis_id: a.id },
        { user_id: uid, type: "extract_voice", reference_id: r.id, payload: { voice_id: v.id } },
      ]);
      if (e3) throw e3;
      toast.success("Enviado para dissecação — o agente local vai processar");
      setName(""); setLink(""); setFile(null);
      qc.invalidateQueries({ queryKey: ["lab"] });
    } catch (e: any) {
      toast.error(e.message ?? "Falhou");
    } finally {
      setBusy(false);
    }
  }

  async function useKit(k: any) {
    if (!topic.trim()) { toast.error("Escreva o tema do vídeo"); return; }
    const uid = (await supabase.auth.getUser()).data.user!.id;
    const settings: any = { target_seconds: 65, style: "tiktok", caption_style: "auto", sfx: "on", ...(k.voice?.status === "ready" ? { voice_id: k.voice.id } : {}), lab_kit: k.id };
    const { error } = await supabase.from("productions").insert({ user_id: uid, title: topic.trim().slice(0, 80), topic: topic.trim(), aspect: "9:16", mode: "auto", reference_id: k.id, settings });
    if (error) { toast.error(error.message); return; }
    toast.success("Produção criada com o kit do laboratório");
    nav({ to: "/producoes" });
  }

  async function remove(id: string) {
    if (!window.confirm("Apagar este kit do laboratório?")) return;
    await supabase.from("voices").delete().eq("reference_id", id);
    await supabase.from("reference_sources").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["lab"] });
  }

  return (
    <div>
      <PageHeader title="Laboratório" subtitle="Envie 1 vídeo viral. O laboratório desmonta tudo: isola e clona a voz, mede a legenda, os cortes, os filtros, a música e os efeitos. Fica separado do resto — só entra numa produção quando você escolher." />
      <div className="panel mb-6 space-y-3 p-4">
        <input className={input} placeholder="Nome do kit (ex.: Curiosidades estilo X)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={input} placeholder="Link do TikTok/YouTube (ou envie o arquivo abaixo)" value={link} onChange={(e) => setLink(e.target.value)} disabled={!!file} />
        <input type="file" accept="video/*" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className={btn} disabled={busy} onClick={dissect}>{busy ? "Enviando…" : "Dissecar vídeo"}</button>
      </div>

      {!data?.length ? (
        <Empty>Nenhum kit ainda. Envie um vídeo acima.</Empty>
      ) : (
        <div className="space-y-3">
          {data.map((k: any) => {
            const dna = k.analysis?.report?.format_dna;
            const st = k.voice?.stats ?? {};
            return (
              <div key={k.id} className="panel space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <b className="text-sm">{k.title?.replace(/^Lab: /, "")}</b>
                  <div className="flex gap-2">
                    <button className={btn} disabled={k.analysis?.status !== "done"} onClick={() => { const o = kitFor === k.id ? null : k.id; setKitFor(o); setTopic(""); if (o && !ideas[o]) loadIdeas(o); }}>Usar num vídeo novo</button>
                    <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => remove(k.id)}>Apagar</button>
                  </div>
                </div>
                {kitFor === k.id && (
                  <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
                    <label className="text-sm font-medium">Sobre o que vai ser o novo vídeo?</label>
                    <input autoFocus className={input} placeholder="Ex.: 3 erros no filme do Homem-Aranha" value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && useKit(k)} />
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">{ideasBusy && !ideas[k.id] ? "A IA está pensando em temas do mesmo nicho…" : "Sugestões da IA (toque para usar):"}</p>
                      {(ideas[k.id] ?? []).map((i: any, n: number) => (
                        <button key={n} onClick={() => setTopic(i.title)} className={`block w-full rounded-md border px-3 py-2 text-left text-sm ${topic === i.title ? "border-primary bg-primary/10" : "border-border hover:bg-accent"}`}>
                          <b>{i.title}</b><span className="block text-xs text-muted-foreground">{i.hook}</span>
                        </button>
                      ))}
                      {ideas[k.id] && <button className="text-xs text-primary" disabled={ideasBusy} onClick={() => loadIdeas(k.id)}>{ideasBusy ? "Gerando…" : "Outras sugestões"}</button>}
                    </div>
                    <p className="text-xs text-muted-foreground">Usa a voz, o ritmo, a legenda e os filtros deste kit. Duração mínima de 60 segundos.</p>
                    <div className="flex gap-2">
                      <button className={btn} onClick={() => useKit(k)}>Criar vídeo</button>
                      <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => setKitFor(null)}>Cancelar</button>
                    </div>
                  </div>
                )}
                <div className="grid gap-2 text-sm md:grid-cols-2">
                  <div className="rounded-md border border-border p-3">
                    <div className="mb-1 flex items-center justify-between"><span className="font-medium">Voz isolada e clonada</span>{k.voice && <StatusBadge status={k.voice.status === "ready" ? "done" : k.voice.status} />}</div>
                    {k.voice?.status === "ready" && k.voice.sample_path && (audio[k.voice.id] ? <audio controls autoPlay src={audio[k.voice.id]} className="mb-1 w-full" /> : <button onClick={() => listen(k.voice)} className="mb-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">▶ Ouvir voz isolada</button>)}
                    {k.voice?.status === "ready" && (st.isolation === "demucs" || /demucs/i.test(String(st.isolation ?? ""))
                      ? <span className="mb-1 inline-block rounded bg-success/15 px-2 py-0.5 text-xs text-success">Isolamento com IA</span>
                      : k.voice?.status === "ready" && <span className="mb-1 inline-block rounded bg-warning/15 px-2 py-0.5 text-xs text-warning">Filtro simples — a música pode vazar. Rode install_voice_clone.bat e disseque de novo.</span>)}
                    {k.voice?.status === "ready" ? <p className="text-muted-foreground">{st.wpm ? `${st.wpm} palavras/min · ` : ""}{st.pauses_count ?? 0} pausas · isolamento: {st.isolation}</p> : <p className="text-muted-foreground">{k.voice?.error ?? "aguardando o agente local"}</p>}
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <div className="mb-1 flex items-center justify-between"><span className="font-medium">Legenda, cortes, filtros e som</span>{k.analysis && <StatusBadge status={k.analysis.status} />}</div>
                    <p className="text-muted-foreground">{k.analysis?.error ?? (dna ? `${dna.niche ?? ""} — pronto` : "aguardando o agente local")}</p>
                  </div>
                </div>
                {k.analysis?.report && (
                  <>
                    <button className="text-sm text-primary" onClick={() => setOpen(open === k.id ? null : k.id)}>{open === k.id ? "Fechar camadas" : "Ver todas as camadas"}</button>
                    {open === k.id && <DnaView report={k.analysis.report} />}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
