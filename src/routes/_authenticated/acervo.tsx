import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Empty, PageHeader } from "@/components/app/ui";

export const Route = createFileRoute("/_authenticated/acervo")({
  head: () => ({
    meta: [
      { title: "Acervo — Estúdio Automático" },
      { name: "description", content: "Sua biblioteca de fotos, vídeos e trechos para usar em qualquer produção." },
      { property: "og:title", content: "Acervo — Estúdio Automático" },
      { property: "og:description", content: "Sua biblioteca de fotos, vídeos e trechos para usar em qualquer produção." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Acervo,
});

type Item = {
  id: string;
  kind: string;
  storage_path: string;
  description: string | null;
  created_at: string;
};

function Acervo() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [desc, setDesc] = useState("");

  const { data: items, isLoading } = useQuery({
    queryKey: ["acervo"],
    queryFn: async () => {
      const { data } = await supabase
        .from("assets")
        .select("id, kind, storage_path, description, created_at")
        .is("production_id", null)
        .eq("source", "upload")
        .in("kind", ["image", "video"])
        .order("created_at", { ascending: false });
      return (data ?? []) as Item[];
    },
  });

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Entre novamente na sua conta");
      for (const file of Array.from(files)) {
        if (!/^(image|video)\//.test(file.type)) { toast.error(`${file.name}: só fotos e vídeos`); continue; }
        if (file.size > 200 * 1024 * 1024) { toast.error(`${file.name}: arquivo muito grande (máx. 200 MB)`); continue; }
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
        const path = `${u.user.id}/acervo/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const up = await supabase.storage.from("media").upload(path, file, { contentType: file.type });
        if (up.error) throw up.error;
        const kind = file.type.startsWith("video") ? "video" : "image";
        const { error } = await supabase.from("assets").insert({
          user_id: u.user.id, production_id: null, kind, source: "upload",
          storage_path: path, license: "Enviada pelo usuário", description: file.name.replace(/\.[^.]+$/, ""),
        });
        if (error) throw error;
      }
      await qc.invalidateQueries({ queryKey: ["acervo"] });
      toast.success("Mídia guardada no acervo");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveDesc(item: Item) {
    setEditing(null);
    const v = desc.trim();
    if (v === (item.description ?? "")) return;
    const { error } = await supabase.from("assets").update({ description: v || null }).eq("id", item.id);
    if (error) { toast.error(error.message); return; }
    await qc.invalidateQueries({ queryKey: ["acervo"] });
    toast.success("Descrição salva");
  }

  async function remove(item: Item) {
    setBusy(true);
    try {
      await supabase.storage.from("media").remove([item.storage_path]);
      const { error } = await supabase.from("assets").delete().eq("id", item.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["acervo"] });
      toast.success("Removida do acervo");
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Acervo"
        subtitle="Suas fotos e vídeos guardados uma vez, usados em qualquer produção. O agente usa o acervo antes de buscar na internet — e prefere o que combina com o assunto de cada cena."
      />

      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          disabled={busy}
          onChange={(e) => upload(e.target.files)}
        />
        {busy ? "Enviando…" : "Enviar fotos ou vídeos"}
      </label>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Carregando acervo…</div>
      ) : !items?.length ? (
        <Empty>Acervo vazio. Envie fotos e vídeos que você quer reaproveitar nos seus vídeos.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((it) => (
            <Thumb key={it.id} item={it}
              editing={editing === it.id}
              desc={desc}
              setDesc={setDesc}
              startEdit={(v) => { setEditing(it.id); setDesc(v); }}
              save={() => saveDesc(it)}
              cancel={() => setEditing(null)}
              remove={() => remove(it)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Thumb({ item, editing, desc, setDesc, startEdit, save, cancel, remove }: {
  item: Item;
  editing: boolean;
  desc: string;
  setDesc: (v: string) => void;
  startEdit: (v: string) => void;
  save: () => void;
  cancel: () => void;
  remove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const { refetch } = useQuery({
    queryKey: ["acervo-url", item.id],
    queryFn: async () => {
      const { data } = await supabase.storage.from("media").createSignedUrl(item.storage_path, 3600);
      setUrl(data?.signedUrl ?? null);
      return data?.signedUrl ?? null;
    },
  });
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="relative aspect-video bg-muted">
        {url ? (
          item.kind === "video"
            ? <video src={url} muted playsInline className="h-full w-full object-cover" />
            : <img src={url} alt={item.description ?? ""} className="h-full w-full object-cover" />
        ) : <div className="grid h-full place-items-center text-xs text-muted-foreground">…</div>}
        <span className="absolute right-1 top-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{item.kind === "video" ? "vídeo" : "foto"}</span>
      </div>
      <div className="space-y-1 p-2">
        {editing ? (
          <div className="flex gap-1">
            <input
              value={desc}
              autoFocus
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
              placeholder="Descreva o que aparece, ex.: tigre correndo"
              className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
            />
            <button onClick={save} className="rounded border border-border px-2 py-1 text-[10px] hover:bg-accent">OK</button>
          </div>
        ) : (
          <button
            onClick={() => startEdit(item.description ?? "")}
            title="Clique para editar a descrição"
            className="line-clamp-2 w-full text-left text-xs hover:text-foreground"
          >
            {item.description || "Sem descrição — clique para descrever"}
          </button>
        )}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{new Date(item.created_at).toLocaleDateString("pt-BR")}</span>
          <button onClick={() => { remove(); void refetch(); }} className="text-destructive hover:underline">Remover</button>
        </div>
      </div>
    </div>
  );
}
