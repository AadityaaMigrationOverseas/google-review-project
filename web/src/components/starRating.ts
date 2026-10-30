import { RATING_LABELS } from '@stellar/shared';

export interface StarRating {
  readonly value: number | null;
  focus(): void;
  setInvalid(invalid: boolean): void;
  reset(): void;
}

/**
 * Enhances the native radio group from `partials/stars.html`: adds hover
 * preview and a live caption. Keyboard and screen-reader behaviour come from
 * the radios themselves.
 */
export function mountStarRating(root: HTMLElement, onChange: (value: number) => void): StarRating {
  const group = root.querySelector<HTMLElement>('[data-stars-group]')!;
  const caption = root.querySelector<HTMLElement>('.stars__caption')!;
  const inputs = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  const defaultCaption = caption.textContent ?? '';
  let value: number | null = null;

  const showCaption = (n: number | null) => {
    caption.textContent = n ? `${n} of 5 · ${RATING_LABELS[n]}` : defaultCaption;
  };

  for (const input of inputs) {
    const n = Number(input.value);
    input.addEventListener('change', () => {
      value = n;
      group.dataset.value = String(n);
      showCaption(n);
      onChange(n);
    });
    const label = root.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)!;
    label.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      group.dataset.preview = String(n);
      showCaption(n);
    });
  }
  group.addEventListener('pointerleave', () => {
    delete group.dataset.preview;
    showCaption(value);
  });

  return {
    get value() {
      return value;
    },
    focus() {
      (inputs.find((i) => i.checked) ?? inputs[0])?.focus();
    },
    setInvalid(invalid) {
      if (invalid) root.setAttribute('aria-invalid', 'true');
      else root.removeAttribute('aria-invalid');
    },
    reset() {
      value = null;
      for (const i of inputs) i.checked = false;
      delete group.dataset.value;
      showCaption(null);
    },
  };
}
