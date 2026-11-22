// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its line break, its lines, whether it ends with a break. */
interface Doc {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function toDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function fromDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBr ? d.br : '');
}

/** One line compared at a tier: 0 exact, 1 trailing-insensitive, 2 both-ends-insensitive. */
function tierText(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchAt(lines: string[], at: number, o: string[], tier: number): boolean {
  for (let j = 0; j < o.length; j += 1) {
    if (tierText(lines[at + j]!, tier) !== tierText(o[j]!, tier)) return false;
  }
  return true;
}

function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (matchAt(lines, i, o, tier)) out.push(i);
  }
  return out;
}

/** The first tier at which o occurs at least once, at or after `from`, with its positions. */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function reindentLine(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a hunk or chunk: context, old or new. A `\` line marks the line before it. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
}

interface RawBody {
  kind: 'ctx' | 'old' | 'new' | 'bslash';
  text: string;
}

function bodyItems(raw: RawBody[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const r of raw) {
    if (r.kind === 'bslash') {
      if (items.length > 0) items[items.length - 1]!.noEol = true;
      continue;
    }
    items.push({ kind: r.kind, text: r.text, noEol: false });
  }
  return items;
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.kind !== 'old') return items[i]!.noEol;
  }
  return false;
}

interface NewLine {
  file?: number;
  text?: string;
}

/** Split body items into old lines O and new lines N (context entries name their O index). */
function splitItems(items: BodyItem[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ file: oi });
      oi += 1;
    } else if (it.kind === 'old') {
      o.push(it.text);
      oi += 1;
    } else {
      n.push({ text: it.text });
    }
  }
  return { o, n };
}

/** The replacement lines for N: context lines are the file's own, others re-indented at tier 2. */
function buildNew(n: NewLine[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = fileLines.length > pos ? leadWs(fileLines[pos]!) : '';
  return n.map((e) => {
    if (e.file !== undefined) return fileLines[pos + e.file]!;
    if (tier === 2) return reindentLine(e.text!, p, f);
    return e.text!;
  });
}

/** Re-indent plain new lines (SEARCH/REPLACE) at tier 2. */
function reindentAll(ns: string[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return ns.slice();
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = fileLines.length > pos ? leadWs(fileLines[pos]!) : '';
  return ns.map((l) => reindentLine(l, p, f));
}

/** Apply hunks in order to a document, following section 6's nearest-occurrence rule. */
function applyHunks(doc: Doc, hunks: { a: number; items: BodyItem[] }[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitItems(h.items);
    if (o.length === 0) {
      const ins = Math.min(h.a + d, doc.lines.length);
      const atEnd = ins === doc.lines.length;
      const added = buildNew(n, doc.lines, ins, o, 0);
      doc.lines.splice(ins, 0, ...added);
      if (atEnd) doc.finalBr = !hunkNoEol(h.items);
      d += n.length;
      continue;
    }
    const found = firstTier(doc.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + o.length === doc.lines.length;
    const added = buildNew(n, doc.lines, best, o, found.tier);
    doc.lines.splice(best, o.length, ...added);
    if (atEnd) doc.finalBr = !hunkNoEol(h.items);
    d += n.length - o.length;
  }
}

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A `---`/`+++` path: up to the first tab, surrounding spaces removed, a/ or b/ stripped. */
function diffPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function unifiedCreate(path: string, hunks: Hunk[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    const plus: string[] = [];
    let lastNew: BodyItem | null = null;
    for (const h of hunks) {
      for (const it of h.items) {
        if (it.kind === 'new') {
          plus.push(it.text);
          lastNew = it;
        }
      }
    }
    const noEol = lastNew !== null && lastNew.noEol;
    tree.now.set(path, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
  };
}

function unifiedDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function unifiedChange(path: string, hunks: Hunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = toDoc(before);
    applyHunks(doc, hunks, strict, path);
    tree.now.set(path, fromDoc(doc));
  };
}

function unifiedMove(oldP: string, newP: string, hunks: Hunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const doc = toDoc(before);
    applyHunks(doc, hunks, strict, oldP);
    tree.now.set(newP, fromDoc(doc));
    tree.now.set(oldP, null);
    tree.moves.push([oldP, newP]);
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: USection[] = [];
  let cur: USection | null = null;
  let phase: 'header' | 'hunks' = 'header';
  let pairSeen = false;
  let i = 0;
  const fresh = (diffOld: string | null, diffNew: string | null): USection => ({
    pairOld: null,
    pairNew: null,
    diffOld,
    diffNew,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(diffPath(m[1]!), diffPath(m[2]!));
      sections.push(cur);
      phase = 'header';
      pairSeen = false;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const raw: RawBody[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          raw.push({ kind: 'ctx', text: '' });
          i += 1;
          continue;
        }
        if (b.startsWith(' ')) {
          raw.push({ kind: 'ctx', text: b.slice(1) });
          i += 1;
          continue;
        }
        if (b.startsWith('-')) {
          raw.push({ kind: 'old', text: b.slice(1) });
          i += 1;
          continue;
        }
        if (b.startsWith('+')) {
          raw.push({ kind: 'new', text: b.slice(1) });
          i += 1;
          continue;
        }
        if (b.startsWith('\\')) {
          raw.push({ kind: 'bslash', text: '' });
          i += 1;
          continue;
        }
        break;
      }
      while (raw.length > 0) {
        const lastR = raw[raw.length - 1]!;
        if (lastR.kind === 'ctx' && lastR.text === '') {
          raw.pop();
          continue;
        }
        if (lastR.kind === 'bslash' && raw.length > 1) {
          const prev = raw[raw.length - 2]!;
          if (prev.kind === 'ctx' && prev.text === '') {
            raw.pop();
            continue;
          }
        }
        break;
      }
      cur.hunks.push({ a: parseInt(m[1]!, 10), items: bodyItems(raw) });
      phase = 'hunks';
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && phase === 'header' && !pairSeen) {
          cur.pairOld = diffPath(line.slice(4));
          cur.pairNew = diffPath(next.slice(4));
          pairSeen = true;
          i += 2;
          continue;
        }
        cur = fresh(null, null);
        sections.push(cur);
        phase = 'header';
        pairSeen = true;
        cur.pairOld = diffPath(line.slice(4));
        cur.pairNew = diffPath(next.slice(4));
        i += 2;
        continue;
      }
      if (cur !== null && phase === 'header') throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && phase === 'header') {
      if (line.startsWith('+++ ')) {
        cur.pairNew = diffPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    if (sec.isCreate || oldP === null) {
      if (newP === null) throw new Exit2('error: parse 1');
      edits.push(unifiedCreate(newP, sec.hunks));
    } else if (sec.isDelete || newP === null) {
      edits.push(unifiedDelete(oldP));
    } else if (oldP !== newP) {
      edits.push(unifiedMove(oldP, newP, sec.hunks, strict));
    } else {
      edits.push(unifiedChange(oldP, sec.hunks, strict));
    }
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = toDoc(before);
    const found = firstTier(doc.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const added = reindentAll(newLines, oldLines, doc.lines, pos, found.tier);
    doc.lines.splice(pos, oldLines.length, ...added);
    tree.now.set(path, fromDoc(doc));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') break;
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      j += 1;
    }
    if (j >= lines.length || lines[j]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchLine}`);
    const eq = j;
    let k = eq + 1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') break;
      if (t === '<<<<<<< SEARCH') break;
      k += 1;
    }
    if (k >= lines.length || lines[k]!.trimEnd() !== '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, k);
    let path: string | null = null;
    for (let p = i - 1; p >= searchFrom; p -= 1) {
      const t = lines[p]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    prevPath = path;
    edits.push(srEdit(path, oldLines, newLines, strict));
    searchFrom = k + 1;
    i = k + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (tierText(lines[i]!, t) === tierText(anchor, t)) return i;
    }
  }
  return null;
}

