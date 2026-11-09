import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Play } from "lucide-react";
import { PageHeader } from "@/components/app/ui";
import { cn } from "@/lib/utils";
import { CAPTIONS, COLORS, DEFAULT_CHOICE, MUSIC, SFX, type LibraryChoice, type SfxPreset } from "@/lib/library-presets";

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

function playSfx(kind: SfxPreset["kind"]) {
  const ctx = new AudioContext();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.connect(g).connect(ctx.destination);
  const t = ctx.currentTime;
  const f: [number, number, number] = ({ whoosh: [800, 200, 0.4], boom: [90, 30, 0.9], drop: [160, 40, 1.2], riser: [200, 1200, 1.5], click: [1500, 1500, 0.05] } as Record<string, [number, number, number]>)[kind];
  o.type = kind === "whoosh" ? "sawtooth" : "sine";
  o.frequency.setValueAtTime(f[0], t);
  o.frequency.exponentialRampToValueAtTime(f[1], t + f[2]);
  g.gain.setValueAtTime(0.4, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + f[2]);
  o.start(t);
  o.stop(t + f[2]);
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

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Efeitos sonoros</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {SFX.map((s) => {
            const on = c.sfx.includes(s.id);
            return (
              <div key={s.id} className={card(on)}>
                <div className="text-sm font-medium">{s.name}</div>
                <div className="mt-2 flex gap-2">
                  <button className="rounded border px-2 py-1 text-xs" onClick={() => playSfx(s.kind)} aria-label={`Ouvir ${s.name}`}><Play className="h-3 w-3" /></button>
                  <button className="rounded border px-2 py-1 text-xs" onClick={() => save({ ...c, sfx: on ? c.sfx.filter((x) => x !== s.id) : [...c.sfx, s.id] })}>{on ? "Usando" : "Usar"}</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Trilha de fundo</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {MUSIC.map((m) => (
            <button key={m.id} className={card(c.music === m.id)} onClick={() => save({ ...c, music: m.id, duckDb: m.duckDb })}>
              <div className="text-sm font-medium">{m.name}</div>
              <div className="text-xs text-muted-foreground">{m.desc} · abaixa {m.duckDb} dB quando a voz fala</div>
            </button>
          ))}
        </div>
      </section>

      <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" onClick={() => toast.success("Pacote salvo como padrão")}>Salvar pacote</button>
    </div>
  );
}
