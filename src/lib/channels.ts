// Canais dark e o padrão (voz/legenda/filtro) de cada um, guardados na conta (user_settings.data) com cópia local.
import { supabase } from "@/integrations/supabase/client";

export type Canal = { name: string; niche: string };
export type CanalLook = Record<string, { voice?: string; voiceId?: string; rate?: string | number; color?: string; caption?: string }>;

async function read(): Promise<{ uid: string; data: Record<string, unknown> } | null> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return null;
  const { data } = await supabase.from("user_settings").select("data").maybeSingle();
  return { uid: u.user.id, data: ((data?.data as Record<string, unknown>) ?? {}) };
}

export async function pullChannels() {
  const r = await read();
  if (!r) return;
  const canais = r.data["canais"] as Canal[] | undefined;
  const look = r.data["canal_look"] as CanalLook | undefined;
  const local = JSON.parse(localStorage.getItem("canais-dark") || "[]") as Canal[];
  if (canais?.length) localStorage.setItem("canais-dark", JSON.stringify(canais));
  else if (local.length) await pushChannels(); // primeira vez: sobe o que já existia no aparelho
  if (look) localStorage.setItem("canal-look", JSON.stringify(look));
  if (typeof r.data["canal_atual"] === "string" && !localStorage.getItem("canal-atual")) localStorage.setItem("canal-atual", r.data["canal_atual"] as string);
}

export async function pushChannels() {
  const r = await read();
  if (!r) return;
  const data = {
    ...r.data,
    canais: JSON.parse(localStorage.getItem("canais-dark") || "[]"),
    canal_look: JSON.parse(localStorage.getItem("canal-look") || "{}"),
    canal_atual: localStorage.getItem("canal-atual") || "",
  };
  await supabase.from("user_settings").upsert({ user_id: r.uid, data: data as never });
}
