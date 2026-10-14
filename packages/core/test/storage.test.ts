import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachmentKey,
  companyPrefix,
  createStorage,
  FilesystemStorage,
  MemoryStorage,
  ObjectNotFound,
  isOutOfSpace,
  ObjectTooLarge,
  sessionPrefix,
  StorageFull,
  storageKind,
  type StoragePort,
} from "../src/storage/index.js";

const read = async (storage: StoragePort, key: string): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.get(key)) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
};

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aidp-storage-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Both adapters are held to one contract. An adapter that only satisfies the interface but not the
 * behaviour — losing a content type, reporting the wrong size, silently truncating an oversized
 * body — would pass a type check and lose somebody's recording.
 */
const adapters: [string, () => StoragePort][] = [
  ["memory", () => new MemoryStorage()],
  ["filesystem", () => new FilesystemStorage(join(dir, `case-${Math.random().toString(36).slice(2)}`))],
];

describe.each(adapters)("StoragePort: %s", (_name, make) => {
  it("round-trips bytes with their content type and size", async () => {
    const s = make();
    const key = attachmentKey("c1", "s1", "a1");

    const put = await s.put(key, Buffer.from("hello voice"), { contentType: "audio/webm" });

    expect(put).toEqual({ key, contentType: "audio/webm", sizeBytes: 11 });
    expect(await read(s, key)).toBe("hello voice");
    expect(await s.head(key)).toEqual({ key, contentType: "audio/webm", sizeBytes: 11 });
  });

  it("accepts a stream and reports the size it actually wrote", async () => {
    const s = make();
    const key = attachmentKey("c1", "s1", "a2");

    const put = await s.put(key, Readable.from([Buffer.from("abc"), Buffer.from("de")]), {
      contentType: "text/plain",
    });

    expect(put.sizeBytes).toBe(5);
    expect(await read(s, key)).toBe("abcde");
  });

  it("replaces an object written to the same key", async () => {
    const s = make();
    const key = attachmentKey("c1", "s1", "a3");
    await s.put(key, Buffer.from("first"), { contentType: "text/plain" });

    await s.put(key, Buffer.from("second"), { contentType: "text/plain" });

    expect(await read(s, key)).toBe("second");
  });

  it("reports a missing object rather than an empty one", async () => {
    const s = make();

    expect(await s.head(attachmentKey("c1", "s1", "nope"))).toBeNull();
    await expect(s.get(attachmentKey("c1", "s1", "nope"))).rejects.toThrow(ObjectNotFound);
  });

  it("deleting something absent is not an error", async () => {
    const s = make();
    await expect(s.delete(attachmentKey("c1", "s1", "nope"))).resolves.toBeUndefined();
  });

  it("refuses a body over the limit, and stores nothing", async () => {
    const s = make();
    const key = attachmentKey("c1", "s1", "big");

    await expect(
      s.put(key, Buffer.from("way too many bytes"), { contentType: "text/plain", maxBytes: 4 }),
    ).rejects.toThrow(ObjectTooLarge);

    expect(await s.head(key)).toBeNull();
  });

  it("refuses an oversized stream too, which is the case that cannot be checked up front", async () => {
    const s = make();
    const key = attachmentKey("c1", "s1", "bigstream");
    const body = Readable.from([Buffer.alloc(8, 1), Buffer.alloc(8, 2)]);

    await expect(s.put(key, body, { contentType: "text/plain", maxBytes: 10 })).rejects.toThrow(
      ObjectTooLarge,
    );

    expect(await s.head(key)).toBeNull();
  });

  it("stops reading an endless stream at the cap instead of buffering it", async () => {
    const storage = make();
    let pulled = 0;
    const endless = new Readable({
      read() {
        pulled += 1024 * 1024;
        this.push(Buffer.alloc(1024 * 1024, 0x61));
      },
    });
    await expect(
      storage.put("c1/s1/endless", endless, { contentType: "text/plain", maxBytes: 4 * 1024 * 1024 }),
    ).rejects.toBeInstanceOf(ObjectTooLarge);
    // Backpressure means the source is asked for little more than the cap, not for everything.
    expect(pulled).toBeLessThan(64 * 1024 * 1024);
    expect(await storage.head("c1/s1/endless")).toBeNull();
  });

  it("deletes a session's objects together, and leaves other sessions alone", async () => {
    const s = make();
    await s.put(attachmentKey("c1", "s1", "a1"), Buffer.from("1"), { contentType: "text/plain" });
    await s.put(attachmentKey("c1", "s1", "a2"), Buffer.from("2"), { contentType: "text/plain" });
    await s.put(attachmentKey("c1", "s2", "b1"), Buffer.from("3"), { contentType: "text/plain" });

    expect(await s.deletePrefix(sessionPrefix("c1", "s1"))).toBe(2);

    expect(await s.head(attachmentKey("c1", "s1", "a1"))).toBeNull();
    expect(await s.head(attachmentKey("c1", "s2", "b1"))).not.toBeNull();
  });

  it("deletes a whole tenant's objects", async () => {
    const s = make();
    await s.put(attachmentKey("c1", "s1", "a1"), Buffer.from("1"), { contentType: "text/plain" });
    await s.put(attachmentKey("c1", "s2", "a2"), Buffer.from("2"), { contentType: "text/plain" });
    await s.put(attachmentKey("c2", "s3", "a3"), Buffer.from("3"), { contentType: "text/plain" });

    expect(await s.deletePrefix(companyPrefix("c1"))).toBe(2);

    expect(await s.head(attachmentKey("c2", "s3", "a3"))).not.toBeNull();
  });

  it("lists the immediate children of a prefix, with when each last changed", async () => {
    const s = make();
    await s.put(attachmentKey("c1", "s1", "a1"), Buffer.from("1"), { contentType: "text/plain" });
    await s.put(attachmentKey("c1", "s1", "a2"), Buffer.from("2"), { contentType: "text/plain" });
    await s.put(attachmentKey("c1", "s2", "b1"), Buffer.from("3"), { contentType: "text/plain" });
    await s.put(attachmentKey("c2", "s9", "x1"), Buffer.from("4"), { contentType: "text/plain" });

    const listed = await s.listPrefixes(companyPrefix("c1"));

    expect(listed.map((p) => p.name).sort()).toEqual(["s1", "s2"]);
    for (const p of listed) expect(Date.now() - p.modifiedAt.getTime()).toBeLessThan(60_000);
    expect(await s.listPrefixes(companyPrefix("nobody"))).toEqual([]);
  });

  it("refuses a key that could walk out of the store", async () => {
    const s = make();
    for (const bad of ["../escape", "c1/../../etc/passwd", "c1//s1", "c1/s1/a b"]) {
      await expect(s.put(bad, Buffer.from("x"), { contentType: "text/plain" })).rejects.toThrow();
    }
  });
});

