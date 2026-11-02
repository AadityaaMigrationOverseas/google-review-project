import { describe, expect, it } from 'vitest';
import { classifyReviewStatus, nextStepFor } from '../src/routing.js';

describe('nextStepFor', () => {
  it('always sends every patient to Google with equal prominence (no review gating)', () => {
    expect(nextStepFor()).toBe('google');
  });
});

describe('classifyReviewStatus (internal reporting / staff flags only)', () => {
  it('is POSITIVE only when the C++ verdict is positive and the stars agree', () => {
    expect(classifyReviewStatus(5, 'positive')).toBe('POSITIVE');
    expect(classifyReviewStatus(4, 'positive')).toBe('POSITIVE');
    expect(classifyReviewStatus(3, 'positive')).toBe('NEGATIVE');
    expect(classifyReviewStatus(5, 'negative')).toBe('NEGATIVE');
    expect(classifyReviewStatus(5, 'neutral')).toBe('NEGATIVE');
    expect(classifyReviewStatus(5, 'uncertain')).toBe('NEGATIVE');
    expect(classifyReviewStatus(1, 'negative')).toBe('NEGATIVE');
  });

  it('falls back to the star rating when the engine gave no verdict', () => {
    expect(classifyReviewStatus(4, null)).toBe('POSITIVE');
    expect(classifyReviewStatus(3, null)).toBe('NEGATIVE');
  });
});
