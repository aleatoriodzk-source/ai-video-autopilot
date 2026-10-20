// Duration rules shared by the script generator and tests.
/** Average speaking rate of the Brazilian Portuguese neural voices (words per second). */
export const WORDS_PER_SECOND = 2.5;

export function countWords(scenes: { narration: string }[]): number {
  return scenes.reduce((a, s) => a + s.narration.split(/\s+/).filter(Boolean).length, 0);
}

/** A script is too short when it has less than 90% of the words needed for the target duration. */
export function scriptIsShort(scenes: { narration: string }[], targetSeconds: number): boolean {
  return countWords(scenes) < targetSeconds * WORDS_PER_SECOND * 0.9;
}
