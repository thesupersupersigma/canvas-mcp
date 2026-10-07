// Zip files built in memory for the tests. An entry is [name, contents] (deflated), [name, contents, { store: true }],
// or [name, { sameAs: earlierName }]: a second central-directory entry for an earlier entry's local header and data,
// the way a few kB of zip can list one huge stream thousands of times. { zip64: true } writes every size and offset the
// zip64 way (all ones in the 32-bit fields, the real values in extra fields and a zip64 end record).
import zlib from "node:zlib";

const zip64Extra = (...values) => {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
};
// An extended-timestamp field ahead of the zip64 one, so readers have to walk the extra fields.
const TIMESTAMP = Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]);
const ALL_ONES = 0xffffffff;

export function makeZip(entries, { zip64 = false } = {}) {
  const parts = [], central = [], placed = new Map(), deflated = new Map(); // the same contents twice: deflated once
  let offset = 0;
  const centralEntry = (name, e) => {
    const extra = zip64 ? Buffer.concat([TIMESTAMP, zip64Extra(e.size, e.comp, e.offset)]) : Buffer.alloc(0);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(45, 4);
    c.writeUInt16LE(zip64 ? 45 : 20, 6);
    c.writeUInt16LE(e.method, 10);
    c.writeUInt32LE(e.crc, 16);
    c.writeUInt32LE(zip64 ? ALL_ONES : e.comp, 20);
    c.writeUInt32LE(zip64 ? ALL_ONES : e.size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(zip64 ? ALL_ONES : e.offset, 42);
    return Buffer.concat([c, name, extra]);
  };
  for (const [name, contents, { store = false } = {}] of entries) {
    const n = Buffer.from(name);
    if (contents.sameAs) { central.push(centralEntry(n, placed.get(contents.sameAs))); continue; }
    if (!store && !deflated.has(contents)) deflated.set(contents, zlib.deflateRawSync(contents));
    const data = store ? contents : deflated.get(contents);
    // CRC is 0 where zlib.crc32 is missing (Node < 20.15): nothing here checks it.
    const e = { method: store ? 0 : 8, crc: zlib.crc32?.(contents) ?? 0, comp: data.length, size: contents.length, offset };
    placed.set(name, e);
    const extra = zip64 ? zip64Extra(e.size, e.comp) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(zip64 ? ALL_ONES : e.comp, 18);
    local.writeUInt32LE(zip64 ? ALL_ONES : e.size, 22);
    local.writeUInt16LE(n.length, 26);
    local.writeUInt16LE(extra.length, 28);
    parts.push(local, n, extra, data);
    offset += local.length + n.length + extra.length + data.length;
    central.push(centralEntry(n, e));
  }
  const cd = Buffer.concat(central), count = central.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(zip64 ? ALL_ONES : cd.length, 12);
  end.writeUInt32LE(zip64 ? ALL_ONES : offset, 16);
  if (!zip64) return Buffer.concat([...parts, cd, end]);
  const record = Buffer.alloc(56), locator = Buffer.alloc(20);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(cd.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...parts, cd, record, locator, end]);
}

const xml = (s) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`);
const CONTENT_TYPES = xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
const PACKAGE_RELS = xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');

/** A minimal .docx with one paragraph per string; `document` replaces word/document.xml; `more` adds entries. */
export function makeDocx(paragraphs, { document, more = [], zip64 = false } = {}) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return makeZip([["[Content_Types].xml", CONTENT_TYPES], ["_rels/.rels", PACKAGE_RELS],
    ["word/document.xml", document ?? xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)],
    ...more], { zip64 });
}

/** A .pptx as far as read_file looks: slide n (from 1) holds slides[n - 1]; `more` adds entries. */
export const slideXml = (text) => xml(`<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`);
export const makePptx = (slides, { more = [], zip64 = false } = {}) =>
  makeZip([...slides.map((t, i) => [`ppt/slides/slide${i + 1}.xml`, slideXml(t)]), ...more], { zip64 });
