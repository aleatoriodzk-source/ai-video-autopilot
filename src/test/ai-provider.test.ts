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

import { friendlyError } from "@/lib/friendly-error";
describe("mensagens de erro", () => {
  it("503 vira IA sobrecarregada", () => {
    expect(friendlyError("Gemini respondeu 503: overloaded")?.title).toBe("A IA está sobrecarregada");
  });
  it("402 manda salvar chave própria", () => {
    expect(friendlyError("402 Not enough credits")?.title).toBe("Créditos da plataforma acabaram");
  });
});
