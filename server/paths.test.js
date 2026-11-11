import assert from 'node:assert/strict'
import test from 'node:test'
import { apiMountPaths } from './paths.js'

test('development mounts the short QrCode API path and the configured base path', () => {
  const paths = apiMountPaths('/corporate/QrCode', { isProduction: false })

  assert.ok(paths.includes('/QrCode/api'))
  assert.ok(paths.includes('/corporate/QrCode/api'))
  assert.ok(paths.includes('/api'))
})

test('production keeps the short QrCode API path and hides the root API', () => {
  const paths = apiMountPaths('/corporate/QrCode', { isProduction: true })

  assert.deepEqual(paths.sort(), ['/QrCode/api', '/corporate/QrCode/api'].sort())
})
