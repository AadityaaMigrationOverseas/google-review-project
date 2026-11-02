import { createHash } from 'node:crypto';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

export const GOOGLE_REVIEW_URL = 'https://search.google.com/local/writereview?placeid=ChIJfXYa4oPPXzkRD1P8S7a9swU';
export const ADMIN = { email: 'e2e-admin@stellardentalclinic.com', password: 'E2e-Test-Passw0rd!' };

/** A stable pseudo client IP; the E2E server trusts one proxy hop, so per-IP rate limits stay per test. */
export function clientIp(seed: string): string {
  const [a, b] = createHash('sha256').update(seed).digest();
  return `10.200.${a}.${b}`;
}

/** Stand-in for Google Maps review page so redirects are observable without leaving the test sandbox. */
export async function stubGoogle(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/(share\.google|search\.google\.com)\//, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
<html>
  <head><title>Google Maps Review Stub</title></head>
  <body>
    <h1>Stellar Dental Clinic · Google Reviews</h1>
    <button id="write-review-btn" aria-label="Write a review" type="button" onclick="document.getElementById('review-modal').hidden = false">Write a review</button>
    <div id="review-modal" hidden>
      <div role="radiogroup" aria-label="Star rating">
        <button type="button" role="radio" aria-posinset="1" aria-label="1 star">1</button>
        <button type="button" role="radio" aria-posinset="2" aria-label="2 stars">2</button>
        <button type="button" role="radio" aria-posinset="3" aria-label="3 stars">3</button>
        <button type="button" role="radio" aria-posinset="4" aria-label="4 stars">4</button>
        <button type="button" role="radio" aria-posinset="5" aria-label="5 stars">5</button>
      </div>
      <textarea id="google-review-textarea" aria-label="Share details of your own experience at this place" placeholder="Share details of your own experience at this place"></textarea>
      <button id="google-post-btn" type="submit" aria-label="Post" onclick="window.__postClicked = true">Post</button>
    </div>
  </body>
</html>`,
    }),
  );
}

export const test = base.extend({
  extraHTTPHeaders: async ({}, use, testInfo) => {
    await use({ 'X-Forwarded-For': clientIp(`${testInfo.project.name}:${testInfo.testId}`) });
  },
  context: async ({ context, baseURL }, use) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
    await context.grantPermissions(['clipboard-read'], { origin: new URL(GOOGLE_REVIEW_URL).origin });
    await stubGoogle(context);
    await use(context);
  },
});

export { expect };

export async function fillReview(page: Page, rating: number, text: string): Promise<void> {
  await page.locator(`label[for="star-${rating}"]`).click();
  await page.locator('#review-text').fill(text);
  await page.locator('#consent').check();
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/admin');
  await page.locator('#login-email').fill(ADMIN.email);
  await page.locator('#login-password').fill(ADMIN.password);
  await page.locator('#login-btn').click();
  await expect(page.locator('#app-view')).toBeVisible();
}
