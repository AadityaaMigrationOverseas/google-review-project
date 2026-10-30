import { describe, expect, it } from 'vitest';
import {
  isValidShortCode,
  normalizePhone,
  normalizeText,
  validateComplaintInput,
  validateEmail,
  validatePhone,
  validateReviewInput,
} from '../src/index.js';

describe('normalizeText', () => {
  it('trims, unifies newlines and strips control / bidi characters', () => {
    expect(normalizeText('  hi\r\nthere\u0000\u202E  ')).toBe('hi\nthere');
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('validateReviewInput', () => {
  const ok = { rating: 4, text: 'Very gentle cleaning, thank you!', consent: true };

  it('accepts a valid review', () => {
    const r = validateReviewInput(ok);
    expect(r).toEqual({ ok: true, value: { ...ok, linkCode: null } });
  });

  it.each([0, 6, 3.5, '5', null])('rejects rating %s', (rating) => {
    const r = validateReviewInput({ ...ok, rating });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.rating).toBeDefined();
  });

  it('enforces text length in code points', () => {
    expect(validateReviewInput({ ...ok, text: 'tiny' }).ok).toBe(false);
    expect(validateReviewInput({ ...ok, text: 'five!' }).ok).toBe(true);
    expect(validateReviewInput({ ...ok, text: 'x'.repeat(2001) }).ok).toBe(false);
    // 2000 emoji = 4000 UTF-16 units but 2000 characters: allowed.
    expect(validateReviewInput({ ...ok, text: '😀'.repeat(2000) }).ok).toBe(true);
  });

  it('requires explicit consent', () => {
    const r = validateReviewInput({ ...ok, consent: 'yes' });
    expect(r.ok).toBe(false);
  });

  it('validates optional link codes', () => {
    expect(validateReviewInput({ ...ok, linkCode: 'Ab3dE9x' }).ok).toBe(true);
    expect(validateReviewInput({ ...ok, linkCode: '../etc' }).ok).toBe(false);
  });

  it('rejects non-object payloads', () => {
    expect(validateReviewInput('nope').ok).toBe(false);
    expect(validateReviewInput([1, 2]).ok).toBe(false);
  });
});

describe('validateComplaintInput', () => {
  const ok = {
    firstName: 'Zoë',
    lastName: "O'Neil-Smith",
    email: ' Zoe@Example.COM ',
    phone: '+91 (987) 654-3210',
    rating: 1,
    details: 'The receptionist was rude to my elderly mother on Monday.',
    consent: true,
  };

  it('accepts and normalises a valid complaint', () => {
    const r = validateComplaintInput(ok);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.email).toBe('zoe@example.com');
      expect(r.value.phone).toBe('+919876543210');
      expect(r.value.firstName).toBe('Zoë');
    }
  });

  it('reports every invalid field at once', () => {
    const r = validateComplaintInput({ firstName: '<script>', email: 'x', phone: 'abc', rating: 9 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(
        ['consent', 'details', 'email', 'firstName', 'lastName', 'phone', 'rating'].sort(),
      );
    }
  });
});

describe('field helpers', () => {
  it('validates emails', () => {
    expect(validateEmail('dhruvi@stellardentalclinic.com')).toBeNull();
    expect(validateEmail('a@b')).not.toBeNull();
    expect(validateEmail('a b@c.com')).not.toBeNull();
    expect(validateEmail('x@y.com\r\nBcc: evil@z.com')).not.toBeNull();
  });

  it('validates phones', () => {
    expect(validatePhone('98765 43210')).toBeNull();
    expect(validatePhone('12')).not.toBeNull();
    expect(validatePhone('call me')).not.toBeNull();
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('validates short codes', () => {
    expect(isValidShortCode('aB3dE9x')).toBe(true);
    expect(isValidShortCode('abc')).toBe(false);
    expect(isValidShortCode("abc' OR 1=1")).toBe(false);
  });
});
