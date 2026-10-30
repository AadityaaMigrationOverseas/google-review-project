import { CLINIC, type ShortLinkDto } from '@stellar/shared';
import { ApiRequestError } from '../../../lib/api';
import { h, replaceChildren } from '../../../lib/dom';
import { adminApi, session } from '../session';
import { badge, copyText, emptyState, errorState, formatDate, skeletons, toast, viewHead } from '../ui';

const SOURCES = ['WhatsApp', 'SMS', 'QR code', 'Email', 'Reception', 'Other'];

function shareMessage(url: string): string {
  return `Thank you for visiting ${CLINIC.name}! We'd love to hear about your experience with ${CLINIC.doctorName}: ${url}`;
}

function linkItem(link: ShortLinkDto, onUpdate: (l: ShortLinkDto) => void): HTMLElement {
  const canWrite = session.can('links:write');
  const message = shareMessage(link.url);
  const qrSrc = `/api/admin/links/${link.id}/qr.svg`;
  const expired = link.expiresAt !== null && link.expiresAt < Date.now();

  const toggle = canWrite
    ? h(
        'button',
        {
          class: `btn btn--sm${link.disabled ? '' : ' btn--danger'}`,
          type: 'button',
          onclick: async () => {
            try {
              const updated = await adminApi<ShortLinkDto>(`/api/admin/links/${link.id}`, {
                method: 'PATCH',
                body: { disabled: !link.disabled },
              });
              toast(updated.disabled ? 'Link disabled' : 'Link re-enabled');
              onUpdate(updated);
            } catch (err) {
              toast(err instanceof ApiRequestError ? err.message : 'Update failed');
            }
          },
        },
        link.disabled ? 'Enable' : 'Disable',
      )
    : null;

  return h(
    'article',
    { class: `item link-card${link.disabled || expired ? ' item--disabled' : ''}` },
    h(
      'div',
      { class: 'list' },
      h(
        'div',
        { class: 'item__head' },
        h('strong', null, link.label),
        h(
          'div',
          { class: 'toolbar' },
          link.source ? badge(link.source) : null,
          link.disabled ? badge('Disabled', 'failed') : expired ? badge('Expired', 'pending') : badge('Active', 'sent'),
        ),
      ),
      h('code', { class: 'link-card__url' }, link.url),
      h(
        'div',
        { class: 'item__meta' },
        h('span', null, `${link.clickCount} opens`),
        h('span', null, `${link.reviewCount} reviews`),
        h('span', null, `Created ${formatDate(link.createdAt)}${link.createdBy ? ` by ${link.createdBy}` : ''}`),
        link.expiresAt ? h('span', null, `Expires ${formatDate(link.expiresAt)}`) : null,
      ),
      h(
        'div',
        { class: 'item__actions' },
        h('button', { class: 'btn btn--sm', type: 'button', onclick: () => void copyText(link.url) }, 'Copy link'),
        h('button', { class: 'btn btn--sm', type: 'button', onclick: () => void copyText(message) }, 'Copy message'),
        h(
          'a',
          {
            class: 'btn btn--sm',
            href: `https://wa.me/?text=${encodeURIComponent(message)}`,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'WhatsApp',
        ),
        h('a', { class: 'btn btn--sm', href: `sms:?&body=${encodeURIComponent(message)}` }, 'SMS'),
        h('a', { class: 'btn btn--sm', href: qrSrc, download: `stellar-review-${link.code}.svg` }, 'Download QR'),
        toggle,
      ),
    ),
    h('img', {
      class: 'link-card__qr',
      src: qrSrc,
      alt: `QR code for ${link.label}`,
      loading: 'lazy',
      decoding: 'async',
      width: '120',
      height: '120',
    }),
  );
}

export function renderLinks(main: HTMLElement, signal: AbortSignal): void {
  const list = h('div', { class: 'list', 'aria-live': 'polite' }, skeletons(3));
  const items = new Map<number, HTMLElement>();

  const place = (link: ShortLinkDto, prepend = false) => {
    const el = linkItem(link, (updated) => place(updated));
    const existing = items.get(link.id);
    if (existing) existing.replaceWith(el);
    else if (prepend) list.prepend(el);
    else list.append(el);
    items.set(link.id, el);
  };

  let form: HTMLElement | null = null;
  if (session.can('links:write')) {
    const label = h('input', {
      class: 'input',
      id: 'link-label',
      required: true,
      maxlength: '80',
      placeholder: 'e.g. Reception desk QR',
    });
    const source = h(
      'select',
      { class: 'select', id: 'link-source' },
      SOURCES.map((s) => h('option', { value: s }, s)),
    );
    const expiry = h('input', {
      class: 'input',
      id: 'link-expiry',
      type: 'number',
      min: '1',
      max: '3650',
      placeholder: 'Never',
    });
    const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Create link');
    const error = h('p', { class: 'field__error', role: 'alert' });
    form = h(
      'form',
      {
        class: 'panel',
        novalidate: true,
        onsubmit: async (e: Event) => {
          e.preventDefault();
          error.textContent = '';
          submit.disabled = true;
          try {
            const link = await adminApi<ShortLinkDto>('/api/admin/links', {
              method: 'POST',
              body: { label: label.value, source: source.value, expiresInDays: expiry.value || null },
            });
            label.value = '';
            expiry.value = '';
            list.querySelector('.empty')?.remove();
            place(link, true);
            toast('Review link created');
          } catch (err) {
            error.textContent =
              err instanceof ApiRequestError ? (Object.values(err.fields)[0] ?? err.message) : 'Could not create link';
          } finally {
            submit.disabled = false;
          }
        },
      },
      h('h2', null, 'Create a review link'),
      h(
        'div',
        { class: 'inline-form' },
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'link-label' }, 'Label'), label),
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'link-source' }, 'Channel'), source),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field__label', for: 'link-expiry' }, 'Expires in (days)'),
          expiry,
        ),
        submit,
      ),
      error,
    );
  }

  replaceChildren(main, viewHead('Review links'), form, list);

  adminApi<{ items: ShortLinkDto[] }>('/api/admin/links', { signal })
    .then(({ items: links }) => {
      list.replaceChildren();
      if (links.length === 0)
        list.append(emptyState('No review links yet. Create one to share via WhatsApp, SMS or QR.'));
      for (const l of links) place(l);
    })
    .catch((err) => {
      if (!signal.aborted)
        replaceChildren(
          list,
          errorState(err, () => renderLinks(main, signal)),
        );
    });
}
