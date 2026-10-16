import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge, Empty } from "@/components/app/ui";
import { requestAnalysis } from "@/lib/jobs";

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
  const platform = u.includes("tiktok.com") ? "tiktok" : u.includes("youtu") ? "youtube" : "outro";
  const isChannel = /youtube\.com\/(@|channel\/|c\/|user\/)/.test(u) || (/tiktok\.com\/@[^/]+\/?$/.test(u));
  return { platform, kind: isChannel ? "channel" : "short" } as const;
}

function Referencias() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: refs } = useQuery({
    queryKey: ["refs"],
    queryFn: async () => (await supabase.from("reference_sources").select("*").order("created_at", { ascending: false })).data ?? [],
  });

  async function add() {
    const urls = text.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
    if (!urls.length) { toast.error("Cole pelo menos um link válido (https://...)"); return; }
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

  async function analyze(id: string, kind: string) {
    try {
      await requestAnalysis(id, kind === "channel" ? "channel" : "short");
      toast.success("Análise enviada para a fila. O agente local fará o download e a análise.");
      qc.invalidateQueries({ queryKey: ["refs"] });
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div>
      <PageHeader title="Referências" subtitle="Cole links de canais ou vídeos do YouTube/TikTok. Vários links do mesmo criador viram uma única referência. O download e a análise são feitos pelo agente local no seu computador." />
      <div className="panel mb-6 space-y-3 p-4">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nome (opcional), ex.: Canal de curiosidades" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="https://www.youtube.com/@canal  ou  https://www.tiktok.com/@perfil/video/..." className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" />
        <button disabled={busy} onClick={add} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Salvar referência</button>
      </div>
      {!refs?.length ? <Empty>Nenhuma referência cadastrada.</Empty> : (
        <div className="space-y-2">
          {refs.map((r) => (
            <div key={r.id} className="panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{r.title ?? r.urls[0]}</div>
                <div className="text-xs text-muted-foreground">{r.platform} · {r.kind === "channel" ? "canal/perfil" : "vídeo"} · {r.urls.length} link(s)</div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={r.status} />
                <button onClick={() => analyze(r.id, r.kind)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">Analisar</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
