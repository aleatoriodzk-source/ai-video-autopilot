/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type RadarItem = { id: string; title: string; views: number; url: string; thumb: string; age?: string; hours?: number; velocity?: number; channel?: string };

// "8,7 mil visualizações" / "1,2 mi de visualizações" / "532 visualizações" -> número
export function parseViews(t: string): number {
  const m = t.match(/(\d[\d.,]*)\s*(mil|mi|bi|k|m|b)?\w*\s*(de\s+)?(visualiza|views)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]!.replace(/\./g, "").replace(",", "."));
  const u = (m[2] ?? "").toLowerCase();
  return Math.round(n * (u === "mil" || u === "k" ? 1e3 : u === "mi" || u === "m" ? 1e6 : u === "bi" || u === "b" ? 1e9 : 1));
}

export function extractShorts(html: string): RadarItem[] {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];
  const out: RadarItem[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, any>;
    const s = r["shortsLockupViewModel"];
    if (s) {
      const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId as string | undefined;
      const acc = String(s.accessibilityText ?? "");
      const title = acc.split(/,\s*[\d.,]+\s*(mil|mi|bi)?\s*(de\s+)?visualiza/i)[0]!.trim();
      if (id) out.push({ id, title, views: parseViews(acc), url: `https://www.youtube.com/shorts/${id}`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
    }
    Object.values(r).forEach(walk);
  };
  walk(JSON.parse(m[1]!));
  return out;
}

// "há 3 horas" / "2 days ago" -> horas
export function ageHours(t: string): number {
  const m = t.match(/(\d+)\s*(segundo|second|minuto|minute|hora|hour|dia|day|semana|week|m[eê]s|month|ano|year)/i);
  if (!m) return 0;
  const n = +m[1]!; const u = m[2]!.toLowerCase();
  const k = /^seg|^sec/.test(u) ? 1 / 3600 : /^min/.test(u) ? 1 / 60 : /^hor|^hou/.test(u) ? 1 : /^d/.test(u) ? 24 : /^se|^w/.test(u) ? 168 : /^m/.test(u) ? 720 : 8760;
  return n * k;
}

// vídeos longos (videoRenderer) com idade e velocidade de views por hora
export function extractLong(html: string, channel?: string): RadarItem[] {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];
  const out: RadarItem[] = [];
  const txt = (x: any): string => String(x?.simpleText ?? (x?.runs ?? []).map((r: any) => r.text).join("") ?? "");
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, any>;
    const v = r["videoRenderer"];
    if (v?.videoId) {
      const age = txt(v.publishedTimeText); const hours = ageHours(age); const views = parseViews(txt(v.viewCountText) + " visualizações");
      out.push({ id: v.videoId, title: txt(v.title), views, url: `https://www.youtube.com/watch?v=${v.videoId}`, thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        age, hours, velocity: hours ? Math.round(views / Math.max(1, hours)) : 0, channel: channel ?? txt(v.ownerText) });
      return;
    }
    Object.values(r).forEach(walk);
  };
  walk(JSON.parse(m[1]!));
  return out;
}

const YT_HEADERS = { "Accept-Language": "pt-BR,pt;q=0.9", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", Cookie: "CONSENT=YES+1" };

// Radar V8 automático: lê os canais de referência do usuário e mostra o que mais acelera (views/hora) nos últimos dias.
export const radarChannels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { maxHours?: number }) => ({ maxHours: Math.min(720, Math.max(24, Number(i?.maxHours) || 168)) }))
  .handler(async ({ data, context }) => {
    const { data: refs } = await context.supabase.from("reference_sources").select("urls,title").eq("kind", "channel").limit(15);
    const chans = [...new Set((refs ?? []).flatMap((r: any) => (r.urls as string[]) ?? []).filter((u) => /youtube\.com\/(@|channel\/|c\/)/.test(u)))]
      .map((u) => u.replace(/\/(videos|shorts|streams|featured)\/?$/, "").replace(/\/$/, ""));
    if (!chans.length) return { items: [] as RadarItem[], error: "Cadastre canais do YouTube na aba Referências para o Radar espiar sozinho" };
    const all = (await Promise.all(chans.map(async (c) => {
      try {
        const r = await fetch(`${c}/videos`, { headers: YT_HEADERS });
        return extractLong(await r.text(), c.split("/").pop()).slice(0, 12);
      } catch { return []; }
    }))).flat();
    const items = all.filter((x) => x.hours && x.hours <= data.maxHours).sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0)).slice(0, 30);
    return { items, error: items.length ? null : "Nenhum vídeo novo nesses canais no período escolhido" };
  });

