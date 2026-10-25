// Handlers may take any Event subtype (e: KeyboardEvent) — `never` accepts them all.
type Attrs = Record<string, string | number | boolean | undefined | null | ((e: never) => void) | Record<string, string | number>>;
type Child = Node | string | number | false | null | undefined | Child[];

/** Tiny element builder: h('button', { class: 'btn', onclick: fn }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) (el.style as unknown as Record<string, string>)[sk] = typeof sv === 'number' && sv !== 0 ? `${sv}px` : String(sv);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else if (k in el && k !== 'list' && typeof v !== 'object') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Inline SVG icon from a path list (24×24 viewBox, stroked). */
export function icon(paths: string, size = 16): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = paths;
  return s;
}

const stroke = (d: string) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
export const ICONS = {
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/>',
  loop: stroke('M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3'),
  undo: stroke('M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3'),
  redo: stroke('M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3'),
  download: stroke('M12 3v12M7 10l5 5 5-5M5 21h14'),
  eye: stroke('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z') + '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>',
  eyeOff: stroke('M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6'),
  lock: stroke('M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4'),
  unlock: stroke('M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2'),
  plus: stroke('M12 5v14M5 12h14'),
  minus: stroke('M5 12h14'),
  keyboard: stroke('M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10'),
  sun: stroke('M12 3v2M12 19v2M5 5l1.4 1.4M17.6 17.6 19 19M3 12h2M19 12h2M5 19l1.4-1.4M17.6 6.4 19 5') + '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/>',
  moon: stroke('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'),
  rows: stroke('M4 6h16M4 12h16M4 18h16'),
  preview: stroke('M3 5h18v12H3zM8 21h8M12 17v4'),
  close: stroke('M6 6l12 12M18 6 6 18'),
  panelLeft: stroke('M3 4h18v16H3zM9 4v16'),
  panelRight: stroke('M3 4h18v16H3zM15 4v16'),
  trash: stroke('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
};

export function formatTime(ms: number, fine = true): string {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return fine ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
}

let toastHost: HTMLElement | undefined;
/** A short message at the bottom of the screen, with an optional action button. */
export function toast(msg: string, action?: { label: string; run: () => void }, ms = 3200) {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const t = h('div', { class: 'toast' }, msg);
  if (action) t.append(h('button', { onclick: () => { action.run(); t.remove(); } }, action.label));
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

export function download(name: string, data: string | Uint8Array, type = 'application/octet-stream') {
  const blob = new Blob([data as BlobPart], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * Whether the focused control needs this key itself: text fields take every key, sliders
 * their arrow keys, checkboxes Space. Anything else (a slider just dragged, a color just
 * picked) leaves the shortcuts to the editor.
 */
export const ownsKey = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
  if (!(t instanceof HTMLInputElement)) return false;
  if (t.type === 'range') return /^(Arrow|Page|Home|End)/.test(e.key);
  if (t.type === 'checkbox' || t.type === 'radio') return e.key === ' ';
  return t.type !== 'button' && t.type !== 'color';
};

export const swatches = (colors: readonly string[]) => h('span', { class: 'swatches' }, colors.map((c) => h('i', { style: { background: c } })));

export function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'sequence';
}
