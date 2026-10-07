// Turns Canvas HTML and uploaded files into plain text Claude can read.
import { inflateRawSync } from "node:zlib";
import { convert } from "html-to-text";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

const MiB = 1024 * 1024;
/** How far one zip (PPTX, DOCX) may decompress: a few kB of deflate can stand for gigabytes, inflated synchronously
 *  (the whole server waits) into memory outside the JS heap. Counted per entry and over everything read from one file. */
export const ZIP_LIMITS = Object.freeze({ entryBytes: 16 * MiB, totalBytes: 64 * MiB });
const TOO_LARGE = "File is too large to read here.";

export function htmlToText(html: string | null | undefined, maxChars = 20000): string {
  if (!html) return "";
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((h) => ({ selector: h, options: { uppercase: false } })),
      { selector: "table", options: { uppercaseHeaderCells: false } },
      { selector: "a", options: { ignoreHref: false, hideLinkHrefIfSameAsText: true } },
    ],
  }).trim();
  return truncate(text, maxChars);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n…[truncated — ${text.length - maxChars} more characters. Ask for a later offset to continue.]`;
}

const TEXT_EXT = /\.(txt|md|csv|tsv|json|py|js|ts|java|c|cpp|h|cs|html?|xml|css|sql|r|m)$/i;

export async function extractFileText(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<{ text: string; kind: string }> {
  const name = filename.toLowerCase();
  const ct = contentType.toLowerCase();

  if (name.endsWith(".pdf") || ct.includes("pdf")) {
    const pdf = await getDocumentProxy(bytes);
    const { text, totalPages } = await extractText(pdf, { mergePages: false });
    const pages = (text as string[]).map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join("\n\n");
    const isScanned = pages.replace(/--- Page \d+ ---/g, "").trim().length < 20 * totalPages;
    return {
      text: isScanned
        ? pages + "\n\n[Note: this PDF has almost no text layer — it's probably scanned images. Download it and attach it to the chat directly so Claude can see the pages.]"
        : pages,
      kind: `pdf (${totalPages} pages)`,
    };
  }

  if (name.endsWith(".docx") || ct.includes("wordprocessingml")) {
    // mammoth opens each part it needs through `file` (an input its own tests use), so every part goes through the
    // capped reader, and parts it never opens (pictures) are never inflated.
    const zip = openZip(bytes, "docx");
    const file = {
      exists: (part: string) => zip.has(part),
      read: async (part: string, encoding?: string) => {
        const data = zip.read(part);
        return !encoding ? data : encoding === "base64" ? Buffer.from(data).toString("base64") : new TextDecoder(encoding).decode(data);
      },
    };
    const { value } = await mammoth.extractRawText({ file } as any);
    return { text: value.trim(), kind: "docx" };
  }

  if (name.endsWith(".pptx") || ct.includes("presentationml")) {
    return { text: pptxText(bytes), kind: "pptx" };
  }

  if (name.endsWith(".html") || name.endsWith(".htm") || ct.includes("text/html")) {
    return { text: htmlToText(new TextDecoder().decode(bytes), Infinity), kind: "html" };
  }

  if (TEXT_EXT.test(name) || ct.startsWith("text/") || ct.includes("json")) {
    return { text: new TextDecoder().decode(bytes), kind: "text" };
  }

  throw new Error(
    `Can't extract text from "${filename}" (${contentType || "unknown type"}). ` +
      `Supported: PDF, DOCX, PPTX, HTML, plain text/code. For images or other formats, use the download_url and attach the file to the chat.`,
  );
}

// PPTX = zip of XML slides.
function pptxText(bytes: Uint8Array): string {
  const zip = openZip(bytes, "pptx"), dec = new TextDecoder();
  const entries = new Map(zip.names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    .map((n): [string, string] => [n, dec.decode(zip.read(n))]));
  const num = (n: string) => Number(n.match(/(\d+)\.xml$/)![1]);
  const slides = [...entries.keys()].filter((n) => n.includes("/slides/")).sort((a, b) => num(a) - num(b));
  return slides
    .map((s) => {
      const body = xmlRuns(entries.get(s)!);
      const notesKey = `ppt/notesSlides/notesSlide${num(s)}.xml`;
      const notes = entries.has(notesKey) ? xmlRuns(entries.get(notesKey)!) : "";
      return `--- Slide ${num(s)} ---\n${body}${notes ? `\n[Speaker notes] ${notes}` : ""}`;
    })
    .join("\n\n");
}

