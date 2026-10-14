import assert from 'node:assert/strict'
import test from 'node:test'
import { flipThinkingForm, thinkingFormFor, thinkingFormFromRejection } from '../lib/thinking.js'

test('guesses the dialect from the generation in the model id', () => {
  // The adaptive generation: 4.6 and everything after it.
  for (const model of ['claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-6']) {
    assert.equal(thinkingFormFor(model), 'adaptive', model)
  }
  // The budget generation, and ids this heuristic cannot place: a wrong guess
  // costs one discarded request, never a failed turn.
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-3-5-sonnet', 'gpt-5.6-luna']) {
    assert.equal(thinkingFormFor(model), 'budget', model)
  }
})

test('flipping is its own inverse', () => {
  assert.equal(flipThinkingForm('budget'), 'adaptive')
  assert.equal(flipThinkingForm('adaptive'), 'budget')
  assert.equal(flipThinkingForm(flipThinkingForm('budget')), 'budget')
})

test('reads the dialect to retry with out of the rejection the server sends', () => {
  // Verbatim from Zed Cloud, answering a budget request for claude-sonnet-5-5.
  assert.equal(
    thinkingFormFromRejection(
      '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
    ),
    'adaptive',
  )
  assert.equal(
    thinkingFormFromRejection('"thinking.type.adaptive" is not supported for this model. Use "thinking.type.enabled".'),
    'budget',
  )
  // The other generation answers in prose, because its directive has no `type`
  // field to quote — verbatim from Zed Cloud for claude-haiku-4-5.
  assert.equal(thinkingFormFromRejection('adaptive thinking is not supported on this model'), 'budget')
  // The refused field is the whole signal, so a terser message works too.
  assert.equal(thinkingFormFromRejection('"thinking.type.enabled" is not supported'), 'adaptive')
  // Anything else is a real failure and must not be retried as a dialect guess.
  assert.equal(thinkingFormFromRejection('rate limit exceeded'), undefined)
  assert.equal(thinkingFormFromRejection('"thinking.type.enabled" is required'), undefined)
})