function firstTierEof(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from).filter((p) => p + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function v4aAdd(path: string, raw: string[], startIdx: number): Edit {
  const fileLines: string[] = [];
  for (let k = 0; k < raw.length; k += 1) {
    const l = raw[k]!;
    if (l.startsWith('+')) fileLines.push(l.slice(1));
    else if (l === '') fileLines.push('');
    else throw new Exit2(`error: parse ${startIdx + k + 1}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, raw: string[], startIdx: number, headerLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0) {
    const mm = /^\*\*\* Move to: ?(.*)$/.exec(raw[0]!);
    if (mm !== null) {
      moveTo = (mm[1] ?? '').trim();
      idx = 1;
    }
  }
  const chunks: VChunk[] = [];
  let firstChunk = true;
  while (idx < raw.length) {
    const line = raw[idx]!;
    if (line.trimEnd() === '*** End of File') throw new Exit2(`error: parse ${startIdx + idx + 1}`);
    let anchor: string | null = null;
    if (line.startsWith('@@')) {
      anchor = line.slice(2).trim();
      idx += 1;
    } else if (!firstChunk) {
      throw new Exit2(`error: parse ${startIdx + idx + 1}`);
    }
    const bodyRaw: RawBody[] = [];
    let eof = false;
    while (idx < raw.length) {
      const b = raw[idx]!;
      if (b.startsWith('@@')) break;
      if (b.trimEnd() === '*** End of File') {
        eof = true;
        idx += 1;
        break;
      }
      if (b === '') {
        bodyRaw.push({ kind: 'ctx', text: '' });
        idx += 1;
        continue;
      }
      if (b.startsWith(' ')) {
        bodyRaw.push({ kind: 'ctx', text: b.slice(1) });
        idx += 1;
        continue;
      }
      if (b.startsWith('-')) {
        bodyRaw.push({ kind: 'old', text: b.slice(1) });
        idx += 1;
        continue;
      }
      if (b.startsWith('+')) {
        bodyRaw.push({ kind: 'new', text: b.slice(1) });
        idx += 1;
        continue;
      }
      throw new Exit2(`error: parse ${startIdx + idx + 1}`);
    }
    chunks.push({ anchor, eof, items: bodyItems(bodyRaw) });
    firstChunk = false;
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = toDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(doc.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = splitItems(ch.items);
      if (o.length === 0) {
        const ins = ch.eof ? doc.lines.length : cursor;
        const added = buildNew(n, doc.lines, ins, o, 0);
        doc.lines.splice(ins, 0, ...added);
        cursor = ins + added.length;
        continue;
      }
      const found = ch.eof ? firstTierEof(doc.lines, o, strict, cursor) : firstTier(doc.lines, o, strict, cursor);
      if (!found) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const added = buildNew(n, doc.lines, pos, o, found.tier);
      doc.lines.splice(pos, o.length, ...added);
      cursor = pos + added.length;
    }
    const out = fromDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secRe = /^\*\*\* (Add|Delete|Update) File: ?(.*)$/;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const m = secRe.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = (m[2] ?? '').trim();
    const start = i + 1;
    let j = start;
    while (j < last && !secRe.test(lines[j]!)) j += 1;
    const raw = lines.slice(start, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'Add') {
      edits.push(v4aAdd(path, raw, start));
    } else if (kind === 'Delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${start + 1}`);
      edits.push(v4aDelete(path));
    } else {
      edits.push(v4aUpdate(path, raw, start, i + 1, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.get(oldP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      changed.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
