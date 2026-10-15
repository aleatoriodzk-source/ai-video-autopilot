import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge, Empty } from "@/components/app/ui";

export const Route = createFileRoute("/_authenticated/painel")({
  head: () => ({
    meta: [
      { title: "Dashboard — Estúdio Automático" },
      { name: "description", content: "Resumo da sua produção de vídeos com IA." },
      { property: "og:title", content: "Dashboard — Estúdio Automático" },
      { property: "og:description", content: "Resumo da sua produção de vídeos com IA." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Painel,
});

function Painel() {
  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: async () => (await supabase.from("jobs").select("id,type,status,step,progress,created_at").order("created_at", { ascending: false }).limit(20)).data ?? [],
  });
  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Resumo das tarefas de produção. As demais telas do painel ainda estão em construção." />
      {!jobs?.length ? (
        <Empty>Nenhuma tarefa ainda.</Empty>
      ) : (
        <div className="space-y-2">
          {jobs.map((j) => (
            <div key={j.id} className="panel flex items-center justify-between p-4 text-sm">
              <span>{j.type === "production" ? "Produção" : "Análise"} · {j.step ?? "—"} · {j.progress}%</span>
              <StatusBadge status={j.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
