/**
 * A small XML reader for xLights' own files (.xsq, .xtiming, xlights_rgbeffects.xml).
 * It runs in the browser, in workers and in Node tests alike (no DOM needed), and keeps
 * each element's source range so unknown content can be written back verbatim on round trips.
 */
export type XNode = {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Concatenated text content directly inside this element (unescaped). */
  text: string;
  /** Character range of the whole element in the source. */
  start: number;
  end: number;
};

export function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
    switch (e.toLowerCase()) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** Escape text content the way pugixml does (xLights' writer): &, < and >. */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape an attribute value the way pugixml does: &, < and ". */
export function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Parse an XML document and return its root element. Throws on malformed nesting. */
export function parseXml(src: string): XNode {
  const root: XNode = { name: '#document', attrs: {}, children: [], text: '', start: 0, end: src.length };
  const stack: XNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += unescapeXml(src.slice(i));
      break;
    }
    if (lt > i) top.text += unescapeXml(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, e < 0 ? src.length : e);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const e = src.indexOf('>', lt);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    // Find the end of the tag, skipping '>' inside quoted attribute values.
    let j = lt + 1;
    let quote = '';
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const tag = src.slice(lt + 1, j);
    i = j + 1;
    if (tag[0] === '/') {
      const name = tag.slice(1).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Malformed XML: unexpected </${name}> at ${lt}`);
      node.end = i;
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameEnd = body.search(/[\s]/);
    const name = nameEnd < 0 ? body : body.slice(0, nameEnd);
    const attrs: Record<string, string> = {};
    if (nameEnd >= 0) {
      for (const m of body.slice(nameEnd).matchAll(ATTR_RE)) attrs[m[1]] = unescapeXml(m[3] ?? m[4] ?? '');
    }
    const node: XNode = { name, attrs, children: [], text: '', start: lt, end: i };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length > 1) throw new Error(`Malformed XML: <${stack[stack.length - 1].name}> is never closed`);
  const el = root.children[0];
  if (!el) throw new Error('Not an XML document');
  return el;
}

export const child = (n: XNode | undefined, name: string): XNode | undefined => n?.children.find((c) => c.name === name);
export const children = (n: XNode | undefined, name: string): XNode[] => n?.children.filter((c) => c.name === name) ?? [];
