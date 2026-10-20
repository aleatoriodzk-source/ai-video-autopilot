import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { activeJob, agentOnline, redoStep } from "@/lib/jobs";
import { JOB_STATUS_LABEL, STEPS, type StepId } from "@/lib/pipeline";
import { friendlyError } from "@/lib/friendly-error";

const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

/** Shows where the production is, what went wrong in plain words, and lets the user retry only the failed step. */
export function JobStatus({ productionId }: { productionId: string }) {
  const qc = useQueryClient();
  const [details, setDetails] = useState(false);
  const { data: job } = useQuery({ queryKey: ["job", productionId], queryFn: () => activeJob(productionId), refetchInterval: 5000 });
  const { data: logs } = useQuery({
    queryKey: ["job-logs", job?.id],
    enabled: !!job?.id,
    refetchInterval: 5000,
    queryFn: async () => (await supabase.from("activity_logs").select("id,level,step,message,created_at").eq("job_id", job!.id).order("created_at", { ascending: false }).limit(8)).data ?? [],
  });
  const { data: agents } = useQuery({ queryKey: ["agents-status"], queryFn: async () => (await supabase.from("agents").select("last_seen_at").eq("revoked", false)).data ?? [] });
  if (!job) return null;

  const online = (agents ?? []).some((a) => agentOnline(a.last_seen_at));
  const stepLabel = STEPS.find((s) => s.id === job.step)?.label ?? job.step;
  const fe = job.status === "failed" ? friendlyError(job.error) : null;
  const failedStep = (job.step as StepId | null) ?? STEPS.find((s) => !job.completed_steps.includes(s.id))?.id ?? null;
  const done = STEPS.filter((s) => job.completed_steps.includes(s.id)).length;

  async function retry() {
    if (!failedStep) return;
    await redoStep(job!.id, job!.completed_steps, failedStep);
    await supabase.from("productions").update({ status: "queued" }).eq("id", productionId);
    toast.success(`Vai refazer a partir de "${STEPS.find((s) => s.id === failedStep)?.label}", mantendo o que já estava pronto`);
    qc.invalidateQueries({ queryKey: ["job", productionId] });
    qc.invalidateQueries({ queryKey: ["prods"] });
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{JOB_STATUS_LABEL[job.status] ?? job.status}{stepLabel && job.status !== "done" ? ` — ${stepLabel}` : ""}</span>
        <span className="text-muted-foreground">etapa {Math.min(done + (job.status === "done" ? 0 : 1), STEPS.length)} de {STEPS.length}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${(done / STEPS.length) * 100}%` }} /></div>
      {job.wait_reason && job.status !== "done" && <div className="text-muted-foreground">{job.wait_reason}</div>}
      {job.status === "queued" && !online && <div className="text-warning">O agente do PC está desligado. Abra o run.bat para ele pegar esta tarefa.</div>}
      {fe && (
        <div className="space-y-2 rounded border border-destructive/40 bg-destructive/10 p-2">
          <div className="font-medium text-destructive">{fe.title}</div>
          <div>{fe.hint}</div>
          <div className="flex gap-2">
            <button className={btn} onClick={retry}>Tentar de novo desta etapa</button>
            <button className={btn} onClick={() => setDetails(!details)}>{details ? "Esconder detalhes" : "Ver detalhes"}</button>
          </div>
          {details && <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">{job.error}</pre>}
        </div>
      )}
      {!!logs?.length && job.status !== "done" && (
        <ul className="space-y-0.5 text-muted-foreground">
          {logs.slice(0, 4).map((l) => (
            <li key={l.id} className={l.level === "error" ? "text-destructive" : l.level === "warn" ? "text-warning" : ""}>
              {new Date(l.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · {l.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