describe("attachmentKey", () => {
  it("puts the tenant first so a prefix delete can forget a tenant or a session", () => {
    expect(attachmentKey("c1", "s1", "a1")).toBe("c1/s1/a1");
    expect(sessionPrefix("c1", "s1")).toBe("c1/s1/");
    expect(companyPrefix("c1")).toBe("c1/");
  });

  it("refuses an identifier that is not one", () => {
    expect(() => attachmentKey("..", "s1", "a1")).toThrow(/Unsafe/);
    expect(() => attachmentKey("c1", "s/1", "a1")).toThrow(/Unsafe/);
    expect(() => attachmentKey("c1", "s1", "")).toThrow(/Unsafe/);
  });
});

describe("FilesystemStorage", () => {
  it("leaves no partial file behind when a write is refused mid-stream", async () => {
    const root = join(dir, "partials");
    const s = new FilesystemStorage(root);
    const key = attachmentKey("c1", "s1", "a1");

    await expect(
      s.put(key, Readable.from([Buffer.alloc(16)]), { contentType: "text/plain", maxBytes: 4 }),
    ).rejects.toThrow(ObjectTooLarge);

    const entries = await readdir(join(root, "c1", "s1")).catch(() => []);
    expect(entries.filter((e) => e.endsWith(".part"))).toEqual([]);
  });

  it("refuses a traversing key on every method, rather than reading it as absent", async () => {
    const s = new FilesystemStorage(join(dir, "rooted"));
    // `head` answering null would be wrong here: null means "no such object", and a caller acting
    // on that would go on to write one. A key that could leave the root is a bug in the caller,
    // and it should stop there.
    await expect(s.head("..")).rejects.toThrow(/Unsafe/);
    await expect(s.get("../outside")).rejects.toThrow(/Unsafe/);
    await expect(s.delete("../outside")).rejects.toThrow(/Unsafe/);
  });
});