// Radar V8: Shorts desta semana do nicho, ordenados por visualizações.
export const radarSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { q: string; long?: boolean }) => ({ q: String(i?.q ?? "").trim().slice(0, 100), long: !!i?.long }))
  .handler(async ({ data }) => {
    if (!data.q) return { items: [] as RadarItem[], error: "Digite um nicho" };
    if (data.long) {
      try {
        const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(data.q)}&sp=EgQIBBAB`, { headers: YT_HEADERS });
        const seen = new Set<string>();
        const items = extractLong(await r.text()).filter((x) => !seen.has(x.id) && seen.add(x.id)).sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0)).slice(0, 24);
        return { items, error: items.length ? null : "O YouTube não devolveu resultados agora; tente outro termo" };
      } catch (e) { return { items: [] as RadarItem[], error: `Falha ao consultar o YouTube: ${(e as Error).message}` }; }
    }
    try {
      const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(data.q + " #shorts")}&sp=EgIIAw%253D%253D`, {
        headers: { "Accept-Language": "pt-BR,pt;q=0.9", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", Cookie: "CONSENT=YES+1" },
      });
      const seen = new Set<string>();
      const items = extractShorts(await r.text()).filter((x) => !seen.has(x.id) && seen.add(x.id)).sort((a, b) => b.views - a.views).slice(0, 24);
      return { items, error: items.length ? null : "O YouTube não devolveu resultados agora; tente outro termo" };
    } catch (e) {
      return { items: [] as RadarItem[], error: `Falha ao consultar o YouTube: ${(e as Error).message}` };
    }
  });

export type RadarInsight = {
  thumb_patterns: string[];
  title_patterns: string[];
  titles: { title: string; score: number; trigger: string }[];
  pinned_comment: string;
  hashtags: string[];
  covers: { text: string; layout: string; colors: string }[];
};

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const obj = (p: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(p), properties: p });
const insightSchema = obj({
  thumb_patterns: { type: "array", items: S },
  title_patterns: { type: "array", items: S },
  titles: { type: "array", items: obj({ title: S, score: N, trigger: S }) },
  pinned_comment: S,
  hashtags: { type: "array", items: S },
  covers: { type: "array", items: obj({ text: S, layout: S, colors: S }) },
});

async function toDataUrl(u: string): Promise<string | null> {
  try {
    const r = await fetch(u);
    if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(s)}`;
  } catch { return null; }
}

// V9: lê capas e títulos dos virais do Radar e devolve o padrão + títulos A/B + comentário fixado.
export const radarInsight = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { niche: string; items: { title: string; views: number; thumb: string }[] }) => ({
    niche: String(i?.niche ?? "").slice(0, 100),
    items: (Array.isArray(i?.items) ? i.items : []).slice(0, 6).map((x) => ({ title: String(x.title).slice(0, 200), views: Number(x.views) || 0, thumb: String(x.thumb).startsWith("https://i.ytimg.com/") ? String(x.thumb) : "" })),
  }))
  .handler(async ({ data, context }) => {
    try {
      if (!data.items.length) throw new Error("Busque os virais primeiro");
      const imgs = (await Promise.all(data.items.map((x) => (x.thumb ? toDataUrl(x.thumb) : null)))).filter(Boolean) as string[];
      const { aiJson } = await import("@/server/ai.server");
      const { loadKeys } = await import("@/server/tasks.server");
      const keys = await loadKeys(context.userId);
      const r = await aiJson<RadarInsight>({
        keys,
        schemaName: "radar_insight",
        schema: insightSchema,
        images: imgs,
        system: "Você é estrategista de canais dark virais (sem rosto). Responda em PT-BR, concreto e curto.",
        user:
          `Nicho: "${data.niche}". Estes são os Shorts mais vistos da semana (as imagens são as capas na mesma ordem):\n` +
          data.items.map((x, k) => `${k + 1}. "${x.title}" — ${x.views} views`).join("\n") +
          `\nTarefas: thumb_patterns = 3 a 5 padrões visuais das capas (contraste, cores, texto na capa, close, expressão) para copiar. title_patterns = 3 a 5 padrões dos títulos (gatilhos, tamanho, números, nomes). titles = 3 títulos NOVOS para um vídeo original do nicho, com nota 0-100 de curiosidade e o gatilho usado (mistério, contradição, urgência, número). pinned_comment = um comentário para fixar que provoca respostas. hashtags = 5 hashtags. covers = 3 capas para o vídeo novo copiando o padrão vencedor: text = texto curto na capa (máx 4 palavras), layout = o que aparece e onde (personagem, close, seta, círculo), colors = cores principais.`,
      });
      return { ok: true as const, insight: JSON.parse(JSON.stringify(r.data)) as RadarInsight };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });
