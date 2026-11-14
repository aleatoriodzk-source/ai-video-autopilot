import { describe, expect, it } from "vitest";
import { parseViews } from "@/lib/radar.functions";

describe("radar parseViews", () => {
  it("lê mil", () => expect(parseViews("Título, 8,7 mil visualizações - ver o Shorts")).toBe(8700));
  it("lê milhões", () => expect(parseViews("x, 1,2 mi de visualizações")).toBe(1200000));
  it("lê número puro", () => expect(parseViews("x, 532 visualizações")).toBe(532));
});
