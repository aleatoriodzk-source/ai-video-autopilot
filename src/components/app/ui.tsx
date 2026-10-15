import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { JOB_STATUS_LABEL } from "@/lib/pipeline";
import { cn } from "@/lib/utils";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const tone: Record<string, string> = {
  done: "bg-success/15 text-success border-success/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  cancelled: "bg-muted text-muted-foreground",
  paused: "bg-warning/15 text-warning border-warning/30",
  awaiting_review: "bg-info/15 text-info border-info/30",
  running: "bg-primary/15 text-primary border-primary/30",
  rendering: "bg-primary/15 text-primary border-primary/30",
  waiting_api: "bg-warning/15 text-warning border-warning/30",
  waiting_download: "bg-warning/15 text-warning border-warning/30",
  queued: "bg-secondary text-secondary-foreground",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap", tone[status] ?? "")}>
      {JOB_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="panel p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

export function Basis({ basis }: { basis: string }) {
  const map: Record<string, string> = { dados: "Dados", estimativa: "Estimativa", indisponivel: "Indisponível" };
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", basis === "dados" ? "bg-success/15 text-success" : basis === "estimativa" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground")}>
      {map[basis] ?? basis}
    </span>
  );
}
