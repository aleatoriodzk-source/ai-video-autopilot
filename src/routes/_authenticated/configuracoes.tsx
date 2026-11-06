import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app/ui";
import { deleteKey, listKeys, saveKey, testSavedKey } from "@/lib/keys.functions";
import { mergeSettings } from "@/lib/settings";

export const Route = createFileRoute("/_authenticated/configuracoes")({
  head: () => ({
    meta: [
      { title: "Chaves de IA — Estúdio Automático" },
      { name: "description", content: "Adicione suas chaves do Gemini, ChatGPT e Claude e escolha qual IA usar." },
      { property: "og:title", content: "Chaves de IA — Estúdio Automático" },
      { property: "og:description", content: "Adicione suas chaves do Gemini, ChatGPT e Claude e escolha qual IA usar." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Config,
});

const PROVIDERS = [
  { id: "gemini", name: "Gemini (Google)", hint: "Tem plano gratuito. Pegue em aistudio.google.com → Get API key. Pode colar 2 ou 3 chaves separadas por vírgula: elas se revezam sozinhas.", ph: "AIza... ou AQ..." },
  { id: "openai", name: "ChatGPT (OpenAI)", hint: "Pago por uso. Pegue em platform.openai.com → API keys.", ph: "sk-..." },
  { id: "anthropic", name: "Claude (Anthropic)", hint: "Pago por uso. Pegue em console.anthropic.com → API Keys.", ph: "sk-ant-..." },
  { id: "elevenlabs", name: "ElevenLabs (voz clonada, opcional)", hint: "Opcional. Clona a voz na nuvem sem placa de vídeo. Sem chave, usa as vozes grátis. Pegue em elevenlabs.io → API Keys.", ph: "sk_..." },
] as const;

const CHOICES = [
  { id: "auto", label: "Automático (usa a primeira chave que funcionar)" },
  { id: "gemini", label: "Gemini" },
  { id: "openai", label: "ChatGPT" },
  { id: "anthropic", label: "Claude" },
  { id: "lovable", label: "Créditos da plataforma" },
];

const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

function Config() {
  const qc = useQueryClient();
  const { data: k } = useQuery({ queryKey: ["api-keys"], queryFn: () => listKeys() });
  const { data: settings } = useQuery({
    queryKey: ["user-settings"],
    queryFn: async () => (await supabase.from("user_settings").select("data").maybeSingle()).data?.data ?? {},
  });
  const s = mergeSettings(settings);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function choose(id: string) {
    const { data: u } = await supabase.auth.getUser();
    const data = { ...(settings as object), ai: { ...s.ai, text_provider: id } };
    const { error } = await supabase.from("user_settings").upsert({ user_id: u.user!.id, data: data as never });
    if (error) { toast.error(error.message); return; }
    toast.success("IA padrão atualizada");
    qc.invalidateQueries({ queryKey: ["user-settings"] });
  }

  async function act(id: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(id);
    try {
      const r = await fn();
      if (r.ok) { toast.success(ok); setVals((v) => ({ ...v, [id]: "" })); qc.invalidateQueries({ queryKey: ["api-keys"] }); }
      else toast.error(r.error ?? "Erro");
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Chaves de IA" subtitle="Use suas próprias chaves para escrever roteiros e analisar vídeos sem depender dos créditos da plataforma. Se uma IA estiver fora do ar, o sistema tenta de novo e depois passa para a próxima." />

      <div className="panel space-y-2 p-4">
        <div className="text-sm font-medium">IA padrão</div>
        <select value={s.ai.text_provider} onChange={(e) => choose(e.target.value)} className={input + " max-w-md"}>
          {CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">Você também pode escolher outra IA em cada produção.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {PROVIDERS.map((p) => {
          const saved = k?.keys[p.id];
          const platform = p.id === "gemini" && !saved && k?.platformGemini;
          return (
            <div key={p.id} className="panel space-y-3 p-4">
              <div className="flex items-center justify-between">
                <div className="font-medium">{p.name}</div>
                <span className={"rounded px-2 py-0.5 text-[10px] " + (saved || platform ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
                  {saved ? `salva ••••${saved.last4}` : platform ? "chave do projeto" : "sem chave"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{p.hint}</p>
              <input type="password" autoComplete="off" placeholder={p.ph} value={vals[p.id] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [p.id]: e.target.value }))} className={input} />
              <div className="flex flex-wrap gap-2">
                <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={busy === p.id || !(vals[p.id] ?? "").trim()} onClick={() => act(p.id, () => saveKey({ data: { provider: p.id, key: vals[p.id]! } }), "Chave testada e salva")}>
                  {busy === p.id ? "Testando…" : "Testar e salvar"}
                </button>
                {(saved || platform) && <button className={btn} disabled={busy === p.id} onClick={() => act(p.id, () => testSavedKey({ data: { provider: p.id } }), "Conexão funcionando")}>Testar</button>}
                {saved && <button className={btn + " text-destructive"} disabled={busy === p.id} onClick={() => act(p.id, () => deleteKey({ data: { provider: p.id } }), "Chave removida")}>Remover</button>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">As chaves ficam guardadas só no servidor; depois de salvas, o site mostra apenas os 4 últimos caracteres.</p>
    </div>
  );
}
