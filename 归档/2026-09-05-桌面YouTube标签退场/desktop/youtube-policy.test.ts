import assert from 'node:assert/strict'
import { test } from 'node:test'
import { youtubeNavigation, youtubeResource } from './youtube-policy.js'

test('navigation accepts only public YouTube HTTPS URLs', () => {
  assert.ok(youtubeNavigation('https://www.youtube.com/watch?v=abcdefghijk'))
  for (const url of ['http://youtube.com', 'file:///tmp/a', 'https://youtube.com.evil.test', 'https://user:password@youtube.com', 'https://127.0.0.1']) {
    assert.equal(youtubeNavigation(url), null)
  }
})

test('remote resources cannot reach the local service or arbitrary hosts', () => {
  assert.equal(youtubeResource('https://rr1.googlevideo.com/videoplayback'), true)
  for (const url of ['http://127.0.0.1:8100/config', 'https://localhost', 'file:///etc/hosts', 'https://evil.test', 'https://ytimg.com.evil.test']) {
    assert.equal(youtubeResource(url), false)
  }
})
