import { ROLES, type Role, type StaffUserDto } from '@stellar/shared';
import { ApiRequestError } from '../../../lib/api';
import { h, replaceChildren } from '../../../lib/dom';
import { adminApi, session } from '../session';
import { badge, emptyState, errorState, formatDate, skeletons, toast, viewHead } from '../ui';

const ROLE_TEXT: Record<Role, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  staff: 'Front desk',
};

function userItem(u: StaffUserDto, onUpdate: (u: StaffUserDto) => void): HTMLElement {
  const self = session.get()?.user.id === u.id;
  const patch = async (body: Record<string, unknown>) => {
    try {
      const updated = await adminApi<StaffUserDto>(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
      toast('Staff account updated');
      onUpdate(updated);
    } catch (err) {
      toast(err instanceof ApiRequestError ? err.message : 'Update failed');
      onUpdate(u);
    }
  };
  const role = h(
    'select',
    { class: 'select', 'aria-label': `Role for ${u.name}`, disabled: self },
    ROLES.map((r) => h('option', { value: r, selected: r === u.role }, ROLE_TEXT[r])),
  );
  role.addEventListener('change', () => void patch({ role: role.value }));

  return h(
    'article',
    { class: `item${u.disabled ? ' item--disabled' : ''}` },
    h(
      'div',
      { class: 'item__head' },
      h('strong', null, u.name, self ? ' (you)' : ''),
      h('div', { class: 'toolbar' }, u.disabled ? badge('Disabled', 'failed') : badge('Active', 'sent')),
    ),
    h(
      'div',
      { class: 'item__meta' },
      h('span', null, u.email),
      h('span', null, `Last sign-in ${formatDate(u.lastLoginAt)}`),
    ),
    h(
      'div',
      { class: 'item__actions' },
      role,
      self
        ? null
        : h(
            'button',
            {
              class: `btn btn--sm${u.disabled ? '' : ' btn--danger'}`,
              type: 'button',
              onclick: () => void patch({ disabled: !u.disabled }),
            },
            u.disabled ? 'Enable' : 'Disable',
          ),
    ),
  );
}

export function renderUsers(main: HTMLElement, signal: AbortSignal): void {
  const list = h('div', { class: 'list' }, skeletons(2));
  const items = new Map<number, HTMLElement>();
  const place = (u: StaffUserDto, prepend = false) => {
    const el = userItem(u, (next) => place(next));
    const existing = items.get(u.id);
    if (existing) existing.replaceWith(el);
    else if (prepend) list.prepend(el);
    else list.append(el);
    items.set(u.id, el);
  };

  const name = h('input', { class: 'input', id: 'user-name-input', autocomplete: 'off' });
  const email = h('input', { class: 'input', id: 'user-email', type: 'email', autocomplete: 'off' });
  const password = h('input', {
    class: 'input',
    id: 'user-password',
    type: 'password',
    autocomplete: 'new-password',
    minlength: '12',
  });
  const role = h(
    'select',
    { class: 'select', id: 'user-role-input' },
    ROLES.map((r) => h('option', { value: r, selected: r === 'staff' }, ROLE_TEXT[r])),
  );
  const submit = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Add staff');
  const error = h('p', { class: 'field__error', role: 'alert' });
  const field = (id: string, label: string, control: HTMLElement) =>
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), control);

  const form = h(
    'form',
    {
      class: 'panel',
      novalidate: true,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          const user = await adminApi<StaffUserDto>('/api/admin/users', {
            method: 'POST',
            body: { name: name.value, email: email.value, password: password.value, role: role.value },
          });
          name.value = email.value = password.value = '';
          place(user, true);
          toast('Staff account created');
        } catch (err) {
          error.textContent =
            err instanceof ApiRequestError
              ? Object.values(err.fields).join(' ') || err.message
              : 'Could not create account';
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('h2', null, 'Add a staff account'),
    h(
      'p',
      { class: 'fine-print' },
      'Front desk: links and reviews, masked complaint contacts. Manager: full complaint access. Administrator: everything, including staff accounts.',
    ),
    h(
      'div',
      { class: 'inline-form inline-form--users' },
      field('user-name-input', 'Name', name),
      field('user-email', 'Email', email),
      field('user-password', 'Temporary password', password),
      field('user-role-input', 'Role', role),
      submit,
    ),
    error,
  );

  replaceChildren(main, viewHead('Staff accounts'), form, list);
  adminApi<{ items: StaffUserDto[] }>('/api/admin/users', { signal })
    .then(({ items: users }) => {
      list.replaceChildren();
      if (users.length === 0) list.append(emptyState('No staff accounts.'));
      for (const u of users) place(u);
    })
    .catch((err) => {
      if (!signal.aborted) replaceChildren(list, errorState(err));
    });
}
