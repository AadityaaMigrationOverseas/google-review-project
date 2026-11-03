import { expect, fillReview, GOOGLE_REVIEW_URL, test } from './fixtures';

test.describe('patient review page', () => {
  test('positive review (C++ verdict): auto-copies to clipboard, shows toast, and launches Google Reviews in new tab', async ({
    page,
    context,
  }) => {
    const text = 'Dr. Shah was gentle  and explained everything clearly.\nWonderful visit! 😊 ';
    await page.goto('/review');
    await expect(page.getByRole('heading', { name: 'How was your visit?' })).toBeVisible();

    // Submit button is disabled initially until >= 1 star and >= 5 characters are entered.
    await expect(page.locator('#submit-btn')).toBeDisabled();
    await page.locator('label[for="star-5"]').click();
    await expect(page.locator('#submit-btn')).toBeDisabled();
    await page.locator('#review-text').fill('   ');
    await expect(page.locator('#submit-btn')).toBeDisabled();

    await fillReview(page, 5, text);
    await expect(page.locator('#submit-btn')).toBeEnabled();

    // Wait for debounced /api/sentiment/preview badge to verify positive tone.
    await expect(page.locator('#sentiment-preview-badge')).toBeVisible();
    await expect(page.locator('#sentiment-preview-badge')).toHaveAttribute('data-sentiment', 'POSITIVE');

    const popupPromise = context.waitForEvent('page');
    await page.locator('#submit-btn').click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(GOOGLE_REVIEW_URL);
    await popup.close();

    // Toast and success view are visible, with exact review text copied to clipboard.
    await expect(page.locator('#copy-toast')).toBeVisible();
    await expect(page.locator('#copy-toast')).toContainText('Review copied to clipboard!');
    await expect(page.locator('#success-view')).toBeVisible();
    await expect(page.locator('#escalation-view')).toBeHidden();
    await expect(page.locator('#your-text')).toHaveText(text);
    await expect(page.locator('#your-rating')).toContainText('★★★★★');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

    // Reload: the patient's words are still kept on screen in sessionStorage.
    await page.reload();
    await expect(page.locator('#success-view')).toBeVisible();
    await expect(page.locator('#your-text')).toHaveText(text);

    await page.locator('#new-review').click();
    await expect(page.locator('#review-view')).toBeVisible();
    await expect(page.locator('#review-text')).toHaveValue('');
    await expect(page.locator('#submit-btn')).toBeDisabled();
  });

  test('the patient can decline the Google step on the thank-you screen', async ({ page }) => {
    await page.goto('/review');
    await fillReview(page, 5, 'Lovely, friendly team and a painless cleaning. Excellent care!');
    await page.locator('#submit-btn').click();
    await expect(page.locator('#success-view')).toBeVisible();
    await page.locator('#decline-google').click();
    await expect(page.locator('#next-google')).toBeHidden();
    await expect(page.locator('#declined-note')).toBeVisible();
  });

  test('clipboard refused: shows one-click floating modal ("Click here to copy and continue") and opens Google on click', async ({
    page,
    context,
  }) => {
    const text = 'Excellent, caring dentist and a spotless, calm clinic.';
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
      });
      document.execCommand = () => false;
    });
    await page.goto('/review');
    await fillReview(page, 5, text);
    await page.locator('#submit-btn').click();

    // Floating fallback modal appears immediately when clipboard is blocked.
    await expect(page.locator('#clipboard-modal')).toBeVisible();
    await expect(page.locator('#clipboard-modal-btn')).toHaveText('Click here to copy and continue');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(text);

    const popupPromise = context.waitForEvent('page');
    await page.locator('#clipboard-modal-btn').click();
    const popup = await popupPromise;
    expect(popup.url()).toBe(GOOGLE_REVIEW_URL);
    await popup.close();
    await expect(page.locator('#clipboard-modal')).toBeHidden();
  });

  test('popup blocker: shows inline "Proceed to Google Reviews" button when window.open is blocked', async ({
    page,
  }) => {
    const text = 'Wonderful care and a very gentle cleaning from Dr. Shah.';
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.goto('/review');
    await fillReview(page, 5, text);
    await page.locator('#submit-btn').click();

    await expect(page.locator('#popup-blocked-notice')).toBeVisible();
    await expect(page.locator('#proceed-google-btn')).toHaveText('Proceed to Google Reviews');
    await expect(page.locator('#proceed-google-btn')).toHaveAttribute('href', GOOGLE_REVIEW_URL);
  });

  test('a negative review stays on the contact form and does not open Google', async ({ page, context }) => {
    const text = 'Waited over an hour and the receptionist was rude. Very disappointing.';
    await page.goto('/review');
    await fillReview(page, 1, text);

    let openedGoogle = false;
    context.on('page', () => {
      openedGoogle = true;
    });
    await page.locator('#submit-btn').click();

    expect(new URL(page.url()).pathname).toBe('/review');
    await expect(page.locator('#escalation-view')).toBeVisible();
    await expect(page.locator('#success-view')).toBeHidden();
    expect(openedGoogle).toBe(false);
    await expect(page.locator('#escalation-rating')).toContainText('1 of 5 stars');
    await expect(page.locator('#escalation-review-text')).toHaveValue(text);
    await expect(page.locator('#escalation-review-text')).toHaveAttribute('readonly', '');

    await page.locator('#full-name').fill('Asha Patel');
    await page.locator('#escalation-phone').fill('+91 98765 43210');
    await page.locator('#escalation-email').fill('asha.patel@example.com');
    await page.locator('#escalation-submit-btn').click();
    await expect(page.locator('#escalation-consent-error')).toContainText('confirm');

    await page.locator('#escalation-consent').check();
    await page.locator('#escalation-submit-btn').click();

    expect(new URL(page.url()).pathname).toBe('/review');
    await expect(page.locator('#escalation-confirmation-view')).toBeVisible();
    await expect(page.locator('#escalation-confirmed-message')).toHaveText(
      "Your message has been sent directly to the doctor's management desk. We will contact you within 24–48 hours.",
    );
    await expect(page.locator('#escalation-reference')).toHaveText(/^SDC-[0-9A-Z]{8}$/);
  });

  test('validates minimum character threshold and announces errors', async ({ page }) => {
    await page.goto('/review');
    await expect(page.locator('#submit-btn')).toBeDisabled();

    await page.locator('label[for="star-4"]').click();
    await page.locator('#review-text').fill('tiny');
    await page.locator('#review-text').blur();
    await expect(page.locator('#text-error')).toContainText('5');
    await expect(page.locator('#submit-btn')).toBeDisabled();

    await page.locator('#review-text').fill('Great visit!');
    await expect(page.locator('#text-error')).toBeEmpty();
    await expect(page.locator('#submit-btn')).toBeEnabled();
  });

  test('star rating is keyboard operable', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard navigation is a desktop concern');
    await page.goto('/review');
    await page.locator('#star-1').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#star-3')).toBeChecked();
    await expect(page.locator('#rating-label')).toContainText('Okay');
  });

  test('unknown short links render a friendly 404', async ({ page }) => {
    const res = await page.goto('/r/Nope12345');
    expect(res?.status()).toBe(404);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('a[href="/review"]').first()).toBeVisible();
  });

  test('layout fits the viewport without horizontal scrolling', async ({ page }) => {
    for (const path of ['/review', '/complaint', '/privacy', '/admin']) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
    }
    await page.goto('/review');
    const box = await page.locator('label[for="star-3"]').boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(40);
    expect(box!.height).toBeGreaterThanOrEqual(40);
  });
});
