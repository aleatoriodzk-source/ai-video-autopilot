import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { geminiKeyStatus } from "@/lib/keys.functions";
import { cn } from "@/lib/utils";

const COLOR: Record<string, string> = { ok: "bg-success", minute: "bg-warning", busy: "bg-warning", daily: "bg-destructive", invalid: "bg-destructive" };

/** Aviso fixo no menu: estado da(s) chave(s) gratuita(s) do Gemini. */
export function KeyStatus() {
  const fn = useServerFn(geminiKeyStatus);
  const q = useQuery({ queryKey: ["gemini-status"], queryFn: () => fn(), refetchInterval: 10 * 60_000, staleTime: 5 * 60_000 });
  const keys = q.data?.keys ?? [];
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <div className="flex items-center justify-between">
        <span>Chave gratuita (Gemini)</span>
        <button onClick={() => q.refetch()} aria-label="Testar chave agora" className="hover:text-foreground">
          <RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} />
        </button>
      </div>
      {q.isLoading ? <div>Testando…</div> : keys.length === 0 ? <div className="text-destructive">Nenhuma chave cadastrada</div> : keys.map((k) => (
        <div key={k.last4} className="flex items-center gap-2" title={k.msg}>
          <span className={cn("h-2 w-2 shrink-0 rounded-full", COLOR[k.state] ?? "bg-muted")} />
          <span className="truncate">••••{k.last4}: {k.msg}</span>
        </div>
      ))}
    </div>
  );
}
