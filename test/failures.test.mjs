import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyZedFailure } from '../lib/failures.js'

test('an exhausted credit balance is a quota failure, not a bad credential', () => {
  // Verbatim from Zed Cloud: the status says forbidden, the body says spent.
  const failure = classifyZedFailure(403, '{"code":"token_spend_limit_reached","message":"Student plan credits consumed."}')
  assert.equal(failure.code, 'QUOTA')
  assert.match(failure.message, /credits are used up/)
  assert.match(failure.message, /zed\.dev\/account/)
})

test('a plain 402 is the same quota condition', () => {
  assert.equal(classifyZedFailure(402, '').code, 'QUOTA')
})

test('a genuinely rejected credential stays an authentication failure', () => {
  const failure = classifyZedFailure(401, 'Unauthorized')
  assert.equal(failure.code, 'AUTH')
  assert.match(failure.message, /\/zed-login/)
  assert.equal(classifyZedFailure(403, 'forbidden').code, 'AUTH')
})

test('the rest of the taxonomy keeps its retry meaning', () => {
  assert.equal(classifyZedFailure(429, 'slow down').code, 'RATE_LIMIT')
  assert.equal(classifyZedFailure(400, 'bad body').code, 'INVALID_REQUEST')
  assert.equal(classifyZedFailure(503, '').code, 'SERVER')
  assert.equal(classifyZedFailure(418, '').code, 'HTTP_418')
  assert.equal(classifyZedFailure(undefined, '').code, 'TRANSPORT')
})
