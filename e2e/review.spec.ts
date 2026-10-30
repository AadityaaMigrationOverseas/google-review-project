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

  test('negative review transitions in-place (zero page reload) to the internal escalation form and submits to doctor desk', async ({
    page,
  }) => {
    const text = 'Waited over an hour and the receptionist was rude. Very disappointing.';
    await page.goto('/review');
    await fillReview(page, 1, text);
    await page.locator('#submit-btn').click();

    // Zero page reload: stays on /review and swaps to #escalation-view.
    expect(new URL(page.url()).pathname).toBe('/review');
    await expect(page.locator('#review-view')).toBeHidden();
    await expect(page.locator('#escalation-view')).toBeVisible();
    await expect(page.locator('#escalation-header')).toContainText(
      'Thank you for your feedback. We take patient satisfaction seriously.',
    );

    // Locked read-only preview accordion contains the submitted rating and review text.
    await expect(page.locator('#review-preview-accordion')).toBeVisible();
    await expect(page.locator('#escalation-rating')).toContainText('1 of 5 stars');
    await expect(page.locator('#escalation-review-text')).toHaveValue(text);
    await expect(page.locator('#escalation-review-text')).toHaveAttribute('readonly', '');

    // Fill and submit the internal escalation form without leaving the page.
    await page.locator('#full-name').fill('Asha Patel');
    await page.locator('#escalation-phone').fill('+91 98765 43210');
    await page.locator('#escalation-email').fill('asha.patel@example.com');
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

  test('semi-automated DOM handoff: clicks "Write a review", populates exact review text, and NEVER clicks Post/Publish', async ({
    page,
  }) => {
    const text = 'Dr. Shah and her team were super gentle and thorough!';
    await page.goto('/review');

    // Intercept window.open with an accessible same-origin iframe simulating the Google Maps "Write a review" flow.
    await page.evaluate(() => {
      const iframe = document.createElement('iframe');
      iframe.id = 'google-sim-frame';
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument!;
      doc.open();
      doc.write(`<!doctype html>
        <html>
          <body>
            <button id="write-btn" type="button" aria-label="Write a review">Write a review</button>
            <div id="composer" hidden>
              <button id="star-5-btn" type="button" role="radio" aria-posinset="5" aria-label="5 stars">5</button>
              <textarea id="review-box" aria-label="Share details of your own experience at this place"></textarea>
              <button id="post-btn" type="submit" aria-label="Post">Post</button>
            </div>
          </body>
        </html>`);
      doc.close();

      const w = window as unknown as Record<string, unknown>;
      w.__simState = { writeClicked: false, star5Clicked: false, postClicked: false };

      doc.getElementById('write-btn')!.addEventListener('click', () => {
        (w.__simState as Record<string, boolean>).writeClicked = true;
        doc.getElementById('composer')!.hidden = false;
      });
      doc.getElementById('star-5-btn')!.addEventListener('click', () => {
        (w.__simState as Record<string, boolean>).star5Clicked = true;
      });
      doc.getElementById('post-btn')!.addEventListener('click', () => {
        (w.__simState as Record<string, boolean>).postClicked = true;
      });

      window.open = () => iframe.contentWindow;
    });

    await fillReview(page, 5, text);
    await page.locator('#submit-btn').click();

    await expect(page.locator('#copy-toast')).toBeVisible();
    await expect(page.locator('#copy-toast')).toContainText('Review prefilled on Google');

    const sim = await page.evaluate(() => {
      const iframe = document.getElementById('google-sim-frame') as HTMLIFrameElement;
      const doc = iframe.contentDocument!;
      const populatedValue = (doc.getElementById('review-box') as HTMLTextAreaElement).value;
      const state = (
        window as unknown as {
          __simState: { writeClicked: boolean; star5Clicked: boolean; postClicked: boolean };
        }
      ).__simState;
      return {
        writeClicked: state.writeClicked,
        star5Clicked: state.star5Clicked,
        postClicked: state.postClicked,
        populatedValue,
      };
    });

    expect(sim.writeClicked).toBe(true);
    expect(sim.star5Clicked).toBe(true);
    expect(sim.populatedValue).toBe(text);
    expect(sim.postClicked).toBe(false);
  });

  test('semi-automated DOM handoff halts immediately on authentication or CAPTCHA gates without modifying fields', async ({
    page,
  }) => {
    await page.goto('/review');

    await page.evaluate(() => {
      const iframe = document.createElement('iframe');
      iframe.id = 'google-auth-frame';
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument!;
      doc.open();
      doc.write(`<!doctype html>
        <html>
          <body>
            <h1>Sign in to Google</h1>
            <input id="passwd" type="password" />
            <textarea id="should-not-touch" aria-label="Write a review"></textarea>
          </body>
        </html>`);
      doc.close();
      window.open = () => iframe.contentWindow;
    });

    await fillReview(page, 5, 'Wonderful care and friendly dentist!');
    await page.locator('#submit-btn').click();

    await expect(page.locator('#copy-toast')).toBeVisible();
    // Because an auth gate was detected, DOM automation aborted cleanly and fell back to clipboard copy.
    await expect(page.locator('#copy-toast')).toContainText('Review copied to clipboard!');
    const untouched = await page.evaluate(() => {
      const iframe = document.getElementById('google-auth-frame') as HTMLIFrameElement;
      return (iframe.contentDocument!.getElementById('should-not-touch') as HTMLTextAreaElement).value;
    });
    expect(untouched).toBe('');
  });
});
