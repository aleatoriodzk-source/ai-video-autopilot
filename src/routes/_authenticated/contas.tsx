import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Empty } from "@/components/app/ui";

export const Route = createFileRoute("/_authenticated/contas")({
  head: () => ({
    meta: [
      { title: "Contas e Explorador — Estúdio Automático" },
      { name: "description", content: "Vincule suas contas do YouTube e TikTok e busque vídeos de referência direto no estúdio." },
      { property: "og:title", content: "Contas e Explorador — Estúdio Automático" },
      { property: "og:description", content: "Vincule suas contas do YouTube e TikTok e busque vídeos de referência direto no estúdio." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Contas,
});

const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50";
type Result = { id: string; title: string; channel: string; duration: number | null; views: number | null; url: string; thumb: string };

function Contas() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [shorts, setShorts] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const { data: accounts } = useQuery({ queryKey: ["linked"], queryFn: async () => (await supabase.from("linked_accounts").select("*")).data ?? [] });
  const { data: job } = useQuery({
    queryKey: ["search-job", jobId],
    enabled: !!jobId,
    queryFn: async () => (await supabase.from("jobs").select("status,error,payload").eq("id", jobId!).single()).data,
    refetchInterval: (query) => (["done", "failed"].includes(query.state.data?.status ?? "") ? false : 3000),
  });
  const results = ((job?.payload as { results?: Result[] } | null)?.results ?? []) as Result[];

  async function uploadCookies(platform: "youtube" | "tiktok" | "google", file: File | undefined) {
    if (!file) return;
    if (file.size > 2_000_000) { toast.error("Arquivo grande demais para um cookies.txt"); return; }
    const text = await file.text();
    if (!/Netscape|\t(TRUE|FALSE)\t/.test(text)) { toast.error("Esse arquivo não parece um cookies.txt (formato Netscape)"); return; }
    const { data: u } = await supabase.auth.getUser();
    const path = `${u.user!.id}/accounts/${platform}-cookies.txt`;
    const up = await supabase.storage.from("media").upload(path, file, { upsert: true, contentType: "text/plain" });
    if (up.error) { toast.error(up.error.message); return; }
    const { error } = await supabase.from("linked_accounts").upsert({ user_id: u.user!.id, platform, cookies_path: path, label: file.name, updated_at: new Date().toISOString() }, { onConflict: "user_id,platform" });
    if (error) { toast.error(error.message); return; }
    toast.success(`Conta do ${platform === "youtube" ? "YouTube" : platform === "google" ? "Google" : "TikTok"} vinculada ao agente`);
    qc.invalidateQueries({ queryKey: ["linked"] });
  }

  async function unlink(platform: string, path: string) {
    await supabase.storage.from("media").remove([path]);
    await supabase.from("linked_accounts").delete().eq("platform", platform);
    qc.invalidateQueries({ queryKey: ["linked"] });
  }

  async function search() {
    if (q.trim().length < 2) { toast.error("Digite o que quer buscar"); return; }
    const { data: u } = await supabase.auth.getUser();
    const { data, error } = await supabase.from("jobs").insert({ user_id: u.user!.id, type: "search_videos", payload: { query: q.trim().slice(0, 200), shorts } }).select("id").single();
    if (error) { toast.error(error.message); return; }
    setJobId(data.id);
  }

  async function useAsReference(r: Result) {
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("reference_sources").insert({ user_id: u.user!.id, urls: [r.url], platform: "youtube", kind: "video", title: r.title.slice(0, 120) });
    if (error) { toast.error(error.message); return; }
    toast.success("Adicionado em Referências. Lá você pode analisar, fatiar ou extrair a voz.");
    qc.invalidateQueries({ queryKey: ["refs"] });
  }

  const acc = (p: string) => accounts?.find((a) => a.platform === p);

  return (
    <div>
      <PageHeader title="Contas e Explorador" subtitle="Vincule suas contas para o agente baixar sem bloqueio de robô, e busque vídeos de referência sem sair do estúdio." />
      <div className="panel mb-4 space-y-2 p-4 text-xs text-muted-foreground">
        <p><b className="text-foreground">Como vincular (2 minutos):</b> no Chrome, instale a extensão <b>"Get cookies.txt LOCALLY"</b>, entre no YouTube (ou TikTok) com a conta que quiser usar, clique na extensão e em <b>Export</b>. Envie o arquivo aqui.</p>
        <p>YouTube e TikTok não oferecem um botão oficial de "baixar vídeos" para apps, por isso a ligação é pela sua sessão. O arquivo fica guardado só na sua conta e é usado pelo agente no seu PC. Recomendo usar uma conta secundária. Se a sessão vencer, é só enviar de novo.</p>
      </div>
      <div className="mb-6 grid gap-3 md:grid-cols-2">
        {(["youtube", "tiktok", "google"] as const).map((p) => {
          const a = acc(p);
          return (
            <div key={p} className="panel space-y-2 p-4 text-sm">
              <b>{p === "youtube" ? "YouTube" : p === "google" ? "Google (busca de imagens)" : "TikTok"}</b>
              <p className="text-xs text-muted-foreground">{a ? `Vinculada (${a.label ?? "cookies.txt"}) em ${new Date(a.updated_at).toLocaleString("pt-BR")}` : "Não vinculada"}</p>
              <div className="flex flex-wrap gap-2">
                <label className={btn + " cursor-pointer"}>
                  {a ? "Trocar arquivo" : "Enviar cookies.txt"}
                  <input type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => uploadCookies(p, e.target.files?.[0])} />
                </label>
                {a && <button className={btn} onClick={() => unlink(p, a.cookies_path)}>Desvincular</button>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel mb-4 flex flex-wrap items-center gap-2 p-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="Ex.: heróis mais fortes da Marvel" className={input + " flex-1"} />
        <label className="flex items-center gap-1 text-xs text-muted-foreground"><input type="checkbox" checked={shorts} onChange={(e) => setShorts(e.target.checked)} /> Só Shorts</label>
        <button onClick={search} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Buscar no YouTube</button>
      </div>
      {jobId && job && !["done", "failed"].includes(job.status) && <p className="mb-4 text-sm text-muted-foreground">O agente do seu PC está buscando… (ele precisa estar aberto)</p>}
      {job?.status === "failed" && <p className="mb-4 text-sm text-destructive">A busca falhou: {String(job.error ?? "").split("\n")[0]}</p>}
      {job?.status === "done" && !results.length && <Empty>Nada encontrado.</Empty>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {results.map((r) => (
          <div key={r.id} className="panel overflow-hidden text-sm">
            <img src={r.thumb} alt={r.title} className="aspect-video w-full object-cover" loading="lazy" />
            <div className="space-y-1 p-3">
              <a href={r.url} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium hover:underline">{r.title}</a>
              <p className="text-xs text-muted-foreground">{r.channel}{r.views ? ` · ${r.views.toLocaleString("pt-BR")} views` : ""}{r.duration ? ` · ${Math.round(r.duration)}s` : ""}</p>
              <button className={btn} onClick={() => useAsReference(r)}>Usar como referência</button>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">A busca é feita no YouTube. Vídeos do TikTok você cola o link em Referências (com a conta vinculada o agente baixa sem marca d'água quando possível).</p>
    </div>
  );
}
