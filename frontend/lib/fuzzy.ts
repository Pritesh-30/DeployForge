/**
 * Fuzzy matching for "go to file" and the command palette.
 *
 * The query's characters must appear in the candidate in order (a
 * subsequence), but not necessarily together: "rtpg" finds
 * "src/routes/page.tsx". Among matches, the ones a person meant rank first.
 *
 * The approach is fzf's first algorithm: a forward scan finds where the
 * earliest complete match ends, a backward scan from there finds the latest
 * place it can start, which gives the tightest span ending at that point.
 * The span is then scored. Linear in the candidate's length, so twenty
 * thousand paths filter on every keystroke without a noticeable pause.
 *
 * Scoring rewards what a person types toward:
 *   - characters at the start of a word (after / . - _ or a space, or a
 *     lower-to-upper change) — "pt" means Page.Tsx, not oPTions;
 *   - runs of consecutive characters;
 *   - matches in the last path segment, the file name;
 * and charges a little for every skipped character, so a tight match wins.
 */

export type Match = { score: number; positions: number[] };

const BOUNDARY = new Set(["/", "\\", ".", "-", "_", " ", ":"]);

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (BOUNDARY.has(prev)) return true;
  const ch = text[i];
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const lower = text.toLowerCase();

  // Forward: the earliest index where the whole query has been seen.
  let qi = 0;
  let end = -1;
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === q[qi]) {
      qi++;
      if (qi === q.length) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  // Backward from there: the latest start, i.e. the tightest span.
  const positions: number[] = new Array(q.length);
  qi = q.length - 1;
  for (let i = end; i >= 0 && qi >= 0; i--) {
    if (lower[i] === q[qi]) {
      positions[qi] = i;
      qi--;
    }
  }

  const nameStart = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1;
  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    const i = positions[k];
    score += 1;
    if (isBoundary(text, i)) score += 8;
    if (k > 0 && positions[k - 1] === i - 1) score += 6;
    if (i >= nameStart) score += 3;
    if (text[i] === query.trim()[k]) score += 1; // exact case
  }
  const span = positions[positions.length - 1] - positions[0] + 1;
  score -= (span - positions.length) * 0.5; // skipped characters inside the match
  score -= text.length * 0.02; // shorter candidates win ties
  return { score, positions };
}

/** Filter and rank `items` by `query`, best first, at most `limit`. */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  key: (item: T) => string,
  limit = 50,
): { item: T; match: Match }[] {
  if (!query.trim()) return items.slice(0, limit).map((item) => ({ item, match: { score: 0, positions: [] } }));
  const scored: { item: T; match: Match }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) scored.push({ item, match });
  }
  scored.sort((a, b) => b.match.score - a.match.score);
  return scored.slice(0, limit);
}
