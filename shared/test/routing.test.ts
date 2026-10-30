import { describe, expect, it } from 'vitest';
import { classifyReviewStatus, nextStepFor } from '../src/routing.js';

describe('nextStepFor & classifyReviewStatus', () => {
  it('leads to Google (POSITIVE) only when the C++ verdict is positive and the stars agree', () => {
    expect(nextStepFor(5, 'positive')).toBe('google');
    expect(classifyReviewStatus(5, 'positive')).toBe('POSITIVE');
    expect(nextStepFor(4, 'positive')).toBe('google');
    expect(classifyReviewStatus(4, 'positive')).toBe('POSITIVE');
    expect(nextStepFor(3, 'positive')).toBe('complaint');
    expect(classifyReviewStatus(3, 'positive')).toBe('NEGATIVE');
    expect(nextStepFor(5, 'negative')).toBe('complaint');
    expect(classifyReviewStatus(5, 'negative')).toBe('NEGATIVE');
    expect(nextStepFor(5, 'neutral')).toBe('complaint');
    expect(classifyReviewStatus(5, 'neutral')).toBe('NEGATIVE');
    expect(nextStepFor(5, 'uncertain')).toBe('complaint');
    expect(classifyReviewStatus(5, 'uncertain')).toBe('NEGATIVE');
    expect(nextStepFor(1, 'negative')).toBe('complaint');
    expect(classifyReviewStatus(1, 'negative')).toBe('NEGATIVE');
  });

  it('falls back to the star rating when the engine gave no verdict', () => {
    expect(nextStepFor(4, null)).toBe('google');
    expect(classifyReviewStatus(4, null)).toBe('POSITIVE');
    expect(nextStepFor(3, null)).toBe('complaint');
    expect(classifyReviewStatus(3, null)).toBe('NEGATIVE');
  });
});
