import { deflateRawSync } from "node:zlib";

/**
 * Hostile and ordinary files, generated here (D-160). Nothing binary is committed: a reader can
 * see what makes each one hostile, and the sizes scale with the limits a test sets.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipSource {
  name: string;
  data: Buffer;
  /** Stored instead of deflated. */
  store?: boolean;
  /** Written into the headers in place of the true uncompressed size (a lie). */
  declaredSize?: number;
}

export function makeZip(sources: ZipSource[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const src of sources) {
    const name = Buffer.from(src.name, "utf8");
    const body = src.store ? src.data : deflateRawSync(src.data, { level: 9 });
    const method = src.store ? 0 : 8;
    const crc = crc32(src.data);
    const size = src.declaredSize ?? src.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sources.length, 8);
  end.writeUInt16LE(sources.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

export function documentXml(text: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  );
}

/** A real, minimal Word document that mammoth reads. */
export function makeDocx(text: string, extra: ZipSource[] = []): Buffer {
  return makeZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES) },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS) },
    { name: "word/document.xml", data: Buffer.from(documentXml(text)) },
    ...extra,
  ]);
}

/** A DOCX whose document part declares entities that expand exponentially if a parser follows them. */
export function makeEntityBombDocx(): Buffer {
  const lines = ['<!ENTITY a0 "lol">'];
  for (let i = 1; i <= 9; i++) {
    const prev = `&a${i - 1};`;
    lines.push(`<!ENTITY a${i} "${prev.repeat(10)}">`);
  }
  const xml =
    `<?xml version="1.0"?><!DOCTYPE lolz [${lines.join("")}]>` +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&a9;</w:t></w:r></w:p></w:body></w:document>';
  return makeZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES) },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS) },
    { name: "word/document.xml", data: Buffer.from(xml) },
  ]);
}

/** A zip bomb: `bytes` of zeros that deflate to roughly a thousandth of that. */
export function makeZipBombDocx(bytes: number): Buffer {
  return makeDocx("bomb", [{ name: "word/media/payload.bin", data: Buffer.alloc(bytes) }]);
}

/** A PDF of `pages` empty pages, built by hand with a correct cross-reference table. */
export function makePdf(pages: number, text?: string): Buffer {
  const objs: string[] = [];
  const kids: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  for (let i = 0; i < pages; i++) kids.push(`${i + 4} 0 R`);
  objs.push(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`);
  const content = `BT /F1 12 Tf 72 720 Td (${text ?? "Hello from a generated page"}) Tj ET`;
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    objs.push(
      i === 0 && text !== undefined
        ? `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pages + 4} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
        : "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    );
  }
  if (text !== undefined) objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** A Windows PE header followed by filler: what an executable looks like to a signature check. */
export function makeExe(): Buffer {
  return Buffer.concat([Buffer.from("MZ"), Buffer.alloc(62), Buffer.from("PE\0\0"), Buffer.alloc(400)]);
}

/** A file that is a PDF to a PDF reader and a zip to a zip reader. */
export function makePdfZipPolyglot(): Buffer {
  return Buffer.concat([makePdf(1, "polyglot"), makeDocx("polyglot")]);
}

export function utf16Text(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}
