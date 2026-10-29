/**
 * Spelling helpers: flag names, and "did you mean" suggestions.
 */

/** `installPlugins` → `install-plugins`. */
export function toKebab(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
}

/**
 * The closest words to a mistyped one, best first: within a small edit distance, or starting with
 * it. At most three.
 *
 * ```ts
 * suggest("buld", ["build", "bundle", "init"]);   // ["build"]
 * ```
 */
export function suggest(typed: string, candidates: Iterable<string>): string[] {
    const limit = Math.max(2, Math.floor(typed.length / 3));
    const scored: Array<{ word: string; score: number }> = [];

    for (const word of new Set(candidates)) {
        const distance = editDistance(typed.toLowerCase(), word.toLowerCase());

        if (distance <= limit) {
            scored.push({ word, score: distance });
        } else if (typed.length >= 2 && word.startsWith(typed)) {
            scored.push({ word, score: limit + 1 });
        }
    }

    return scored
        .sort((a, b) => a.score - b.score || (a.word < b.word ? -1 : 1))
        .slice(0, 3)
        .map((item) => item.word);
}

/** The Levenshtein distance between two words. */
export function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];

        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;

            current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
        }

        previous = current;
    }

    return previous[b.length]!;
}
