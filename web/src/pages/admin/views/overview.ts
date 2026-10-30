import type { StatsDto } from '@stellar/shared';
import { h, replaceChildren } from '../../../lib/dom';
import { adminApi } from '../session';
import { errorState, skeletons, viewHead } from '../ui';

function stat(label: string, value: string, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('span', { class: 'stat__label' }, label),
    h('span', { class: 'stat__value' }, value),
    hint ? h('span', { class: 'stat__hint' }, hint) : null,
  );
}

function bars(rows: Array<[string, number, string]>): HTMLElement {
  const max = Math.max(1, ...rows.map(([, n]) => n));
  return h(
    'div',
    { class: 'bars' },
    rows.map(([label, n, variant]) => {
      const fill = h('div', { class: `bar__fill bar__fill--${variant}` });
      fill.style.width = `${(n / max) * 100}%`;
      return h(
        'div',
        { class: 'bar' },
        h('span', null, label),
        h('div', { class: 'bar__track', role: 'presentation' }, fill),
        h('span', { class: 'bar__n' }, String(n)),
      );
    }),
  );
}

export async function renderOverview(main: HTMLElement, signal: AbortSignal): Promise<void> {
  const statsGrid = h('div', { class: 'stats' }, skeletons(6, 'stat'));
  const charts = h('div', { class: 'grid-2' }, skeletons(2));
  replaceChildren(main, viewHead('Overview'), statsGrid, charts);

  try {
    const s = await adminApi<StatsDto>('/api/admin/stats', { signal });
    const engine = s.sentimentEngine;
    replaceChildren(
      statsGrid,
      stat('Reviews', String(s.reviews.total), `${s.reviews.last7Days} in the last 7 days`),
      stat('Average rating', s.reviews.averageRating === null ? '—' : `${s.reviews.averageRating.toFixed(2)} ★`),
      stat('Open complaints', String(s.complaints.open), `${s.complaints.inProgress} in progress`),
      stat('Resolved complaints', String(s.complaints.resolved)),
      stat(
        'Email notifications',
        String(s.notifications.sent),
        s.notifications.failed
          ? `${s.notifications.failed} failed · ${s.notifications.pending} pending`
          : `${s.notifications.pending} pending`,
      ),
      stat(
        'Sentiment engine',
        engine.ready ? 'Online' : 'Offline',
        engine.p50Ms === null
          ? `${engine.workers} worker(s)`
          : `p50 ${engine.p50Ms.toFixed(0)} ms · p95 ${engine.p95Ms!.toFixed(0)} ms`,
      ),
    );
    const b = s.reviews.bySentiment;
    replaceChildren(
      charts,
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'sentiment-title' },
        h('h2', { id: 'sentiment-title' }, 'Sentiment (C++ DistilBERT model)'),
        bars([
          ['Positive', b.positive, 'positive'],
          ['Neutral', b.neutral, 'neutral'],
          ['Negative', b.negative, 'negative'],
          ['Uncertain', b.uncertain, 'uncertain'],
          ['Unanalysed', b.unanalyzed, 'unanalyzed'],
        ]),
      ),
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'ratings-title' },
        h('h2', { id: 'ratings-title' }, 'Star ratings'),
        bars([5, 4, 3, 2, 1].map((r) => [`${r} ★`, s.reviews.byRating[r] ?? 0, 'rating'])),
      ),
    );
  } catch (err) {
    if (signal.aborted) return;
    replaceChildren(
      statsGrid,
      errorState(err, () => void renderOverview(main, signal)),
    );
    charts.replaceChildren();
  }
}
