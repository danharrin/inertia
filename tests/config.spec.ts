import { expect, test } from '@playwright/test'
import { requests, shouldBeDumpPage } from './support'

test.describe('passing defaults to createInertiaApp', () => {
  test('applies visitOptions from app defaults', async ({ page }) => {
    await page.goto('/?withAppDefaults=true')
    await page.evaluate(() => window.testing.Inertia.visit('/dump/get'))

    const dump = await shouldBeDumpPage(page, 'get')

    await expect(dump.headers).toMatchObject({
      'x-from-app-defaults': 'test',
    })
  })
})

test.describe('updating config via config instance', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/custom-config')
  })

  test('visit options', async ({ page }) => {
    await page.getByRole('button', { name: 'Post Dump' }).click()
    const dump = await shouldBeDumpPage(page, 'post')

    await expect(dump.headers).toMatchObject({
      'x-from-link': 'foo',
      'x-from-callback': 'bar',
    })
  })

  test('preserves router wrappers when helper methods delegate to visit', async ({ page }) => {
    await page.evaluate(() => {
      const router = window.testing.Inertia
      const originalVisit = router.visit.bind(router)

      router.visit = (url, options) =>
        originalVisit(url, {
          ...options,
          headers: { ...options?.headers, 'X-Inner-Wrapper': 'present' },
        })

      const wrappedVisit = router.visit

      router.visit = (url, options) =>
        wrappedVisit(url, {
          ...options,
          headers: { ...options?.headers, 'X-Outer-Wrapper': 'present' },
        })

      document.addEventListener('restore-router-visit', () => {
        router.visit = originalVisit
      })
    })

    for (const method of ['visit', 'get', 'post', 'reload'] as const) {
      await page.evaluate(
        (method) =>
          new Promise<void>((resolve) => {
            const router = window.testing.Inertia
            const options = { onFinish: () => resolve() }

            if (method === 'reload') {
              router.reload({ ...options, method: 'post' })
            } else if (method === 'visit') {
              router.visit('/dump/get', options)
            } else {
              router[method](`/dump/${method}`, {}, options)
            }
          }),
        method,
      )

      const dump = await shouldBeDumpPage(page, method === 'post' || method === 'reload' ? 'post' : 'get')

      expect(dump.headers).toMatchObject({ 'x-inner-wrapper': 'present', 'x-outer-wrapper': 'present' })
    }

    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          document.dispatchEvent(new Event('restore-router-visit'))
          window.testing.Inertia.get('/dump/get', {}, { onFinish: () => resolve() })
        }),
    )

    const dump = await shouldBeDumpPage(page, 'get')

    expect(dump.headers).not.toHaveProperty('x-inner-wrapper')
    expect(dump.headers).not.toHaveProperty('x-outer-wrapper')
  })

  test('prefetch duration', async ({ page }) => {
    const link = await page.getByRole('link', { name: 'Prefetch Link' })
    const prefetchPromise = page.waitForResponse(
      (response) => response.url().includes('/dump/get') && response.request().headers().purpose === 'prefetch',
    )

    // Wait for the page to be prefetched
    await link.hover()
    await prefetchPromise

    // Wait two seconds
    await page.waitForTimeout(2020)

    // Now click the link and ensure a new request is made
    requests.listen(page)
    await link.click()
    await shouldBeDumpPage(page, 'get')
    await expect.poll(() => requests.requests.length).toBe(1)
  })

  test('recently successful duration', async ({ page }) => {
    const link = await page.getByRole('button', { name: 'Submit Form' })
    const message = page.getByText('Form was recently successful!')
    await link.click()
    await message.waitFor()

    await page.waitForTimeout(1020)
    await expect(message).toBeHidden()
  })
})
