import { describe, expect, it } from "vitest";
import { safeFilename } from "../src/attachments/service.js";

/**
 * The filename is attacker-controlled text that reaches three places: a `Content-Disposition`
 * header, the browser, and the interviewer's prompt. These are the cases that matter rather than a
 * survey of the function.
 */
describe("safeFilename", () => {
  it("keeps an ordinary name as it is", () => {
    expect(safeFilename("ward-procedure.pdf")).toBe("ward-procedure.pdf");
    expect(safeFilename("Rota 2026.xlsx")).toBe("Rota 2026.xlsx");
  });

  it("keeps letters from any script, so a Finnish or Arabic name survives", () => {
    expect(safeFilename("työohje.pdf")).toBe("työohje.pdf");
    expect(safeFilename("مستند.pdf")).toBe("مستند.pdf");
  });

  it("takes only the last path segment, however the path is written", () => {
    expect(safeFilename("/etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Windows\\System32\\config")).toBe("config");
    expect(safeFilename("../../../../secret.txt")).toBe("secret.txt");
  });

  it("cannot produce a name that starts with a dot", () => {
    // `..` and `.ssh` are the two shapes worth naming: one traverses, the other hides.
    expect(safeFilename("..")).toBe("file");
    expect(safeFilename(".env")).toBe("env");
    expect(safeFilename("...")).toBe("file");
  });

  it("strips quotes, which would otherwise escape the Content-Disposition header", () => {
    expect(safeFilename('a";x="b.pdf')).toBe("axb.pdf");
    expect(safeFilename("a'b.pdf")).toBe("ab.pdf");
  });

  it("strips control characters and newlines, which would split a header", () => {
    // The carriage returns and newlines go entirely, so nothing is left that could end a header
    // line; the colon goes with them.
    expect(safeFilename("a\r\nContent-Length: 0\r\n\r\nb.pdf")).toBe("aContent-Length 0b.pdf");
    expect(safeFilename("a\u0000b.pdf")).toBe("ab.pdf");
  });

  it("strips the right-to-left override that disguises an extension", () => {
    // `evil<RLO>gnp.exe` renders as `evilexe.png` to a human reading it.
    const disguised = "evil\u202egnp.exe";

    const out = safeFilename(disguised);

    expect(out).not.toContain("\u202e");
    expect(out).toBe("evilgnp.exe");
  });

  it("never returns an empty name", () => {
    expect(safeFilename("")).toBe("file");
    expect(safeFilename("   ")).toBe("file");
    expect(safeFilename("///")).toBe("file");
    expect(safeFilename("\u0000\u0001")).toBe("file");
  });

  it("bounds the length, because this goes in a header", () => {
    expect(safeFilename(`${"a".repeat(500)}.pdf`)).toHaveLength(200);
  });
});
