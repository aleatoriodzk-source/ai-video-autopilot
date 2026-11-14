import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneEditor } from "./SceneEditor";

const state = vi.hoisted(() => ({
  loading: true,
  scenes: [] as Record<string, unknown>[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "scenes") return { data: state.scenes, isLoading: state.loading };
    if (queryKey[0] === "prod-aspect") return { data: { aspect: "9:16", settings: {} } };
    return { data: null, isLoading: false };
  },
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/jobs", () => ({ rerenderProduction: vi.fn() }));
vi.mock("@/lib/ai.functions", () => ({ rewriteScene: vi.fn() }));
vi.mock("./StudioStatus", () => ({ StudioStatus: () => null }));

afterEach(() => {
  cleanup();
  state.loading = true;
  state.scenes = [];
});

describe("SceneEditor hook lifecycle", () => {
  it("keeps hooks stable through loading, empty, populated and empty-again renders", () => {
    const editor = render(<SceneEditor productionId="existing-production" />);
    state.loading = false;
    expect(() => editor.rerender(<SceneEditor productionId="existing-production" />)).not.toThrow();
    state.scenes = [{
      id: "scene-1", narration: "Como surgiu esse segredo?", caption: "Segredo",
      visual_query: "personagem", visual_description: "personagem",
      pause_after_ms: 0, duration_s: 3, motion: "zoom_in", transition: "cut", asset_id: null,
    }];
    expect(() => editor.rerender(<SceneEditor productionId="existing-production" />)).not.toThrow();
    fireEvent.click(screen.getByRole("button", { name: "Auditar viralidade" }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    state.scenes = [];
    expect(() => editor.rerender(<SceneEditor productionId="existing-production" />)).not.toThrow();
  });
});