describe("createStorage", () => {
  it("uses a directory when one is configured and memory when none is", async () => {
    expect(storageKind(createStorage(join(dir, "configured")))).toBe("filesystem");
    expect(storageKind(createStorage(undefined))).toBe("memory");
    expect(storageKind(createStorage(""))).toBe("memory");
  });

  it("actually writes to the configured directory", async () => {
    const root = join(dir, "written");
    const s = createStorage(root);
    await s.put(attachmentKey("c1", "s1", "a1"), Buffer.from("on disk"), {
      contentType: "text/plain",
    });

    await writeFile(join(root, "marker"), "");
    expect(await readdir(root)).toContain("c1");
  });
});

describe("a full disk (D-283)", () => {
  it("is a typed StorageFull, and leaves no partial object behind", async () => {
    const storage = new FilesystemStorage(join(dir, "full"));
    const body = new Readable({
      read() {
        this.push(Buffer.from("some of the bytes"));
        // What the kernel hands back when the volume has no room: the code is what matters.
        this.destroy(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
      },
    });

    await expect(storage.put("t1/s1/a1", body, { contentType: "audio/webm" })).rejects.toBeInstanceOf(
      StorageFull,
    );
    expect(await storage.head("t1/s1/a1")).toBeNull();
    const left = await readdir(join(dir, "full", "t1", "s1"));
    expect(left.filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("is not confused with an unrelated failure", async () => {
    const storage = new FilesystemStorage(join(dir, "other"));
    const body = new Readable({
      read() {
        this.destroy(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
      },
    });
    await expect(storage.put("t1/s1/a2", body, { contentType: "audio/webm" })).rejects.not.toBeInstanceOf(
      StorageFull,
    );
  });
});

describe("an object store's quota error is the same typed failure (D-313)", () => {
  const s3 = (name: string, status?: number) =>
    Object.assign(new Error(`${name}: raised by the store`), {
      name,
      ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
    });

  it.each([
    ["AWS-style QuotaExceeded", s3("QuotaExceeded", 403)],
    ["StorageQuotaExceeded", s3("StorageQuotaExceeded", 403)],
    ["Backblaze storage_cap_exceeded", Object.assign(new Error("cap"), { code: "storage_cap_exceeded" })],
    ["a Code field as the XML body carries it", Object.assign(new Error("x"), { Code: "InsufficientStorage" })],
    ["HTTP 507 whatever it is called", s3("ServiceException", 507)],
    ["507 as statusCode", Object.assign(new Error("x"), { statusCode: 507 })],
    ["EDQUOT", Object.assign(new Error("x"), { code: "EDQUOT" })],
    ["a wrapped cause", new Error("upload failed", { cause: s3("QuotaExceeded") })],
  ])("recognises %s", (_label, err) => {
    expect(isOutOfSpace(err)).toBe(true);
  });

  it.each([
    ["a throttle", s3("SlowDown", 503)],
    ["access denied", s3("AccessDenied", 403)],
    ["a message that merely mentions it", new Error("quota exceeded somewhere")],
    ["a reset", Object.assign(new Error("x"), { code: "ECONNRESET" })],
    ["a string", "QuotaExceeded"],
    ["null", null],
  ])("does not mistake %s for a full store", (_label, err) => {
    expect(isOutOfSpace(err)).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isOutOfSpace(a)).toBe(false);
  });

  it("is mapped by the filesystem adapter too, so one classifier serves every adapter", async () => {
    const storage = new FilesystemStorage(join(dir, "quota"));
    const body = new Readable({
      read() {
        this.destroy(s3("QuotaExceeded", 403));
      },
    });
    await expect(storage.put("t1/s1/q1", body, { contentType: "audio/webm" })).rejects.toBeInstanceOf(
      StorageFull,
    );
  });
});
