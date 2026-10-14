/*
 * The pure half of the import dialog (D-346): turning a file's text into rows that are ready and
 * lines that are not, each with its line number, so the dialog can show a preview and an error
 * report before anything is sent.
 */
export interface ImportIssue {
  line: number;
  value: string;
  reason: "invalid" | "duplicate";
}

export interface ImportPreview {
  valid: string[];
  issues: ImportIssue[];
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * A list of addresses, one or more per line (separated by commas, semicolons or spaces). A first
 * line that is a header such as `email` is skipped. Addresses are lower-cased; a repeat is
 * reported as a duplicate and kept once.
 */
export function previewEmailList(text: string): ImportPreview {
  const valid: string[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line.trim() === "") return;
    for (const raw of line.split(/[\s,;]+/)) {
      const value = raw.trim().replace(/^"|"$/g, "");
      if (value === "") continue;
      if (lineNo === 1 && /^e-?mail(s| address)?$/i.test(value)) continue;
      const email = value.toLowerCase();
      if (!EMAIL.test(email)) {
        issues.push({ line: lineNo, value, reason: "invalid" });
      } else if (seen.has(email)) {
        issues.push({ line: lineNo, value, reason: "duplicate" });
      } else {
        seen.add(email);
        valid.push(email);
      }
    }
  });
  return { valid, issues };
}

/** The error report as CSV, for a person to fix the file and try again. */
export function issuesCsv(issues: readonly ImportIssue[]): string {
  const rows = issues.map((i) => `${String(i.line)},"${i.value.replace(/"/g, '""')}",${i.reason}`);
  return `line,value,problem\r\n${rows.join("\r\n")}\r\n`;
}
