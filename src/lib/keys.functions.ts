import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const PROVIDERS = ["gemini", "openai", "anthropic", "elevenlabs"] as const;
type P = (typeof PROVIDERS)[number];
const check = (p: string): P => {
  if (!PROVIDERS.includes(p as P)) throw new Error("Provedor inválido");
  return p as P;
};

/** Lists which keys are saved, showing only the last 4 characters. */
export const listKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("user_api_keys").select("provider,api_key,updated_at").eq("user_id", context.userId);
    const out: Record<string, { last4: string; updated_at: string } | null> = { gemini: null, openai: null, anthropic: null, elevenlabs: null };
    for (const r of data ?? []) out[r.provider] = { last4: r.api_key.trim().slice(-4), updated_at: r.updated_at };
    return { keys: out, platformGemini: !!process.env["GEMINI_API_KEY"] };
  });

export const saveKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { provider: string; key: string }) => ({ provider: check(i.provider), key: String(i.key ?? "").trim() }))
  .handler(async ({ data, context }) => {
    if (data.key.length < 10 || data.key.length > 3000) return { ok: false as const, error: "Chave inválida" };
    const { testProvider } = await import("@/server/ai.server");
    try {
      await testProvider(data.provider, data.key);
    } catch (e) {
      return { ok: false as const, error: "A chave não funcionou: " + (e as Error).message.slice(0, 200) };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("user_api_keys").upsert({ user_id: context.userId, provider: data.provider, api_key: data.key, updated_at: new Date().toISOString() });
    return error ? { ok: false as const, error: error.message } : { ok: true as const };
  });

export const deleteKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { provider: string }) => ({ provider: check(i.provider) }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_api_keys").delete().eq("user_id", context.userId).eq("provider", data.provider);
    return { ok: true as const };
  });

export const testSavedKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { provider: string }) => ({ provider: check(i.provider) }))
  .handler(async ({ data, context }) => {
    const { loadKeys } = await import("@/server/tasks.server");
    const k = ((await loadKeys(context.userId)) as Record<string, string | undefined>)[data.provider] ?? (data.provider === "gemini" ? process.env["GEMINI_API_KEY"] : undefined);
    if (!k) return { ok: false as const, error: "Nenhuma chave salva" };
    const { testProvider } = await import("@/server/ai.server");
    try {
      await testProvider(data.provider, k);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message.slice(0, 250) };
    }
  });

/** Monitor da chave gratuita Gemini (uma ou várias): mostra se está pronta, no limite do minuto ou sem cota. */
export const geminiKeyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadKeys } = await import("@/server/tasks.server");
    const k = ((await loadKeys(context.userId)) as Record<string, string | undefined>).gemini ?? process.env["GEMINI_API_KEY"];
    if (!k) return { keys: [] as { last4: string; state: string; msg: string }[] };
    const { geminiStatus } = await import("@/server/ai.server");
    return { keys: await geminiStatus(k) };
  });
