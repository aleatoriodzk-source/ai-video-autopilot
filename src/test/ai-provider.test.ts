import { describe, expect, it } from "vitest";
import { providerOrder } from "@/server/ai.server";

describe("escolha de IA", () => {
  it("usa a IA escolhida primeiro e as outras chaves como reserva", () => {
    expect(providerOrder("anthropic", { gemini: "g", anthropic: "a" })).toEqual(["anthropic", "gemini", "lovable"]);
  });
  it("ignora IA escolhida sem chave", () => {
    expect(providerOrder("openai", { gemini: "g" })).toEqual(["gemini", "lovable"]);
  });
  it("créditos da plataforma só quando escolhidos ou como último recurso", () => {
    expect(providerOrder("lovable", { gemini: "g" })).toEqual(["lovable", "gemini"]);
  });
});
