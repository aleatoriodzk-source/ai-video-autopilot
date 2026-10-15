import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Estúdio Automático — produção de vídeos com IA" },
      { name: "description", content: "Analise canais do YouTube e TikTok e produza vídeos novos no mesmo estilo, renderizados no seu computador." },
      { property: "og:title", content: "Estúdio Automático — produção de vídeos com IA" },
      { property: "og:description", content: "Análise de estilo, roteiro, narração, legendas e renderização com FFmpeg no seu PC." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/painel" });
  },
});
