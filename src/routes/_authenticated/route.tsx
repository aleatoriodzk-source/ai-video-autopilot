import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Clapperboard, LayoutDashboard, Link2, LogOut, Menu, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { agentOnline } from "@/lib/jobs";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: Shell,
});

const NAV = [
  { to: "/painel", label: "Dashboard", icon: LayoutDashboard },
  { to: "/referencias", label: "Referências", icon: Link2 },
] as const;

function Shell() {
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { data: agents } = useQuery({
    queryKey: ["agents-status"],
    queryFn: async () => (await supabase.from("agents").select("last_seen_at").eq("revoked", false)).data ?? [],
    refetchInterval: 30_000,
  });
  const online = (agents ?? []).some((a) => agentOnline(a.last_seen_at));

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((n) => (
        <Link
          key={n.to}
          to={n.to}
          onClick={() => setOpen(false)}
          className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground", path.startsWith(n.to) && "bg-sidebar-accent text-sidebar-foreground")}
        >
          <n.icon className={cn("h-4 w-4", path.startsWith(n.to) && "text-primary")} />
          {n.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen md:flex">
      <aside className={cn("fixed inset-y-0 left-0 z-40 w-64 border-r border-sidebar-border bg-sidebar p-4 transition-transform md:static md:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="mb-6 flex items-center justify-between">
          <Link to="/painel" className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Clapperboard className="h-4 w-4" />
            </div>
            <span className="font-display font-semibold">Estúdio Automático</span>
          </Link>
          <button className="md:hidden" onClick={() => setOpen(false)} aria-label="Fechar menu">
            <X className="h-5 w-5" />
          </button>
        </div>
        {nav}
        <div className="mt-6 space-y-3 border-t border-sidebar-border pt-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn("h-2 w-2 rounded-full", online ? "bg-success" : "bg-destructive")} />
            Agente local {online ? "conectado" : "desconectado"}
          </div>
          <button onClick={() => supabase.auth.signOut()} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
            <LogOut className="h-3.5 w-3.5" /> Sair
          </button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-background/70 md:hidden" onClick={() => setOpen(false)} />}
      <main className="min-w-0 flex-1">
        <div className="flex items-center gap-3 border-b border-border p-3 md:hidden">
          <button onClick={() => setOpen(true)} aria-label="Abrir menu">
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-display font-semibold">Estúdio Automático</span>
        </div>
        <div className="mx-auto max-w-6xl p-4 md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