function xmlRuns(xml: string): string {
  return xml
    .split(/<\/a:p>/)
    .map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(""))
    .filter((l) => l.trim())
    .join("\n")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** A zip's entries, from its central directory (zip64 too). read() decompresses one, within ZIP_LIMITS counted over
 *  every read from this zip, and refuses with TOO_LARGE past them. An entry that points at a local header an earlier
 *  entry already claimed is left out: listing one compressed stream thousands of times is how small zip bombs work.
 *  Tiny reader so we don't pull in another dependency. */
function openZip(bytes: Uint8Array, kind: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  const invalid = () => new Error(`Not a valid ${kind} file`);
  /** Offsets past the end make DataView throw a RangeError: a damaged file. */
  const parse = <T>(read: () => T): T => {
    try { return read(); } catch (e) { throw e instanceof RangeError ? invalid() : e; }
  };

  const entries = new Map<string, { method: number; size: number; offset: number }>();
  parse(() => {
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw invalid();
    let count = u16(eocd + 10), ptr = u32(eocd + 16);
    if ((count === 0xffff || ptr === 0xffffffff) && eocd >= 20 && u32(eocd - 20) === 0x07064b50) { // zip64 end record
      const end64 = u64(eocd - 12);
      if (u32(end64) !== 0x06064b50) throw invalid();
      [count, ptr] = [u64(end64 + 32), u64(end64 + 48)];
    }
    const names = new TextDecoder(), claimed = new Set<number>();
    for (let i = 0; i < count; i++) {
      if (u32(ptr) !== 0x02014b50) throw invalid();
      const nameLen = u16(ptr + 28), extraLen = u16(ptr + 30), extra = ptr + 46 + nameLen;
      const entry = { method: u16(ptr + 10), size: u32(ptr + 20), offset: u32(ptr + 42) };
      // zip64: a 32-bit field of all ones means the value is in the zip64 extra field, which lists only those, in order.
      const big = [u32(ptr + 24), entry.size, entry.offset].map((v) => v === 0xffffffff);
      for (let x = extra; big.includes(true) && x + 4 <= extra + extraLen; x += 4 + u16(x + 2)) {
        if (u16(x) !== 0x0001) continue;
        let at = x + 4 + (big[0] ? 8 : 0);
        if (big[1]) { entry.size = u64(at); at += 8; }
        if (big[2]) entry.offset = u64(at);
        break;
      }
      const name = names.decode(bytes.subarray(ptr + 46, extra));
      ptr = extra + extraLen + u16(ptr + 32);
      if (claimed.has(entry.offset)) continue;
      claimed.add(entry.offset);
      entries.set(name, entry);
    }
  });

  let total = 0;
  return {
    names: [...entries.keys()],
    has: (name: string) => entries.has(name),
    read(name: string): Uint8Array {
      const e = entries.get(name);
      if (!e) throw invalid();
      const data = parse(() => {
        if (u32(e.offset) !== 0x04034b50) throw invalid();
        const start = e.offset + 30 + u16(e.offset + 26) + u16(e.offset + 28);
        return bytes.subarray(start, start + e.size);
      });
      const room = Math.min(ZIP_LIMITS.entryBytes, ZIP_LIMITS.totalBytes - total);
      let out = data; // method 0: stored as is
      if (e.method === 8) {
        if (room < 1) throw new Error(TOO_LARGE);
        try {
          out = inflateRawSync(data, { maxOutputLength: room });
        } catch (err) {
          throw (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? new Error(TOO_LARGE) : invalid();
        }
      } else if (e.method !== 0) throw invalid();
      if (out.length > room) throw new Error(TOO_LARGE);
      total += out.length;
      return out;
    },
  };
}
