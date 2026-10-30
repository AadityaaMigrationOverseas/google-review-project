import '../styles/main.css';
import {
  LIMITS,
  normalizeText,
  validateComplaintDetails,
  validateEmail,
  validateName,
  validatePhone,
  validateRating,
  type SubmitComplaintRequest,
  type SubmitComplaintResponse,
} from '@stellar/shared';
import { bindCounter, FormController, newIdempotencyKey, setBusy, showAlert } from '../components/form';
import { mountStarRating } from '../components/starRating';
import { api, ApiRequestError } from '../lib/api';
import { takeComplaintPrefill } from '../lib/complaintPrefill';
import { byId } from '../lib/dom';
import { fetchFormToken, isTokenError, type FormTokenInfo } from '../lib/formToken';

const form = byId<HTMLFormElement>('complaint-form');
const firstName = byId<HTMLInputElement>('first-name');
const lastName = byId<HTMLInputElement>('last-name');
const email = byId<HTMLInputElement>('email');
const phone = byId<HTMLInputElement>('phone');
const details = byId<HTMLTextAreaElement>('details');
const consent = byId<HTMLInputElement>('consent');
const submitBtn = byId<HTMLButtonElement>('submit-btn');
const formAlert = byId('form-alert');
const starsRoot = form.querySelector<HTMLElement>('[data-stars]')!;

const stars = mountStarRating(starsRoot, () => controller.check('rating'));
bindCounter(details, byId('details-count'), LIMITS.complaintDetailsMax);

const controller = new FormController(form, {
  firstName: { control: firstName, validate: () => validateName(normalizeText(firstName.value), 'first name') },
  lastName: { control: lastName, validate: () => validateName(normalizeText(lastName.value), 'surname') },
  email: { control: email, validate: () => validateEmail(email.value.trim().toLowerCase()) },
  phone: { control: phone, validate: () => validatePhone(phone.value) },
  rating: {
    control: starsRoot,
    sources: [...starsRoot.querySelectorAll<HTMLInputElement>('input')],
    validate: () => validateRating(stars.value),
    focus: () => stars.focus(),
  },
  details: { control: details, validate: () => validateComplaintDetails(normalizeText(details.value)) },
  consent: {
    control: consent,
    validate: () => (consent.checked ? null : 'Please confirm we may store your complaint and contact you.'),
  },
});

const prefill = takeComplaintPrefill();
if (prefill) {
  const star = starsRoot.querySelector<HTMLInputElement>(`input[value="${prefill.rating}"]`);
  if (star) {
    star.checked = true;
    star.dispatchEvent(new Event('change', { bubbles: true }));
  }
  details.value = prefill.details;
  details.dispatchEvent(new Event('input', { bubbles: true }));
}

// One key per filled-in form: retries after a dropped connection are recognised server-side.
const idempotencyKey = newIdempotencyKey();
let token: Promise<FormTokenInfo> = fetchFormToken('complaint');
token.catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showAlert(formAlert, 'error', null);
  if (!controller.validateAll()) return;

  setBusy(submitBtn, true, 'Sending securely…');
  try {
    let info: FormTokenInfo;
    try {
      info = await token;
    } catch {
      token = fetchFormToken('complaint');
      info = await token;
    }
    const payload: SubmitComplaintRequest = {
      firstName: firstName.value,
      lastName: lastName.value,
      email: email.value,
      phone: phone.value,
      rating: stars.value!,
      details: details.value,
      consent: consent.checked,
      idempotencyKey,
      formToken: info.formToken,
      website: byId<HTMLInputElement>('website').value,
    };
    const result = await api<SubmitComplaintResponse>('/api/public/complaints', { method: 'POST', body: payload });
    byId('reference').textContent = result.reference;
    byId('complaint-view').hidden = true;
    const success = byId('success-view');
    success.hidden = false;
    success.focus();
    success.scrollIntoView({ block: 'start', behavior: 'smooth' });
    document.title = 'Message received · Stellar Dental Clinic';
  } catch (err) {
    if (isTokenError(err)) {
      token = fetchFormToken('complaint');
      showAlert(formAlert, 'warning', `${err.message.split('.')[0]}. We've refreshed it — please press Send again.`);
    } else if (err instanceof ApiRequestError) {
      if (err.code === 'validation_failed') controller.applyServerErrors(err.fields);
      showAlert(formAlert, err.status === 425 ? 'info' : 'error', err.message);
    } else {
      showAlert(formAlert, 'error', 'Something went wrong. Please try again.');
    }
  } finally {
    setBusy(submitBtn, false);
  }
});
