import { COMPLAINT_STATUSES, type ComplaintDto, type ComplaintStatus, type Page } from '@stellar/shared';
import { ApiRequestError } from '../../../lib/api';
import { h, replaceChildren } from '../../../lib/dom';
import { adminApi, session } from '../session';
import { badge, emptyState, errorState, formatDate, ratingStars, select, skeletons, toast, viewHead } from '../ui';

const STATUS_TEXT: Record<ComplaintStatus, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
const NOTIFY_TEXT: Record<string, string> = {
  pending: 'Email queued',
  sending: 'Email sending',
  sent: 'Email sent',
  failed: 'Email failed',
};

function notificationBadge(c: ComplaintDto): HTMLElement {
  return c.notificationStatus
    ? badge(NOTIFY_TEXT[c.notificationStatus] ?? c.notificationStatus, c.notificationStatus)
    : badge('No notification');
}

function complaintItem(c: ComplaintDto, open: (id: number) => void): HTMLElement {
  return h(
    'article',
    {
      class: 'item item--clickable',
      tabindex: '0',
      role: 'button',
      'aria-label': `Open complaint ${c.reference}`,
      onclick: () => open(c.id),
      onkeydown: (e: Event) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') {
          e.preventDefault();
          open(c.id);
        }
      },
    },
    h(
      'div',
      { class: 'item__head' },
      h('strong', null, `${c.firstName} ${c.lastName}`),
      h('div', { class: 'toolbar' }, badge(STATUS_TEXT[c.status], c.status), notificationBadge(c)),
    ),
    h('p', { class: 'item__text' }, c.details.length > 220 ? `${c.details.slice(0, 220)}…` : c.details),
    h(
      'div',
      { class: 'item__meta' },
      ratingStars(c.rating),
      h('span', null, c.reference),
      h('span', null, formatDate(c.createdAt)),
    ),
  );
}

function openDrawer(id: number, onChange: (c: ComplaintDto) => void): void {
  const body = h('div', { class: 'drawer__inner' }, skeletons(3));
  const dialog = h('dialog', { class: 'drawer', 'aria-label': 'Complaint details' }, body);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();

  const render = (c: ComplaintDto) => {
    const statusSelect = h(
      'select',
      { class: 'select', id: 'complaint-status', disabled: !session.can('complaints:update') },
      COMPLAINT_STATUSES.map((s) => h('option', { value: s, selected: s === c.status }, STATUS_TEXT[s])),
    );
    statusSelect.addEventListener('change', async () => {
      try {
        const updated = await adminApi<ComplaintDto>(`/api/admin/complaints/${c.id}`, {
          method: 'PATCH',
          body: { status: statusSelect.value },
        });
        toast(`Marked as ${STATUS_TEXT[updated.status].toLowerCase()}`);
        onChange(updated);
        render(updated);
      } catch (err) {
        toast(err instanceof ApiRequestError ? err.message : 'Could not update status');
        statusSelect.value = c.status;
      }
    });

    const retry =
      c.notificationStatus === 'failed' && session.can('notifications:retry')
        ? h(
            'button',
            {
              class: 'btn btn--sm',
              type: 'button',
              onclick: async () => {
                try {
                  const updated = await adminApi<ComplaintDto>(`/api/admin/complaints/${c.id}/retry-notification`, {
                    method: 'POST',
                  });
                  toast('Notification re-queued');
                  onChange(updated);
                  render(updated);
                } catch (err) {
                  toast(err instanceof ApiRequestError ? err.message : 'Retry failed');
                }
              },
            },
            'Retry email',
          )
        : null;

    const contact = c.piiVisible
      ? [
          h('dt', null, 'Email'),
          h('dd', null, h('a', { href: `mailto:${c.email}` }, c.email)),
          h('dt', null, 'Phone'),
          h('dd', null, h('a', { href: `tel:${c.phone}` }, c.phone)),
        ]
      : [h('dt', null, 'Email'), h('dd', null, c.email), h('dt', null, 'Phone'), h('dd', null, c.phone)];

    replaceChildren(
      body,
      h(
        'div',
        { class: 'drawer__head' },
        h('div', null, h('h2', null, `${c.firstName} ${c.lastName}`), h('p', { class: 'fine-print' }, c.reference)),
        h('button', { class: 'btn btn--sm', type: 'button', onclick: () => dialog.close() }, 'Close'),
      ),
      c.piiVisible
        ? null
        : h('div', { class: 'alert alert--info' }, h('p', null, 'Contact details are masked for your role.')),
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'Received'),
        h('dd', null, formatDate(c.createdAt)),
        h('dt', null, 'Rating'),
        h('dd', null, ratingStars(c.rating)),
        contact,
        h('dt', null, 'Notification'),
        h(
          'dd',
          null,
          notificationBadge(c),
          c.notificationSentAt ? ` ${formatDate(c.notificationSentAt)}` : '',
          c.notificationError ? h('div', { class: 'fine-print' }, c.notificationError) : null,
        ),
      ),
      h('section', null, h('h3', null, 'Complaint'), h('p', { class: 'item__text' }, c.details)),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'complaint-status' }, 'Status'),
        statusSelect,
      ),
      retry,
    );
  };

  adminApi<ComplaintDto>(`/api/admin/complaints/${id}`)
    .then(render)
    .catch((err) => replaceChildren(body, errorState(err)));
}

export function renderComplaints(main: HTMLElement, signal: AbortSignal, openId?: number): void {
  let status = '';
  let cursor: number | null = null;
  const list = h('div', { class: 'list', 'aria-live': 'polite' });
  const more = h('button', { class: 'btn', type: 'button', hidden: true }, 'Load more');
  const items = new Map<number, HTMLElement>();

  const open = (id: number) => {
    history.replaceState(null, '', `#/complaints/${id}`);
    openDrawer(id, (updated) => {
      const el = items.get(updated.id);
      if (el) {
        const next = complaintItem(updated, open);
        el.replaceWith(next);
        items.set(updated.id, next);
      }
    });
  };

  const load = async (append: boolean) => {
    if (!append) {
      replaceChildren(list, skeletons(4));
      items.clear();
    }
    const params = new URLSearchParams({ limit: '25' });
    if (status) params.set('status', status);
    if (append && cursor) params.set('cursor', String(cursor));
    try {
      const page = await adminApi<Page<ComplaintDto>>(`/api/admin/complaints?${params}`, { signal });
      if (!append) list.replaceChildren();
      if (!append && page.items.length === 0) list.append(emptyState('No complaints here. 🎉'));
      for (const c of page.items) {
        const el = complaintItem(c, open);
        items.set(c.id, el);
        list.append(el);
      }
      cursor = page.nextCursor;
      more.hidden = cursor === null;
    } catch (err) {
      if (signal.aborted) return;
      replaceChildren(
        list,
        errorState(err, () => void load(false)),
      );
    }
  };
  more.addEventListener('click', () => void load(true));

  replaceChildren(
    main,
    viewHead(
      'Complaints',
      select(
        'filter-status',
        'Filter by status',
        [['', 'All statuses'], ...COMPLAINT_STATUSES.map((s) => [s, STATUS_TEXT[s]] as [string, string])],
        '',
        (v) => {
          status = v;
          void load(false);
        },
      ),
    ),
    list,
    more,
  );
  void load(false);
  if (openId) open(openId);
}
