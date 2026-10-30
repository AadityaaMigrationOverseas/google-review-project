import { clientIp, expect, fillReview, signIn, test } from './fixtures';

test.describe('private complaint form', () => {
  test('submits a complaint and shows a reference number', async ({ page }) => {
    await page.goto('/complaint');
    await page.locator('#first-name').fill('Priya');
    await page.locator('#last-name').fill('Patel');
    await page.locator('#email').fill('priya.patel@example.com');
    await page.locator('#phone').fill('+91 98765 43210');
    await page.locator('label[for="star-2"]').click();
    await page.locator('#details').fill('My crown came loose two days after the appointment on Monday.');
    await page.locator('#consent').check();
    await page.locator('#submit-btn').click();

    await expect(page.locator('#success-view')).toBeVisible();
    await expect(page.locator('#reference')).toHaveText(/^SDC-[0-9A-Z]{8}$/);
  });

  test('rejects an invalid email inline', async ({ page }) => {
    await page.goto('/complaint');
    await page.locator('#email').fill('not-an-email');
    await page.locator('#email').blur();
    await expect(page.locator('#email-error')).not.toBeEmpty();
  });
});

test.describe('staff dashboard', () => {
  test('rejects wrong credentials', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('#login-email').fill('e2e-admin@stellardentalclinic.com');
    await page.locator('#login-password').fill('definitely-wrong-password');
    await page.locator('#login-btn').click();
    await expect(page.locator('#login-alert')).toBeVisible();
    await expect(page.locator('#app-view')).toBeHidden();
  });

  test('creates a short link that opens the review page and attributes the review', async ({ page, browser }, info) => {
    await signIn(page);
    await page.locator('a[data-route="links"]').click();
    const label = `Front desk ${Date.now()}`;
    await page.locator('#link-label').fill(label);
    await page.locator('#link-source').selectOption('QR code');
    await page.getByRole('button', { name: 'Create link' }).click();

    const card = page.locator('.link-card', { hasText: label });
    await expect(card).toBeVisible();
    await expect(card.locator('img.link-card__qr')).toBeVisible();
    const url = (await card.locator('.link-card__url').textContent())!;
    expect(url).toMatch(/\/r\/[A-Za-z0-9]{7}$/);

    const patientContext = await browser.newContext({
      extraHTTPHeaders: { 'X-Forwarded-For': clientIp(`patient:${info.project.name}:${info.testId}`) },
    });
    const patient = await patientContext.newPage();
    await patient.goto(url);
    await expect(patient.locator('#link-alert')).toBeHidden();
    await fillReview(patient, 4, 'Quick appointment and a very friendly team at the front desk.');
    await patient.locator('#submit-btn').click();
    await expect(patient.locator('#success-view')).toBeVisible();
    await patientContext.close();

    await page.locator('a[data-route="reviews"]').click();
    await expect(page.locator('#main')).toContainText('friendly team at the front desk');
  });

  test('complaint PII is visible to admins in the complaints view', async ({ page }) => {
    await signIn(page);
    await page.locator('a[data-route="complaints"]').click();
    await expect(page.locator('#main')).toContainText('Priya');
  });

  test('sign out ends the session', async ({ page }) => {
    await signIn(page);
    await page.locator('#logout-btn').click();
    await expect(page.locator('#login-view')).toBeVisible();
    await page.reload();
    await expect(page.locator('#login-view')).toBeVisible();
  });
});
