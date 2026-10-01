// Turns Canvas HTML and uploaded files into plain text Claude can read.
import { convert } from "html-to-text";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

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
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: value.trim(), kind: "docx" };
  }

  if (name.endsWith(".pptx") || ct.includes("presentationml")) {
    return { text: await pptxText(bytes), kind: "pptx" };
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

// PPTX = zip of XML slides. Tiny zip reader so we don't pull in another dependency.
async function pptxText(bytes: Uint8Array): Promise<string> {
  const entries = await readZip(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
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

async function readZip(bytes: Uint8Array, want: (name: string) => boolean): Promise<Map<string, string>> {
  const { inflateRawSync } = await import("node:zlib");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid zip/pptx file");
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOff = view.getUint32(ptr + 42, true);
    const name = dec.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    if (want(name)) {
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compSize);
      out.set(name, dec.decode(method === 0 ? data : inflateRawSync(data)));
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
