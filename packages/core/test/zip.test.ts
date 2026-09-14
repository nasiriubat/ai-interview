import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, zipFiles } from "../src/requirements/zip.js";

function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("zipFiles", () => {
  const files = [
    { path: "AGENTS.md", content: "# Context\n\nHello hello hello hello hello hello hello hello hello.\n" },
    { path: "tasks/phase-1.md", content: "x" },
    { path: "empty.txt", content: "" },
  ];

  it("writes local headers, a central directory and the end record", () => {
    const zip = zipFiles(files, new Date("2024-05-06T07:08:10Z"));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);

    // Walk the local headers.
    let offset = 0;
    const seen: string[] = [];
    for (const _entry of files) {
      expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
      const method = zip.readUInt16LE(offset + 8);
      const crc = zip.readUInt32LE(offset + 14);
      const compressed = zip.readUInt32LE(offset + 18);
      const size = zip.readUInt32LE(offset + 22);
      const nameLen = zip.readUInt16LE(offset + 26);
      const name = zip.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
      const data = zip.subarray(offset + 30 + nameLen, offset + 30 + nameLen + compressed);
      const raw = method === 8 ? inflateRawSync(data) : data;
      const original = files.find((f) => f.path === name);
      expect(original).toBeDefined();
      expect(raw.toString("utf8")).toBe(original?.content);
      expect(size).toBe(Buffer.byteLength(original?.content ?? ""));
      expect(crc).toBe(crc32(Buffer.from(original?.content ?? "")));
      seen.push(name);
      offset += 30 + nameLen + compressed;
    }
    expect(seen).toEqual(files.map((f) => f.path));

    // Central directory follows, then the end record with the entry count.
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(files.length);
    expect(zip.readUInt32LE(end + 16)).toBe(offset);
    // The long text deflates, the one-byte file is stored.
    expect(zip.readUInt16LE(8)).toBe(8);
  });

  it("computes the standard CRC32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("is readable by the unzip binary when present", () => {
    if (!hasUnzip()) return;
    const dir = mkdtempSync(join(tmpdir(), "aidp-zip-"));
    const file = join(dir, "bundle.zip");
    writeFileSync(file, zipFiles(files));
    const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
    for (const f of files) expect(listing).toContain(f.path);
    execFileSync("unzip", ["-t", file], { stdio: "ignore" });
  });
});

describe("zip paths", () => {
  it("drops root and parent segments so an entry cannot escape the extraction folder", async () => {
    const { safeZipPath } = await import("../src/requirements/zip.js");
    expect(safeZipPath("../../etc/passwd")).toBe("etc/passwd");
    expect(safeZipPath("/absolute/file.md")).toBe("absolute/file.md");
    expect(safeZipPath("tasks\\phase-1.md")).toBe("tasks/phase-1.md");
    expect(safeZipPath("a/./b/../c.md")).toBe("a/b/c.md");
    expect(safeZipPath("AGENTS.md")).toBe("AGENTS.md");
  });
});
