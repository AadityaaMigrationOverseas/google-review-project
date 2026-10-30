import type { Page, ReviewDto } from '@stellar/shared';
import { h, replaceChildren } from '../../../lib/dom';
import { adminApi } from '../session';
import { badge, emptyState, errorState, formatDate, ratingStars, select, skeletons, viewHead } from '../ui';

const SENTIMENT_TEXT: Record<string, string> = {
  positive: 'Positive',
  negative: 'Negative',
  neutral: 'Neutral',
  uncertain: 'Uncertain',
};

function reviewItem(r: ReviewDto): HTMLElement {
  const sentiment =
    r.sentimentStatus === 'analyzed' && r.sentiment
      ? badge(`${SENTIMENT_TEXT[r.sentiment]} · ${Math.round((r.sentimentConfidence ?? 0) * 100)}%`, r.sentiment)
      : badge(
          r.sentimentStatus === 'failed'
            ? 'Analysis failed (will retry)'
            : r.sentimentStatus === 'pending'
              ? 'Analysing…'
              : 'Not analysed',
          r.sentimentStatus,
        );
  return h(
    'article',
    { class: 'item' },
    h(
      'div',
      { class: 'item__head' },
      ratingStars(r.rating),
      h('div', { class: 'toolbar' }, sentiment, r.mismatch ? badge('Rating/text mismatch', 'mismatch') : null),
    ),
    h('p', { class: 'item__text' }, r.text),
    h(
      'div',
      { class: 'item__meta' },
      h('span', null, formatDate(r.createdAt)),
      h('span', null, r.linkLabel ? `Via ${r.linkLabel}` : 'Direct'),
      r.sentimentLatencyMs !== null ? h('span', null, `Analysed in ${r.sentimentLatencyMs.toFixed(0)} ms`) : null,
      h('span', null, `#${r.id}`),
    ),
  );
}

export function renderReviews(main: HTMLElement, signal: AbortSignal): void {
  const filters = { sentiment: '', rating: '' };
  const list = h('div', { class: 'list', 'aria-live': 'polite' });
  const more = h('button', { class: 'btn', type: 'button', hidden: true }, 'Load more');
  let cursor: number | null = null;

  const load = async (append: boolean) => {
    if (!append) replaceChildren(list, skeletons(4));
    more.setAttribute('aria-busy', 'true');
    const params = new URLSearchParams({ limit: '25' });
    if (filters.sentiment) params.set('sentiment', filters.sentiment);
    if (filters.rating) params.set('rating', filters.rating);
    if (append && cursor) params.set('cursor', String(cursor));
    try {
      const page = await adminApi<Page<ReviewDto>>(`/api/admin/reviews?${params}`, { signal });
      if (!append) list.replaceChildren();
      if (!append && page.items.length === 0) list.append(emptyState('No reviews match these filters yet.'));
      list.append(...page.items.map(reviewItem));
      cursor = page.nextCursor;
      more.hidden = cursor === null;
    } catch (err) {
      if (signal.aborted) return;
      replaceChildren(
        list,
        errorState(err, () => void load(false)),
      );
    } finally {
      more.removeAttribute('aria-busy');
    }
  };
  more.addEventListener('click', () => void load(true));

  replaceChildren(
    main,
    viewHead(
      'Reviews',
      select(
        'filter-sentiment',
        'Filter by sentiment',
        [
          ['', 'All sentiment'],
          ['positive', 'Positive'],
          ['neutral', 'Neutral'],
          ['negative', 'Negative'],
          ['uncertain', 'Uncertain'],
          ['unanalyzed', 'Not analysed'],
        ],
        '',
        (v) => {
          filters.sentiment = v;
          void load(false);
        },
      ),
      select(
        'filter-rating',
        'Filter by rating',
        [['', 'All ratings'], ...([5, 4, 3, 2, 1].map((n) => [String(n), `${n} stars`]) as Array<[string, string]>)],
        '',
        (v) => {
          filters.rating = v;
          void load(false);
        },
      ),
    ),
    h(
      'p',
      { class: 'fine-print' },
      'Sentiment comes from the clinic’s C++ model and is for internal insight only. It never changes what patients see.',
    ),
    list,
    more,
  );
  void load(false);
}
