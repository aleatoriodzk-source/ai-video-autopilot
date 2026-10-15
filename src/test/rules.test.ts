import { describe, expect, it } from "vitest";
import { invalidateFrom, nextStep } from "@/lib/pipeline";
import { canGenerateAiImage, estimateCost, evaluateBudget } from "@/lib/costs";

describe("pipeline", () => {
  it("replacing narration keeps script and visuals", () => {
    const done = ["analyze", "topic", "script", "narration", "visuals", "scenes", "captions", "audio", "render", "validate"];
    expect(invalidateFrom(done, "narration")).toEqual(["analyze", "topic", "script", "visuals"]);
  });
  it("resumes from first incomplete step", () => {
    expect(nextStep(["analyze", "topic", "script"])).toBe("narration");
  });
});

describe("costs", () => {
  it("unknown price is never treated as free", () => {
    const r = estimateCost({ scenes: 8, narrationChars: 900, aiImages: 2, ttsProvider: "piper", needsScript: true, needsAnalysis: false }, {});
    expect(r.total).toBeNull();
    expect(r.unknown).toBe(true);
  });
  it("local piper + ffmpeg cost zero", () => {
    const r = estimateCost({ scenes: 8, narrationChars: 900, aiImages: 0, ttsProvider: "piper", needsScript: false, needsAnalysis: false }, {});
    expect(r.total).toBe(0);
  });
  it("blocks when monthly limit would be exceeded", () => {
    expect(evaluateBudget({ limits: { max_usd_per_month: 5 }, spentTask: 0, spentMonth: 4.9, nextCost: 0.2 }).allowed).toBe(false);
    expect(evaluateBudget({ limits: { max_usd_per_month: 5 }, spentTask: 0, spentMonth: 4.0, nextCost: 0.2 }).allowed).toBe(true);
  });
  it("AI images disabled by default and capped per video", () => {
    expect(canGenerateAiImage({ allowPaid: false, usedInVideo: 0, limits: {} }).allowed).toBe(false);
    expect(canGenerateAiImage({ allowPaid: true, usedInVideo: 6, limits: { max_ai_images_per_video: 6 } }).allowed).toBe(false);
  });
});
