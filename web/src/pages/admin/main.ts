import '../../styles/main.css';
import '../../styles/admin.css';
import type { Permission, SessionDto } from '@stellar/shared';
import { setBusy, showAlert } from '../../components/form';
import { api, ApiRequestError } from '../../lib/api';
import { byId } from '../../lib/dom';
import { adminApi, session } from './session';
import { renderComplaints } from './views/complaints';
import { renderLinks } from './views/links';
import { renderOverview } from './views/overview';
import { renderReviews } from './views/reviews';
import { renderUsers } from './views/users';

const ROLE_LABEL: Record<string, string> = { admin: 'Administrator', manager: 'Manager', staff: 'Front desk' };

const main = byId('main');
let controller = new AbortController();

type View = (main: HTMLElement, signal: AbortSignal, id?: number) => void | Promise<void>;
const ROUTES: Record<string, { view: View; permission: Permission }> = {
  overview: { view: renderOverview, permission: 'reviews:read' },
  reviews: { view: renderReviews, permission: 'reviews:read' },
  complaints: { view: renderComplaints, permission: 'complaints:read' },
  links: { view: renderLinks, permission: 'links:read' },
  users: { view: renderUsers, permission: 'users:manage' },
};

function route(): void {
  const [, name = 'overview', id] = location.hash.split('/');
  const target = ROUTES[name] && session.can(ROUTES[name].permission) ? name : 'overview';
  controller.abort();
  controller = new AbortController();
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.admin-nav a')) {
    if (a.dataset.route === target) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${target[0]!.toUpperCase()}${target.slice(1)} · Staff dashboard`;
  void ROUTES[target]!.view(main, controller.signal, id ? Number(id) : undefined);
}

function showApp(s: SessionDto): void {
  session.set(s);
  byId('boot').hidden = true;
  byId('login-view').hidden = true;
  byId('app-view').hidden = false;
  byId('user-name').textContent = s.user.name;
  byId('user-role').textContent = ROLE_LABEL[s.user.role] ?? s.user.role;
  for (const a of document.querySelectorAll<HTMLElement>('[data-permission]')) {
    a.hidden = !session.can(a.dataset.permission as Permission);
  }
  route();
}

function showLogin(message?: string): void {
  controller.abort();
  session.set(null);
  byId('boot').hidden = true;
  byId('app-view').hidden = true;
  byId('login-view').hidden = false;
  main.replaceChildren();
  showAlert(byId('login-alert'), 'warning', message ?? null);
  byId<HTMLInputElement>('login-email').focus();
}

byId<HTMLFormElement>('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = byId<HTMLButtonElement>('login-btn');
  const alertEl = byId('login-alert');
  showAlert(alertEl, 'error', null);
  setBusy(btn, true, 'Signing in…');
  try {
    const s = await api<SessionDto>('/api/auth/login', {
      method: 'POST',
      body: {
        email: byId<HTMLInputElement>('login-email').value,
        password: byId<HTMLInputElement>('login-password').value,
      },
    });
    byId<HTMLInputElement>('login-password').value = '';
    showApp(s);
  } catch (err) {
    showAlert(alertEl, 'error', err instanceof ApiRequestError ? err.message : 'Sign-in failed.');
  } finally {
    setBusy(btn, false);
  }
});

byId('logout-btn').addEventListener('click', async () => {
  try {
    await adminApi('/api/auth/logout', { method: 'POST' });
  } finally {
    showLogin();
  }
});

session.onExpired(() => showLogin('Your session has ended. Please sign in again.'));
window.addEventListener('hashchange', () => {
  if (session.get()) route();
});

api<SessionDto>('/api/auth/session')
  .then(showApp)
  .catch(() => showLogin());
