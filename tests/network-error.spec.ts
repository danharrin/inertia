import { expect, test } from '@playwright/test'

test.describe('network error', () => {
  test('it clears pending optimistic requests after network failure', async ({ page }) => {
    await page.goto('/network-error')

    await page.route('**/network-error', async (route) => {
      if (route.request().headers()['x-inertia']) {
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })

    await page.evaluate(() => window.testing.Inertia.optimistic(() => ({})))

    await page.locator('#make-request').click()
    await expect(page.locator('#network-error')).toBeVisible()

    await expect.poll(() => page.evaluate(() => window.testing.Inertia.hasPendingOptimistic())).toBe(false)
  })
})
