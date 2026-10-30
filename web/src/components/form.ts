import { debounce, h, replaceChildren } from '../lib/dom';

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export interface FieldSpec {
  /** Element that receives aria-invalid and focus. */
  control: Control | HTMLElement;
  /** Inputs whose events trigger validation (defaults to `control`). */
  sources?: Array<Control>;
  validate(): string | null;
  focus?(): void;
}

/**
 * Real-time validation: a field is validated on blur, then re-validated as the
 * user types (debounced) so errors clear as soon as they are fixed.
 */
export class FormController<K extends string> {
  private readonly touched = new Set<K>();

  constructor(
    private readonly form: HTMLFormElement,
    private readonly fields: Record<K, FieldSpec>,
  ) {
    for (const [name, spec] of Object.entries(fields) as Array<[K, FieldSpec]>) {
      const sources = spec.sources ?? [spec.control as Control];
      const live = debounce(() => this.check(name), 220);
      for (const src of sources) {
        src.addEventListener('blur', () => {
          this.touched.add(name);
          this.check(name);
        });
        src.addEventListener('input', () => {
          if (this.touched.has(name)) live();
        });
        src.addEventListener('change', () => {
          this.touched.add(name);
          this.check(name);
        });
      }
    }
  }

  check(name: K): boolean {
    const message = this.fields[name].validate();
    this.setError(name, message);
    return message === null;
  }

  /** Validates every field; focuses the first invalid one. */
  validateAll(): boolean {
    let first: K | null = null;
    for (const name of Object.keys(this.fields) as K[]) {
      this.touched.add(name);
      if (!this.check(name) && first === null) first = name;
    }
    if (first !== null) this.focus(first);
    return first === null;
  }

  applyServerErrors(errors: Record<string, string>): void {
    let first: K | null = null;
    for (const [name, message] of Object.entries(errors)) {
      if (!(name in this.fields)) continue;
      this.setError(name as K, message);
      first ??= name as K;
    }
    if (first !== null) this.focus(first);
  }

  setError(name: K, message: string | null): void {
    const spec = this.fields[name];
    const errorEl = this.form.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
    if (errorEl) errorEl.textContent = message ?? '';
    if (message) spec.control.setAttribute('aria-invalid', 'true');
    else spec.control.removeAttribute('aria-invalid');
  }

  private focus(name: K): void {
    const spec = this.fields[name];
    if (spec.focus) spec.focus();
    else spec.control.focus();
  }
}

export function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel?: string): void {
  const label = button.querySelector<HTMLElement>('.btn__label');
  if (busy) {
    button.dataset.idleLabel ??= label?.textContent ?? '';
    if (label && busyLabel) label.textContent = busyLabel;
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
  } else {
    if (label && button.dataset.idleLabel !== undefined) label.textContent = button.dataset.idleLabel;
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

export function showAlert(container: HTMLElement, kind: 'error' | 'warning' | 'info', message: string | null): void {
  if (!message) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.className = `alert alert--${kind}`;
  replaceChildren(container, h('p', null, message));
  container.hidden = false;
}

/** Live "123 / 2000" counter using code points (matches server-side length rules). */
export function bindCounter(textarea: HTMLTextAreaElement, counter: HTMLElement, max: number): () => void {
  const update = () => {
    const len = [...textarea.value].length;
    counter.textContent = `${len} / ${max}`;
    counter.dataset.state = len > max ? 'over' : 'ok';
  };
  textarea.addEventListener('input', update);
  update();
  return update;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
