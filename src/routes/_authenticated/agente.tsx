import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, Copy, Download, KeyRound, Monitor, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { agentOnline } from "@/lib/jobs";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/agente")({
  head: () => ({
    meta: [
      { title: "Agente local — Estúdio Automático" },
      { name: "description", content: "Conecte o agente Python do seu computador ao painel." },
      { property: "og:title", content: "Agente local — Estúdio Automático" },
      { property: "og:description", content: "Pareamento seguro do agente local." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentePage,
});

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `est_${b64}`;
}

function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
    >
      {ok ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {ok ? "Copiado" : label}
    </button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-background p-3 pr-24 font-mono text-xs">{children}</pre>
      <div className="absolute right-2 top-2"><CopyButton text={children} /></div>
    </div>
  );
}

function AgentePage() {
  const qc = useQueryClient();
  const [name, setName] = useState("Meu PC");
  const [token, setToken] = useState<string | null>(null);
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const { data, error } = await supabase.from("agents").select("id,name,token_prefix,last_seen_at,info,revoked,created_at").order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    refetchInterval: 10_000,
  });

  const create = useMutation({
    mutationFn: async () => {
      const t = newToken();
      const { error } = await supabase.from("agents").insert({ name: name.trim() || "Meu PC", token_hash: await sha256(t), token_prefix: t.slice(0, 10) });
      if (error) throw error;
      return t;
    },
    onSuccess: (t) => {
      setToken(t);
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["agents-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("agents").update({ revoked: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agents"] }); toast.success("Token revogado"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("agents").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const active = agents.filter((a) => !a.revoked);
  const online = active.some((a) => agentOnline(a.last_seen_at));
  const apiUrl = `${origin}/api/public/agent`;
  const config = JSON.stringify({ api_url: apiUrl, token: token ?? "COLE_SEU_TOKEN_AQUI", output_dir: "C:\\EstudioAutomatico\\videos" }, null, 2);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">Agente local</h1>
        <p className="text-sm text-muted-foreground">O programa no seu computador baixa vídeos, gera a narração e renderiza com FFmpeg. O painel não acessa seu PC sem ele.</p>
      </div>

      <div className="panel flex items-center gap-4 p-5">
        <div className={cn("grid h-11 w-11 place-items-center rounded-full", online ? "bg-success/15" : "bg-destructive/15")}>
          <Monitor className={cn("h-5 w-5", online ? "text-success" : "text-destructive")} />
        </div>
        <div>
          <div className="font-medium">{online ? "Agente conectado" : "Nenhum agente conectado"}</div>
          <div className="text-xs text-muted-foreground">
            {online ? "Recebendo sinais do seu computador." : active.length ? "Há tokens criados, mas nenhum agente enviou sinal recentemente." : "Gere um token abaixo para parear seu computador."}
          </div>
        </div>
      </div>

      <section className="panel space-y-4 p-5">
        <h2 className="flex items-center gap-2 font-display font-semibold"><KeyRound className="h-4 w-4 text-primary" /> Gerar token de conexão</h2>
        <div className="flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Nome do computador" className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm" />
          <button disabled={create.isPending} onClick={() => create.mutate()} className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {create.isPending ? "Gerando..." : "Gerar token"}
          </button>
        </div>
        {token && (
          <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-4">
            <div className="text-sm font-medium">Copie agora — este token não será mostrado de novo.</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background p-2 font-mono text-xs">{token}</code>
              <CopyButton text={token} label="Copiar token" />
            </div>
            <p className="text-xs text-muted-foreground">Guardamos apenas uma impressão criptográfica dele. Se perder, revogue e gere outro.</p>
          </div>
        )}
      </section>

      <section className="panel space-y-3 p-5">
        <h2 className="font-display font-semibold">Computadores pareados</h2>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum token criado ainda.</p>
        ) : (
          <ul className="divide-y divide-border">
            {agents.map((a) => {
              const on = !a.revoked && agentOnline(a.last_seen_at);
              const info = (a.info ?? {}) as Record<string, unknown>;
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className={cn("h-2 w-2 rounded-full", a.revoked ? "bg-muted-foreground" : on ? "bg-success" : "bg-destructive")} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{a.name} <span className="font-mono text-xs text-muted-foreground">{a.token_prefix}…</span></div>
                    <div className="text-xs text-muted-foreground">
                      {a.revoked ? "Revogado" : on ? "Conectado" : "Desconectado"} · último sinal: {a.last_seen_at ? new Date(a.last_seen_at).toLocaleString("pt-BR") : "nunca"}
                      {Object.keys(info).length > 0 && ` · ${Object.entries(info).slice(0, 4).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}`}
                    </div>
                  </div>
                  {!a.revoked ? (
                    <button onClick={() => revoke.mutate(a.id)} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent">Revogar</button>
                  ) : (
                    <button onClick={() => remove.mutate(a.id)} aria-label="Excluir" className="rounded-md border border-border p-1.5 hover:bg-accent"><Trash2 className="h-3.5 w-3.5" /></button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel space-y-3 p-5">
        <h2 className="font-display font-semibold">Arquivos do agente</h2>
        <p className="text-sm text-muted-foreground">Pacote com agent.py, config.json, install_windows.bat, run.bat, requirements.txt e módulos de voz, imagens e montagem.</p>
        <div className="flex flex-wrap gap-2">
          <a href="/downloads/agente-estudio-windows.zip" download="agente-estudio-windows.zip" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
            <Download className="h-4 w-4" /> Baixar arquivos do Agente (.zip)
          </a>
          <button
            onClick={() => {
              const url = URL.createObjectURL(new Blob([config], { type: "application/json" }));
              const a = document.createElement("a");
              a.href = url; a.download = "config.json"; document.body.appendChild(a); a.click(); a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 30_000);
            }}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-4 text-sm hover:bg-accent"
          >
            <Download className="h-4 w-4" /> Baixar config.json {token ? "(com seu token)" : "(sem token)"}
          </button>
        </div>
      </section>

      <section className="panel space-y-4 p-5">
        <h2 className="font-display font-semibold">Como conectar no Windows</h2>
        <ol className="list-decimal space-y-4 pl-5 text-sm">
          <li>Clique em <b>Baixar arquivos do Agente (.zip)</b>, abra Downloads, clique com o botão direito no arquivo → <b>Extrair tudo</b> → escolha <code>C:\</code>. Vai criar <code>C:\EstudioAutomatico</code>.</li>
          <li>Clique em <b>Gerar token</b> acima e depois em <b>Baixar config.json (com seu token)</b>. Substitua o <code>config.json</code> da pasta por esse (ou cole este conteúdo nele):
            <Code>{config}</Code>
          </li>
          <li>Dê dois cliques em <code>install_windows.bat</code> (instala Python 3.12 se faltar, bibliotecas e a voz em português). Espere terminar.</li>
          <li>Dê dois cliques em <code>run.bat</code> e deixe a janela aberta.</li>
          <li>Em até 30 segundos o status acima muda para <b>Agente conectado</b>.</li>
        </ol>
      </section>
    </div>
  );
}
