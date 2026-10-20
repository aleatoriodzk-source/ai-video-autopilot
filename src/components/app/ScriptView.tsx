import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { WORDS_PER_SECOND, countWords } from "@/lib/duration";

type Script = { title?: string; hook?: string; cta?: string; notes?: string; references?: { claim: string; how_to_verify: string }[] };

/** Full readable script: hook, every scene's narration in order, CTA and fact-check list. */
export function ScriptView({ productionId, script, targetSeconds }: { productionId: string; script: Script; targetSeconds: number }) {
  const { data: scenes } = useQuery({
    queryKey: ["scenes", productionId],
    queryFn: async () => (await supabase.from("scenes").select("*").eq("production_id", productionId).order("idx")).data ?? [],
  });
  const list = scenes ?? [];
  const words = countWords(list);
  const secs = Math.round(words / WORDS_PER_SECOND);
  const short = targetSeconds && secs < targetSeconds * 0.9;
  const text = [script.title, "", ...list.map((s) => s.narration)].join("\n");

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{list.length} cenas · {words} palavras · ~{secs}s de fala{targetSeconds ? ` (pedido: ${targetSeconds}s)` : ""}</span>
        <button className="rounded-md border border-border px-2 py-1 hover:bg-accent" onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Roteiro copiado"))}>Copiar roteiro</button>
      </div>
      {short ? <div className="text-xs text-warning">O roteiro está mais curto que o pedido. Clique em "Refazer roteiro" ou aumente as falas das cenas.</div> : null}
      {script.hook ? <Block label="Gancho (primeiros segundos)">{script.hook}</Block> : null}
      <div>
        <div className="mb-1 text-xs font-medium text-primary">Narração completa</div>
        <ol className="space-y-2">
          {list.map((s) => (
            <li key={s.id} className="grid grid-cols-[2rem_1fr] gap-2">
              <span className="text-xs text-muted-foreground">#{s.idx + 1}</span>
              <div>
                <p>{s.narration}</p>
                <p className="text-xs text-muted-foreground">Imagem: {s.visual_description || s.visual_query || "—"}{s.sfx ? ` · Som: ${s.sfx}` : ""}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {script.cta ? <Block label="Chamada final (CTA)">{script.cta}</Block> : null}
      {script.references?.length ? (
        <div>
          <div className="mb-1 text-xs font-medium text-primary">Fatos para conferir</div>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            {script.references.map((r, i) => <li key={i}><span className="font-medium">{r.claim}</span> — {r.how_to_verify}</li>)}
          </ul>
        </div>
      ) : null}
      {script.notes ? <Block label="Observações da IA">{script.notes}</Block> : null}
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-primary">{label}</div>
      <p>{children}</p>
    </div>
  );
}
