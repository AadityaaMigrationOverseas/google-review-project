import { RATING_LABELS } from '@stellar/shared';
import { ApiRequestError } from '../../lib/api';
import { h } from '../../lib/dom';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDate(ms: number | null): string {
  return ms === null ? '—' : dateFmt.format(new Date(ms));
}

export function ratingStars(rating: number): HTMLElement {
  return h(
    'span',
    { class: 'rating', title: `${rating} of 5 – ${RATING_LABELS[rating]}` },
    h(
      'span',
      { 'aria-hidden': 'true' },
      '★'.repeat(rating),
      h('span', { class: 'rating__empty' }, '★'.repeat(5 - rating)),
    ),
    h('span', { class: 'sr-only' }, `${rating} of 5 stars`),
  );
}

export function badge(text: string, variant?: string | null): HTMLElement {
  return h('span', { class: `badge${variant ? ` badge--${variant}` : ''}` }, text);
}

export function skeletons(count: number, variant = ''): HTMLElement[] {
  return Array.from({ length: count }, () =>
    h('div', { class: `skeleton${variant ? ` skeleton--${variant}` : ''}`, 'aria-hidden': 'true' }),
  );
}

export function emptyState(message: string): HTMLElement {
  return h('p', { class: 'empty' }, message);
}

export function errorState(err: unknown, retry?: () => void): HTMLElement {
  const message = err instanceof ApiRequestError ? err.message : 'Could not load this section.';
  return h(
    'div',
    { class: 'alert alert--error', role: 'alert' },
    h('p', null, message, ' '),
    retry ? h('button', { class: 'btn btn--sm', type: 'button', onclick: retry }, 'Try again') : null,
  );
}

export function select(
  id: string,
  label: string,
  options: Array<[string, string]>,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const el = h(
    'select',
    { id, class: 'select', onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)),
  );
  return h('label', { class: 'sr-only-label' }, h('span', { class: 'sr-only' }, label), el);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed — select the text and copy it manually');
  }
}

export function viewHead(title: string, ...actions: Array<HTMLElement | null>): HTMLElement {
  return h('div', { class: 'view-head' }, h('h1', null, title), h('div', { class: 'toolbar' }, actions));
}
