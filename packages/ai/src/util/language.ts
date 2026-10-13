/** The languages the product is used in; participants answer in one of these even when the interview is in the other. */
const PRODUCT_LANGUAGES = ["fi", "en"] as const;

/**
 * The languages to expect a spoken answer in, most likely first: the interview's own, then the
 * product's. A transcriber that identifies the language picks among these (D-75); forcing the
 * interview's language instead would garble the English answer to a Finnish interview, which in a
 * Finnish workplace is common.
 */
export function speechLanguages(interviewLanguage: string | undefined): string[] {
  return [...new Set([...(interviewLanguage ? [interviewLanguage] : []), ...PRODUCT_LANGUAGES])];
}

/** Human-readable language name for prompts. Unknown codes pass through so a model still gets a hint. */
export function languageName(code: string): string {
  return (
    { en: "English", fi: "Finnish", sv: "Swedish", de: "German", fr: "French", es: "Spanish" }[code] ?? code
  );
}
