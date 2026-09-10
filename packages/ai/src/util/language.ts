/** Human-readable language name for prompts. Unknown codes pass through so a model still gets a hint. */
export function languageName(code: string): string {
  return (
    { en: "English", fi: "Finnish", sv: "Swedish", de: "German", fr: "French", es: "Spanish" }[code] ?? code
  );
}
