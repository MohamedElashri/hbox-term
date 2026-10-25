// Fuzzy matching for the command palette: query characters must appear in order. Matches at
// word starts and consecutive runs score higher; null means no match.

const WORD_BOUNDARY = /[\s\-_/.:@]/;

export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  let position = 0;
  let previous = -2;
  for (const char of needle) {
    if (char === " ") continue;
    const index = haystack.indexOf(char, position);
    if (index < 0) return null;
    score += 1;
    if (index === previous + 1) score += 3;
    if (index === 0 || WORD_BOUNDARY.test(haystack[index - 1])) score += 5;
    score -= Math.min(index - position, 10) * 0.1;
    previous = index;
    position = index + 1;
  }
  // Shorter texts win ties: "Split right" over "Split right and focus".
  return score - haystack.length * 0.01;
}

export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string): T[] {
  return items
    .map((item, order) => ({ item, order, score: fuzzyScore(query, text(item)) }))
    .filter((entry): entry is { item: T; order: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.item);
}
