import leo from 'leo-profanity';

leo.loadDictionary('en');
// Add a few crypto-specific patterns we don't want as token names.
leo.add(['scam', 'rugpull']);

/** Returns true if any of the given strings contains a profane substring. */
export function containsProfanity(...inputs: Array<string | undefined | null>): boolean {
  for (const s of inputs) {
    if (!s) continue;
    if (leo.check(String(s))) return true;
  }
  return false;
}
