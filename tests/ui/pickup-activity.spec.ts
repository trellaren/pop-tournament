import { test, expect } from '@playwright/test';

/**
 * The pickup Activity page outside Discord: it has nothing to sign in with,
 * so it says where to open it from and shows no lobby.
 *
 * @tag ui
 * @tag pickup
 */

test.describe('Pickup Activity page', { tag: ['@ui', '@pickup'] }, () => {
  test('explains itself outside Discord', async ({ page }) => {
    await page.goto('/activity');
    const activity = page.getByTestId('pickup-activity');
    await expect(activity).toBeVisible();
    await expect(
      activity.getByText(/The Activity is not set up|Open this from Discord/)
    ).toBeVisible();
    await expect(page.getByTestId('pickup-open')).toHaveCount(0);
  });
});
