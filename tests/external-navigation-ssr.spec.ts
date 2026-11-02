import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'

test.describe('React external SSR', () => {
  test.skip(process.env.PACKAGE !== 'react', 'React server rendering')

  for (const entry of ['factory', 'explicit']) {
    test(`renders an external app with the ${entry} entry without starting browser navigation`, async () => {
      // A fresh process prevents an earlier render from masking router initialization errors.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
        import { createInertiaApp } from './dist/index.js'
        import { createElement } from 'react'
        import { renderToString } from 'react-dom/server'
        import { rejects } from 'node:assert/strict'

        const page = {
          component: 'Report',
          url: 'https://example.com/reports/1',
          props: { errors: {}, name: 'Monthly revenue' },
          flash: {},
          version: null,
        }
        const options = {
          id: 'report',
          resolve: () => ({ name }) => createElement('h1', null, name),
          externalNavigation: { navigate() { throw new Error('Unexpected navigation') } },
        }
        await rejects(createInertiaApp(options), /External navigation requires a custom setup callback/)
        options.setup = ({ App, props }) => createElement(App, props)
        const result = ${
          entry === 'explicit'
            ? `await createInertiaApp({ ...options, page, render: renderToString })`
            : `await (await createInertiaApp(options))(page, renderToString)`
        }

        // Let detached initialization finish so an unhandled rejection fails the process.
        await new Promise((resolve) => setImmediate(resolve))
        console.log(JSON.stringify(result))
      `,
        ],
        { cwd: resolve('packages/react') },
      )

      expect(JSON.parse(stdout).body).toContain('<h1>Monthly revenue</h1>')
      expect(JSON.parse(stdout).body).toContain('id="report"')
    })
  }
})
