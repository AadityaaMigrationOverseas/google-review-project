type Child = Node | string | number | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined;
type Attrs = Record<string, AttrValue | EventListener>;

/**
 * Tiny element factory. Text is always inserted as text nodes and attributes
 * via setAttribute, so untrusted data can never become markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Array<Child | Child[]>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else if (value !== false && value !== null && value !== undefined) {
        if (/^on/i.test(key)) throw new Error('inline handlers are not allowed');
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Array<Child | Child[]>): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function replaceChildren(parent: Element, ...children: Array<Child | Child[]>): void {
  parent.replaceChildren();
  append(parent, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Decorative inline SVG icon from fixed path data. */
export function icon(paths: string[], viewBox = '0 0 24 24', className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
