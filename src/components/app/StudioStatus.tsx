import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { activeJob, agentOnline } from "@/lib/jobs";
import { STEPS } from "@/lib/pipeline";

const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent";

/** Robot online badge + live step of the current job + final MP4 shortcut, shown inside the Studio bar. */
export function StudioStatus({ productionId }: { productionId: string }) {
  const [open, setOpen] = useState(false);
  const { data: agents } = useQuery({ queryKey: ["agents-status"], queryFn: async () => (await supabase.from("agents").select("last_seen_at").eq("revoked", false)).data ?? [], refetchInterval: 30_000 });
  const { data: job } = useQuery({ queryKey: ["job", productionId], queryFn: () => activeJob(productionId), refetchInterval: 5000 });
  const { data: url } = useQuery({
    queryKey: ["final-url", productionId, job?.status],
    queryFn: async () => {
      const { data: p } = await supabase.from("productions").select("preview_path").eq("id", productionId).maybeSingle();
      if (!p?.preview_path) return null;
      return (await supabase.storage.from("media").createSignedUrl(p.preview_path, 3600)).data?.signedUrl ?? null;
    },
  });
  const online = (agents ?? []).some((a) => agentOnline(a.last_seen_at));
  const running = job && ["queued", "running"].includes(job.status);
  const done = job?.completed_steps?.length ?? 0;
  const step = STEPS.find((s) => s.id === job?.step)?.label ?? job?.step;
  return (
    <>
      <span className="flex items-center gap-1 text-muted-foreground" title={online ? "" : "Abra o run.bat no PC"}>
        <span className={"h-2 w-2 rounded-full " + (online ? "bg-success" : "bg-destructive")} />{online ? "Robô ligado" : "Robô desligado"}
      </span>
      {running && <span className="flex items-center gap-1 text-muted-foreground">{step ?? "Na fila"} <span className="inline-block h-1.5 w-16 overflow-hidden rounded bg-muted"><span className="block h-full bg-primary" style={{ width: `${(done / STEPS.length) * 100}%` }} /></span></span>}
      {url && <button className={btn} onClick={() => setOpen(true)}>▶ Vídeo final</button>}
      {open && url && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-2xl space-y-2 rounded-lg border border-border bg-card p-3" onClick={(e) => e.stopPropagation()}>
            <video src={url} controls autoPlay className="max-h-[75vh] w-full rounded bg-muted" />
            <div className="flex gap-2"><a href={url} download className={btn}>Baixar MP4</a><button className={btn} onClick={() => setOpen(false)}>Fechar</button></div>
          </div>
        </div>
      )}
    </>
  );
}
