import { describe, expect, it } from "vitest";
import { toSrt, toDraft } from "./capcut-export";
const sc = [{ narration: "Oi", caption: "", duration: 2.5 }, { narration: "x", caption: "Tchau", duration: 61 }];
describe("capcut export", () => {
  it("srt times add up", () => { expect(toSrt(sc)).toContain("00:00:02,500 --> 00:01:03,500\nTchau"); });
  it("vertical canvas for shorts", () => { expect(toDraft(sc, "9:16", "t").canvas.width).toBe(1080); expect(toDraft(sc, "9:16", "t").duration_us).toBe(63_500_000); });
});
