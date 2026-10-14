/**
 * Which extended-thinking dialect one Claude generation accepts.
 *
 * Zed's model list says only *whether* a model thinks (`supports_thinking`), not
 * how it wants thinking expressed, and the two dialects are mutually exclusive:
 * the budget generation rejects `thinking.type.adaptive`, the adaptive
 * generation rejects `thinking.type.enabled`. So the form is guessed from the
 * model id, and the guess is corrected — once, invisibly — from the provider's
 * own rejection message when it is wrong.
 *
 * No harness imports: this module is pure and runs under plain node.
 */

/** `enabled` + `budget_tokens`, or `adaptive` + `output_config.effort`. */
export type ThinkingForm = 'budget' | 'adaptive'

/** The generation that introduced adaptive thinking. */
const ADAPTIVE_FROM = { major: 4, minor: 6 }

/**
 * Guess the dialect from a model id such as `claude-sonnet-5-5`.
 *
 * Anything unrecognisable gets the budget form: it is the older, more widely
 * accepted spelling, and a wrong guess costs one discarded request rather than a
 * failed turn.
 */
export function thinkingFormFor(model: string): ThinkingForm {
  const match = /claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model)
  if (match === null) return 'budget'
  const major = Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  if (major > ADAPTIVE_FROM.major) return 'adaptive'
  if (major === ADAPTIVE_FROM.major && minor >= ADAPTIVE_FROM.minor) return 'adaptive'
  return 'budget'
}

/** The other dialect, for the one correction attempt. */
export function flipThinkingForm(form: ThinkingForm): ThinkingForm {
  return form === 'budget' ? 'adaptive' : 'budget'
}

/**
 * The refusals observed from Zed Cloud, and the dialect each one asks for.
 *
 * The two generations word it differently: the budget generation is refused by
 * naming the field (`"thinking.type.enabled" is not supported for this model.
 * Use "thinking.type.adaptive" …`), while the adaptive generation answers in
 * prose (`adaptive thinking is not supported on this model`) because its
 * directive has no `type` field to quote. Both were captured against the live
 * endpoint; the mirrors cover a generation that words it the other way round.
 */
const REFUSALS: readonly (readonly [RegExp, ThinkingForm])[] = [
  [/"thinking\.type\.enabled"\s+is not supported/i, 'adaptive'],
  [/adaptive thinking is not supported/i, 'budget'],
  [/"thinking\.type\.adaptive"\s+is not supported/i, 'budget'],
  [/enabled thinking is not supported|budget_tokens is not supported/i, 'adaptive'],
]

/**
 * Read the dialect to retry with out of a rejected turn.
 *
 * @param message - the provider's failure text.
 * @returns the dialect to retry with, or undefined when this is a different failure.
 */
export function thinkingFormFromRejection(message: string): ThinkingForm | undefined {
  for (const [pattern, form] of REFUSALS) if (pattern.test(message)) return form
  return undefined
}
