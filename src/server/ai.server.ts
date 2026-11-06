// Server-only Lovable AI Gateway helpers (raw HTTP, streamed Responses API).
const GATEWAY = "https://ai.gateway.lovable.dev";
export const TEXT_MODEL = "openai/gpt-6-astra";

export class AiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function key() {
  const k = process.env["LOVABLE_API_KEY"];
  if (!k) throw new AiError(401, "LOVABLE_API_KEY não configurada no servidor");
  return k;
}

export type Usage = { input_tokens: number; output_tokens: number; total_tokens: number };

export type ProviderId = "gemini" | "openai" | "anthropic" | "lovable";
export type AiKeys = Partial<Record<"gemini" | "openai" | "anthropic", string | undefined>>;
type AiOpts = { system: string; user: string; schemaName: string; schema: Record<string, unknown>; images?: string[] };

const RETRY = new Set([408, 429, 500, 502, 503, 504, 529]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Order of providers to try: the chosen one first, then every other one that has a key, then platform credits. */
export function providerOrder(choice: string, keys: AiKeys): ProviderId[] {
  const own = (["gemini", "openai", "anthropic"] as const).filter((p) => keys[p]);
  const first = choice !== "auto" && (choice === "lovable" || own.includes(choice as never)) ? [choice as ProviderId] : [];
  return [...new Set<ProviderId>([...first, ...own, "lovable"])];
}

/** Calls the AI with retries (temporary errors) and automatic fallback to the next provider. */
export async function aiJson<T>(opts: AiOpts & { keys?: AiKeys; provider?: string }): Promise<{ data: T; usage: Usage; provider: string }> {
  const keys: AiKeys = { gemini: process.env["GEMINI_API_KEY"], ...(opts.keys ?? {}) };
  const errors: string[] = [];
  for (const p of providerOrder(opts.provider ?? "auto", keys)) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r =
          p === "gemini" ? await geminiJson<T>(opts, keys.gemini!)
          : p === "openai" ? await openaiJson<T>(opts, keys.openai!)
          : p === "anthropic" ? await claudeJson<T>(opts, keys.anthropic!)
          : await lovableJson<T>(opts);
        return { ...r, provider: p };
      } catch (e) {
        const st = e instanceof AiError ? e.status : 0;
        const temp = RETRY.has(st) || st === 0;
        if (!temp || attempt === 3) { errors.push(`${p}: ${(e as Error).message.slice(0, 160)}`); break; }
        await sleep(2000 * 2 ** attempt);
      }
    }
  }
  throw new AiError(502, "Nenhuma IA respondeu. " + errors.join(" | "));
}

async function openaiJson<T>(opts: AiOpts, key: string): Promise<{ data: T; usage: Usage }> {
  const content: Record<string, unknown>[] = [{ type: "text", text: opts.user }];
  for (const url of opts.images ?? []) content.push({ type: "image_url", image_url: { url } });
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env["OPENAI_MODEL"] || "gpt-5-mini",
      messages: [{ role: "system", content: opts.system }, { role: "user", content }],
      response_format: { type: "json_schema", json_schema: { name: opts.schemaName, schema: opts.schema, strict: true } },
    }),
  });
  if (!res.ok) throw new AiError(res.status, `ChatGPT respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as any;
  const text = j.choices?.[0]?.message?.content ?? "";
  if (!text) throw new AiError(422, "O ChatGPT não retornou conteúdo");
  const u = j.usage ?? {};
  return { data: JSON.parse(text) as T, usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? 0 } };
}

async function claudeJson<T>(opts: AiOpts, key: string): Promise<{ data: T; usage: Usage }> {
  const content: Record<string, unknown>[] = [];
  for (const url of opts.images ?? []) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  content.push({ type: "text", text: opts.user });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env["ANTHROPIC_MODEL"] || "claude-sonnet-4-5",
      max_tokens: 16000,
      system: opts.system,
      messages: [{ role: "user", content }],
      tools: [{ name: opts.schemaName, description: "Responda preenchendo este formato.", input_schema: opts.schema }],
      tool_choice: { type: "tool", name: opts.schemaName },
    }),
  });
  if (!res.ok) throw new AiError(res.status, `Claude respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as any;
  const block = (j.content ?? []).find((b: any) => b.type === "tool_use");
  if (!block) throw new AiError(422, "O Claude não retornou conteúdo");
  const u = j.usage ?? {};
  return { data: block.input as T, usage: { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) } };
}

