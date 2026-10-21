import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge, Empty } from "@/components/app/ui";

export const Route = createFileRoute("/_authenticated/vozes")({
  head: () => ({
    meta: [
      { title: "Banco de Vozes — Estúdio Automático" },
      { name: "description", content: "Isole e clone a voz de um vídeo de referência e use nas suas produções." },
      { property: "og:title", content: "Banco de Vozes — Estúdio Automático" },
      { property: "og:description", content: "Isole e clone a voz de um vídeo de referência e use nas suas produções." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Vozes,
});

const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

type Voice = { id: string; name: string; status: string; sample_path: string | null; stats: { wpm?: number; pauses_count?: number; pause_avg_s?: number; isolation?: string; engine_available?: string | null }; error: string | null };

function Vozes() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [refId, setRefId] = useState("");
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<Record<string, string>>({});
  const { data: refs } = useQuery({ queryKey: ["refs"], queryFn: async () => (await supabase.from("reference_sources").select("id,title,urls")).data ?? [] });
  const { data: voices } = useQuery({
    queryKey: ["voices-full"],
    queryFn: async () => ((await supabase.from("voices").select("*").order("created_at", { ascending: false })).data ?? []) as Voice[],
    refetchInterval: 8000,
  });

  async function create() {
    if (!name.trim() || !refId) { toast.error("Dê um nome e escolha o vídeo de onde tirar a voz"); return; }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const { data: v, error } = await supabase.from("voices").insert({ user_id: u.user!.id, name: name.trim().slice(0, 60), reference_id: refId }).select("id").single();
      if (error) throw error;
      const { error: e2 } = await supabase.from("jobs").insert({ user_id: u.user!.id, type: "extract_voice", reference_id: refId, payload: { voice_id: v.id } });
      if (e2) throw e2;
      setName("");
      toast.success("Enviado ao agente: ele vai isolar e medir a voz");
      qc.invalidateQueries({ queryKey: ["voices-full"] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function listen(v: Voice) {
    if (!v.sample_path) return;
    const { data } = await supabase.storage.from("media").createSignedUrl(v.sample_path, 3600);
    if (data) setAudio((a) => ({ ...a, [v.id]: data.signedUrl }));
  }

  async function remove(id: string) {
    await supabase.from("voices").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["voices-full"] });
  }

  return (
    <div>
      <PageHeader title="Banco de Vozes" subtitle="O agente baixa o vídeo, separa a voz da música e dos efeitos, mede o ritmo e as pausas e guarda uma amostra limpa. Depois é só escolher a voz na produção." />
      <div className="panel mb-4 space-y-2 p-4 text-xs text-muted-foreground">
        <p><b className="text-foreground">Para clonar de verdade no seu PC:</b> rode uma vez o <b>install_voice_clone.bat</b> (vem no ZIP do agente). Ele instala o separador de voz e o clonador. São alguns GB; com placa de vídeo NVIDIA fica bem mais rápido.</p>
        <p>Sem isso instalado, o sistema avisa no registro e narra com a voz da Microsoft na mesma velocidade da voz original — ele não finge que clonou.</p>
        <p>Use só vozes que você tem direito de usar (a sua, de quem autorizou, ou de conteúdo licenciado).</p>
      </div>
      <div className="panel mb-6 grid gap-3 p-4 md:grid-cols-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome da voz, ex.: Narrador misterioso" className={input} />
        <select value={refId} onChange={(e) => setRefId(e.target.value)} className={input}>
          <option value="">Vídeo de onde tirar a voz</option>
          {refs?.map((r) => <option key={r.id} value={r.id}>{r.title ?? r.urls[0]}</option>)}
        </select>
        <button onClick={create} disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Extrair e clonar voz</button>
      </div>
      {!voices?.length ? <Empty>Nenhuma voz ainda. Cadastre um vídeo em Referências e extraia a voz dele aqui.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">
          {voices.map((v) => {
            const s = v.stats ?? {};
            return (
              <div key={v.id} className="panel space-y-2 p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <b>{v.name}</b>
                  <StatusBadge status={v.status === "ready" ? "done" : v.status === "processing" ? "running" : v.status} />
                </div>
                {v.status === "ready" && (
                  <div className="text-xs text-muted-foreground">
                    Ritmo: {s.wpm ? `${s.wpm} palavras/min` : "não medido (vídeo sem legenda)"} · Pausas: {String(s.pauses_count ?? "?")} (média {String(s.pause_avg_s ?? "?")}s) · Isolamento: {String(s.isolation ?? "?")} · Clonador no PC: {s.engine_available ? String(s.engine_available) : "não instalado"}
                  </div>
                )}
                {v.error && <p className="text-xs text-destructive">{v.error}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {v.sample_path && !audio[v.id] && <button onClick={() => listen(v)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">Ouvir amostra limpa</button>}
                  {audio[v.id] && <audio src={audio[v.id]} controls className="h-8" />}
                  <button onClick={() => remove(v.id)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">Excluir</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
