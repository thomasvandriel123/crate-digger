/** Accent-folded, lowercased string for sorting and matching. */
export function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .trim();
}

const ARTICLES = /^(the|de|het|a|an|les|la|le|los|las|die|der|das)\s+/;

/**
 * Record-shop filing: "The Velvet Harbours" files under V. Only "the" and Dutch/Romance/German articles are
 * dropped, and only when something follows ("The The" keeps its second word).
 */
export function filingKey(name: string): string {
  const folded = fold(name);
  const stripped = folded.replace(ARTICLES, '');
  return stripped.length > 0 ? stripped : folded;
}

/** Divider letter for a filing key: A to Z, or "#" for digits and symbols. */
export function filingLetter(key: string): string {
  const c = key.charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function compareText(a: string, b: string): number {
  return collator.compare(a, b);
}