async function lovableJson<T>(opts: AiOpts): Promise<{ data: T; usage: Usage }> {
  const content: Record<string, unknown>[] = [{ type: "input_text", text: opts.user }];
  for (const url of opts.images ?? []) content.push({ type: "input_image", image_url: url });
  const res = await fetch(`${GATEWAY}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": key(), "X-Lovable-AIG-SDK": "fetch" },
    body: JSON.stringify({
      model: TEXT_MODEL,
      stream: true,
      store: false,
      reasoning: { effort: opts.schemaName === "script" ? "medium" : "low" },
      input: [
        { role: "system", content: opts.system },
        { role: "user", content },
      ],
      text: { format: { type: "json_schema", name: opts.schemaName, schema: opts.schema, strict: true } },
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new AiError(res.status, `IA respondeu ${res.status}: ${t.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: any;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      if (ev.type === "response.output_text.delta") text += ev.delta ?? "";
      else if (ev.type === "response.completed" && ev.response?.usage) usage = ev.response.usage;
      else if (ev.type === "response.failed" || ev.type === "error")
        throw new AiError(502, ev.response?.error?.message ?? ev.message ?? "Falha na IA");
      else if (ev.type === "response.refusal.delta") throw new AiError(422, "A IA recusou a solicitação");
    }
  }
  if (!text.trim()) throw new AiError(422, "A IA não retornou conteúdo");
  return { data: JSON.parse(text) as T, usage };
}

export async function aiImage(prompt: string, aspect: string, model: string): Promise<string> {
  const size = (aspect === "9:16" || aspect === "3:4") ? "1024x1536" : aspect === "16:9" ? "1536x1024" : "1024x1024";
  const res = await fetch(`${GATEWAY}/v1/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size }),
  });
  if (!res.ok) throw new AiError(res.status, `Imagem IA ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new AiError(422, "Nenhuma imagem retornada");
  return b64;
}

/** Várias chaves gratuitas separadas por vírgula/linha: alterna sozinho se uma bater no limite (429/503). */
export const splitKeys = (key: string) => key.split(/[\s,;]+/).map((k) => k.trim()).filter((k) => k.length >= 10);
let rot = 0;
async function geminiJson<T>(opts: AiOpts, key: string): Promise<{ data: T; usage: Usage }> {
  const ks = splitKeys(key);
  if (ks.length <= 1) return geminiOne<T>(opts, key.trim());
  const start = rot++ % ks.length;
  let last: unknown;
  for (let i = 0; i < ks.length; i++) {
    try {
      return await geminiOne<T>(opts, ks[(start + i) % ks.length]);
    } catch (e) {
      last = e;
      if (!(e instanceof AiError) || ![429, 503, 500, 403].includes(e.status)) throw e;
    }
  }
  throw last;
}

/** Estado de cada chave Gemini: ok, limite por minuto, cota do dia esgotada ou inválida. */
export async function geminiStatus(key: string): Promise<{ last4: string; state: "ok" | "minute" | "daily" | "busy" | "invalid"; msg: string }[]> {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  return Promise.all(splitKeys(key).map(async (k) => {
    const last4 = k.slice(-4);
    try {
      await geminiOne({ system: "JSON.", user: "ok=true", schemaName: "t", schema }, k);
      return { last4, state: "ok" as const, msg: "Pronta" };
    } catch (e) {
      const m = (e as Error).message;
      const st = e instanceof AiError ? e.status : 0;
      if (st === 429) return /per ?day|PerDay|daily/i.test(m) ? { last4, state: "daily" as const, msg: "Cota do dia esgotada" } : { last4, state: "minute" as const, msg: "Limite por minuto — aguarde 60s" };
      if (st === 503 || st === 500) return { last4, state: "busy" as const, msg: "Google sobrecarregado agora" };
      return { last4, state: "invalid" as const, msg: m.slice(0, 120) };
    }
  }));
}

async function geminiOne<T>(opts: AiOpts, key: string): Promise<{ data: T; usage: Usage }> {
  const parts: Record<string, unknown>[] = [{ text: opts.user }];
  for (const url of opts.images ?? []) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  // flash-lite vive sobrecarregado (503); tenta flash primeiro e alterna se oscilar
  const models = [process.env["GEMINI_MODEL"], "gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.5-flash-lite"].filter(Boolean) as string[];
  let res!: Response;
  for (const model of [...new Set(models)]) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: opts.schema },
      }),
    });
    if (res.ok || ![503, 500, 404].includes(res.status)) break;
  }
  if (!res.ok) throw new AiError(res.status, `Gemini respondeu ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const j = (await res.json()) as any;
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
  if (!text.trim()) throw new AiError(422, "O Gemini não retornou conteúdo");
  const u = j.usageMetadata ?? {};
  return { data: JSON.parse(text) as T, usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: u.candidatesTokenCount ?? 0, total_tokens: u.totalTokenCount ?? 0 } };
}

/** Small real request to check that a key works. */
export async function testProvider(p: "gemini" | "openai" | "anthropic" | "elevenlabs", key: string): Promise<void> {
  if (p === "elevenlabs") {
    const r = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": key } });
    if (!r.ok) throw new Error(`ElevenLabs respondeu ${r.status}: ${(await r.text()).slice(0, 150)}`);
    return;
  }
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const o: AiOpts = { system: "Responda em JSON.", user: "Responda ok=true.", schemaName: "teste", schema };
  if (p === "gemini") await geminiJson(o, key);
  else if (p === "openai") await openaiJson(o, key);
  else await claudeJson(o, key);
}
