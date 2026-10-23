// Duration rules shared by the script generator and tests.
/** Average speaking rate of the Brazilian Portuguese neural voices (words per second). */
export const WORDS_PER_SECOND = 2.5;

/** Fixed channel rule: every short (vertical) video lasts at least 60 seconds. */
export const MIN_SHORT_SECONDS = 60;

export function isShortAspect(aspect: string | null | undefined): boolean {
  return aspect === "9:16" || aspect === "3:4";
}

/** Target length used by the script writer, enforcing the 60s minimum for shorts. */
export function effectiveTargetSeconds(aspect: string | null | undefined, requested: unknown): number {
  const short = isShortAspect(aspect);
  const n = Number(requested ?? (short ? 65 : 240)) || (short ? 65 : 240);
  return Math.min(1800, Math.max(short ? MIN_SHORT_SECONDS : 15, n));
}

export function countWords(scenes: { narration: string }[]): number {
  return scenes.reduce((a, s) => a + s.narration.split(/\s+/).filter(Boolean).length, 0);
}

/** A script is too short when it has less than 90% of the words needed for the target duration. */
export function scriptIsShort(scenes: { narration: string }[], targetSeconds: number): boolean {
  return countWords(scenes) < targetSeconds * WORDS_PER_SECOND * 0.9;
}

/** Suggested video length (seconds) for a ready script, adjusted by the voice speed (e.g. "+15%"). */
export function suggestedSeconds(text: string, rate = "+0%"): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const pct = Number(rate.replace("%", "")) || 0;
  return Math.round(words / (WORDS_PER_SECOND * (1 + pct / 100)));
}
