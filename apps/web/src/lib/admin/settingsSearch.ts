import { DICTIONARIES } from "@/i18n";
import type { Locale } from "@/i18n/locale";

export interface SearchableSetting {
  key: string;
  category: string;
  /** The API's English sentence; the fallback for a key the web has no words for. */
  description: string;
}

const LOCALES = Object.keys(DICTIONARIES) as Locale[];

/** Lower case with diacritics folded, so "paavari" finds "pääväri" and "Ääni" finds "ääni". */
export function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Everything a person might type for a key, in every language the product speaks: the key itself,
 * the name and the sentence in English and in Finnish, and the category's name. A Finnish admin who
 * remembers the English name still finds it, and the other way round.
 */
function haystack(entry: SearchableSetting): { name: string; rest: string } {
  const names: string[] = [entry.key];
  const rest: string[] = [entry.description];
  for (const locale of LOCALES) {
    const strings = DICTIONARIES[locale];
    const table: Record<string, { label: string; description: string } | undefined> =
      strings.enums.settingKey;
    const text = Object.prototype.hasOwnProperty.call(table, entry.key) ? table[entry.key] : undefined;
    if (text) {
      names.push(text.label);
      rest.push(text.description);
    }
    const categories: Record<string, string> = strings.admin.settings.categories;
    const category = categories[entry.category];
    if (category) rest.push(category);
  }
  return { name: fold(names.join(" ")), rest: fold(rest.join(" ")) };
}

/**
 * Settings that match every word of `query`, names before descriptions. Pure and synchronous: the
 * catalog is a few dozen rows, so there is no index and nothing to wait for.
 */
export function searchSettings<T extends SearchableSetting>(query: string, entries: readonly T[]): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { entry: T; score: number }[] = [];
  for (const entry of entries) {
    const h = haystack(entry);
    const all = `${h.name} ${h.rest}`;
    if (!words.every((w) => all.includes(w))) continue;
    scored.push({ entry, score: words.every((w) => h.name.includes(w)) ? 0 : 1 });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.entry);
}

/** The id the settings form gives a key's input; a link to it scrolls and focuses the control. */
export function settingAnchor(key: string): string {
  return `setting-${key.replace(/\./g, "-")}`;
}
