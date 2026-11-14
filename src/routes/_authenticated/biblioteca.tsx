import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Pencil, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app/ui";
import { cn } from "@/lib/utils";
import { cloneCaption, type ClonedCaption } from "@/lib/lab.functions";
import { CAPTIONS, COLORS, DEFAULT_CHOICE, type LibraryChoice } from "@/lib/library-presets";

export const Route = createFileRoute("/_authenticated/biblioteca")({
  head: () => ({
    meta: [
      { title: "Biblioteca — filtros, legendas e efeitos" },
      { name: "description", content: "Escolha filtros de cor, estilos de legenda, efeitos sonoros e trilhas para suas produções." },
      { property: "og:title", content: "Biblioteca — filtros, legendas e efeitos" },
      { property: "og:description", content: "Escolha filtros de cor, estilos de legenda, efeitos sonoros e trilhas para suas produções." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Biblioteca,
});

const KEY = "biblioteca-escolha";
const CLONES = "legendas-clonadas";

async function toDataUrl(f: File): Promise<string> {
  const img = await createImageBitmap(f);
  const sc = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement("canvas"); c.width = img.width * sc; c.height = img.height * sc;
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}

function ClonarLegenda({ active, onPick }: { active: string; onPick: (id: string) => void }) {
  const [list, setList] = useState<(ClonedCaption & { id: string })[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { try { setList(JSON.parse(localStorage.getItem(CLONES) ?? "[]")); } catch { /* vazio */ } }, []);
  const save = (l: typeof list) => { setList(l); localStorage.setItem(CLONES, JSON.stringify(l)); };
  async function go(input: HTMLInputElement) {
    const f = input.files?.[0]; if (!f) return;
    setBusy(true);
    try {
      const r = await cloneCaption({ data: { img: await toDataUrl(f) } });
      if (!r.ok) throw new Error(r.error);
      const item = { ...r.caption, id: `clone-${Date.now()}` };
      save([item, ...list]); onPick(item.id);
      toast.success(`Legenda clonada: ${item.name} (${item.font})`);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); input.value = ""; }
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Clonar legenda por print</h2>
        <label className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
          {busy ? "Lendo o print..." : "Enviar print"}
          <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => go(e.currentTarget)} />
        </label>
      </div>
      <p className="text-sm text-muted-foreground">Mande o print de uma legenda do CapCut, TikTok ou Reels: a IA copia fonte, cores, borda, caixa alta e posição.</p>
      {list.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {list.map((p) => (
            <div key={p.id} className={cn("rounded-lg border p-3", active === p.id ? "border-primary ring-2 ring-primary" : "border-border")}>
              <button className="w-full text-left" onClick={() => onPick(p.id)}>
                <div className="mb-2 flex aspect-video items-center justify-center rounded bg-muted">
                  <span className="px-2 py-1 text-base font-extrabold" style={{ fontFamily: p.font, color: p.color, fontStyle: p.italic ? "italic" : undefined, background: p.box ? "rgba(0,0,0,.75)" : undefined, textShadow: p.box ? undefined : `0 0 3px ${p.outline}, 0 2px 4px ${p.outline}`, textTransform: p.upper ? "uppercase" : undefined }}>
                    isso <span style={{ color: p.highlight }}>mudou</span> tudo
                  </span>
                </div>
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.font} · {p.position} · {p.words_per_block} palavra(s)</div>
              </button>
              <button className="mt-1 text-xs text-muted-foreground underline" onClick={() => save(list.filter((x) => x.id !== p.id))}>Excluir</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type Audio = { name: string; path: string; url: string };

function MeusAudios({ folder, title }: { folder: "sfx" | "musica" | "fontes"; title: string }) {
  const [items, setItems] = useState<Audio[]>([]);
  const [busy, setBusy] = useState(false);
  async function load() {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    const dir = `${u.user.id}/biblioteca/${folder}`;
    const { data } = await supabase.storage.from("media").list(dir, { sortBy: { column: "created_at", order: "desc" } });
    const files = (data ?? []).filter((f) => f.name && !f.name.startsWith("."));
    const out: Audio[] = [];
    for (const f of files) {
      const path = `${dir}/${f.name}`;
      const { data: s } = await supabase.storage.from("media").createSignedUrl(path, 3600);
      out.push({ name: f.name.replace(/^\d+-/, "").replace(/\.[^.]+$/, ""), path, url: s?.signedUrl ?? "" });
    }
    setItems(out);
  }
  useEffect(() => { void load(); }, []);
  async function upload(input: HTMLInputElement) {
    const files = input.files;
    if (!files?.length) return;
    let ok = 0;
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Entre novamente na sua conta");
      for (const file of Array.from(files)) {
        if (!(folder === "fontes" ? /\.(ttf|otf)$/i : /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|mp4|3gp|amr|webm|wma)$/i).test(file.name)) { toast.error(`${file.name}: formato inválido`); continue; }
        if (file.size > 50 * 1024 * 1024) { toast.error(`${file.name}: máximo 50 MB`); continue; }
        const safe = file.name.replace(/[^\w.\-]+/g, "_");
        const up = await supabase.storage.from("media").upload(`${u.user.id}/biblioteca/${folder}/${Date.now()}-${safe}`, file, { contentType: file.type || (folder === "fontes" ? "font/ttf" : "audio/mpeg"), upsert: true });
        if (up.error) throw up.error;
        ok++;
      }
      if (ok) toast.success(ok === 1 ? "Arquivo guardado na Biblioteca" : `${ok} arquivos guardados na Biblioteca`);
      await load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); input.value = ""; }
  }
  async function rename(a: Audio) {
    const novo = window.prompt("Novo nome", a.name)?.trim();
    if (!novo || novo === a.name) return;
    const ext = a.path.match(/\.[^./]+$/)?.[0] ?? "";
    const dir = a.path.slice(0, a.path.lastIndexOf("/"));
    const dest = `${dir}/${Date.now()}-${novo.replace(/[^\wÀ-ú.\- ]+/g, "_").replace(/\s+/g, "-")}${ext}`;
    const { error } = await supabase.storage.from("media").copy(a.path, dest);
    if (error) { toast.error(error.message); return; }
    await supabase.storage.from("media").remove([a.path]);
    toast.success("Nome atualizado");
    await load();
  }
  async function remove(a: Audio) {
    await supabase.storage.from("media").remove([a.path]);
    await load();
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <label className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
          {busy ? "Enviando..." : folder === "fontes" ? "Enviar TTF/OTF" : "Enviar áudio"}
          <input type="file" accept={folder === "fontes" ? ".ttf,.otf" : "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.mp4,.3gp,.amr,.webm"} multiple className="hidden" disabled={busy} onChange={(e) => upload(e.currentTarget)} />
        </label>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum áudio seu ainda. Envie seus próprios arquivos — só sons reais, nada sintetizado.</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {items.map((a) => (
            <div key={a.path} className="flex items-center gap-2 rounded-lg border p-2">
              <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
              {folder === "fontes" ? null : <audio controls preload="none" src={a.url} className="h-8 max-w-[220px]" />}
              <button className="rounded border px-2 py-1 text-xs" onClick={() => rename(a)} aria-label={`Renomear ${a.name}`}><Pencil className="h-3 w-3" /></button>
              <button className="rounded border px-2 py-1 text-xs" onClick={() => remove(a)} aria-label={`Excluir ${a.name}`}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Biblioteca() {
  const [c, setC] = useState<LibraryChoice>(DEFAULT_CHOICE);
  useEffect(() => {
    try { const v = localStorage.getItem(KEY); if (v) setC({ ...DEFAULT_CHOICE, ...JSON.parse(v) }); } catch { /* ignore */ }
  }, []);
  function save(next: LibraryChoice) { setC(next); localStorage.setItem(KEY, JSON.stringify(next)); }

  const card = (active: boolean) => cn("rounded-lg border p-3 text-left transition", active ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/50");

  return (
    <div className="space-y-8">
      <PageHeader title="Biblioteca" subtitle="Monte a identidade do vídeo com um clique: filtro de cor, legenda, efeitos sonoros e trilha." />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Filtros de cor</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {COLORS.map((p) => (
            <button key={p.id} className={card(c.color === p.id)} onClick={() => save({ ...c, color: p.id })}>
              <div className="mb-2 aspect-video rounded bg-gradient-to-br from-primary via-accent to-secondary" style={{ filter: p.css }} />
              <div className="text-sm font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground">{p.desc}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Estilos de legenda</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {CAPTIONS.map((p) => (
            <button key={p.id} className={card(c.caption === p.id)} onClick={() => save({ ...c, caption: p.id })}>
              <div className="mb-2 flex aspect-video items-center justify-center rounded bg-muted">
                <span className="px-2 py-1 text-base font-extrabold" style={{ fontFamily: p.font, color: p.color, background: p.box ? "rgba(0,0,0,.75)" : undefined, textShadow: p.box ? undefined : "0 0 3px #000, 0 2px 4px #000", textTransform: p.upper ? "uppercase" : undefined }}>
                  isso <span style={{ color: p.highlight }}>mudou</span> tudo
                </span>
              </div>
              <div className="text-sm font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground">{p.desc}</div>
            </button>
          ))}
        </div>
      </section>

      <ClonarLegenda active={c.caption} onPick={(id) => save({ ...c, caption: id })} />

      <MeusAudios folder="sfx" title="Meus efeitos sonoros" />
      <MeusAudios folder="musica" title="Minhas trilhas de fundo" />
      <MeusAudios folder="fontes" title="Minhas fontes de legenda (.ttf/.otf)" />

      <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" onClick={() => toast.success("Pacote salvo como padrão")}>Salvar pacote</button>
    </div>
  );
}
