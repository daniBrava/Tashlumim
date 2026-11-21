// Minimal .xlsx reader: unzip + read cell values (shared strings, inline strings, numbers).
// Enough for bank / credit-card exports; no formulas, no styles. Runs in the browser and in Node.
import { strFromU8, unzipSync } from 'fflate';

export type Cell = string | number | null;
export interface Sheet {
  name: string;
  rows: Cell[][];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e],
    )
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function textOf(xml: string): string {
  // Concatenate every <t> run, skipping phonetic hints.
  const clean = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += m[1];
  return decodeXml(out);
}

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : undefined;
}

export function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml: string, shared: string[]): Cell[][] {
  const rows: Cell[][] = [];
  let nextRow = 0;
  for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rAttr = attr(rm[1], 'r');
    const ri = rAttr ? Number(rAttr) - 1 : nextRow;
    nextRow = ri + 1;
    const row: Cell[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const a = cm[1];
      const ref = attr(a, 'r');
      const ci = ref ? colIndex(ref) : nextCol;
      nextCol = ci + 1;
      const body = cm[2] ?? '';
      const t = attr(a, 't') ?? 'n';
      const v = body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
      let value: Cell = null;
      if (t === 's') value = v != null ? shared[Number(v)] ?? null : null;
      else if (t === 'inlineStr') value = textOf(body);
      else if (t === 'str' || t === 'e') value = v != null ? decodeXml(v) : null;
      else if (t === 'b') value = v === '1' ? 1 : 0;
      else value = v != null && v !== '' ? Number(v) : null;
      row[ci] = value;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    rows[ri] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

export function readXlsx(data: Uint8Array): Sheet[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/i.test(f.name),
    });
  } catch {
    throw new Error('not-xlsx');
  }
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('not-xlsx');

  const shared = [...text('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));

  const rels: Record<string, string> = {};
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels[id] = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const name = attr(m[1], 'name') ?? '';
    const rid = attr(m[1], 'r:id');
    const path = rid ? rels[rid] : undefined;
    const xml = path ? text(path) : '';
    if (xml) sheets.push({ name, rows: parseSheet(xml, shared) });
  }
  return sheets;
}
