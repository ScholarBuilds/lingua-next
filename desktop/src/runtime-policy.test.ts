import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { externalUrl, restartAttempt, restartDelay, trustedFrame } from './runtime-policy'

test('external protocols and IPC frames are constrained', () => {
  assert.equal(externalUrl('file:///etc/passwd'), null)
  assert.equal(externalUrl('javascript:alert(1)'), null)
  assert.equal(externalUrl('https://example.com'), 'https://example.com/')
  assert.equal(trustedFrame('http://127.0.0.1:8000/page', 'http://127.0.0.1:8000', true), true)
  assert.equal(trustedFrame('http://127.0.0.1:8000/page', 'http://127.0.0.1:8000', false), false)
  assert.equal(trustedFrame('https://example.com', 'http://127.0.0.1:8000', true), false)
})

test('briefly ready processes do not reset the restart budget', () => {
  assert.equal(restartAttempt(4, 1000, 2000), 5)
  assert.equal(restartDelay(6), null)
  assert.equal(restartAttempt(4, 1000, 62_000), 1)
  assert.equal(restartDelay(1), 1000)
})
