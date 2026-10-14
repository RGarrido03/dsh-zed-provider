/**
 * Turning a Zed Cloud refusal into the harness's failure vocabulary.
 *
 * The status alone is not enough. Zed answers an exhausted credit balance with
 * `403 {"code":"token_spend_limit_reached"}`, which looks like an authentication
 * failure by status and is reported that way if it is classified by status
 * alone — the user is then told their key is invalid while the real answer is
 * that the month's included credits are gone.
 *
 * No harness imports: this module is pure and runs under plain node.
 */

/** One classified refusal: the harness code plus a sentence naming the cause. */
export interface ZedFailure {
  code: string
  message: string
}

const ACCOUNT_HINT = 'Zed shows the balance and its reset on https://zed.dev/account'

/**
 * Classify one refused response.
 *
 * @param status - HTTP status, when the request got that far.
 * @param body - response body text, used to read Zed's own error code.
 * @returns the harness failure code and the diagnosis to show.
 */
export function classifyZedFailure(status: number | undefined, body: string): ZedFailure {
  const detail = body.trim().length > 0 ? `: ${body.trim()}` : ''

  // Zed's spend limit arrives as 403, and 402 covers a plan that is missing or
  // out of credits: both are quota conditions, and no retry clears either.
  if (/token_spend_limit_reached/.test(body) || status === 402) {
    return {
      code: 'QUOTA',
      message: `this Zed account's included AI credits are used up for the current period. ${ACCOUNT_HINT}.`,
    }
  }
  if (status === 401 || status === 403) {
    return {
      code: 'AUTH',
      message: 'Zed Cloud rejected the stored credential. Run /zed-login to link the account again.',
    }
  }
  if (status === 429) {
    return { code: 'RATE_LIMIT', message: `Zed Cloud rate-limited the request${detail}` }
  }
  if (status === 400 || status === 413) {
    return { code: 'INVALID_REQUEST', message: `Zed Cloud refused the request${detail}` }
  }
  if (status !== undefined && status >= 500) {
    return { code: 'SERVER', message: `Zed Cloud failed the request${detail}` }
  }
  return {
    code: status === undefined ? 'TRANSPORT' : `HTTP_${status}`,
    message: `Zed Cloud rejected the request${detail}`,
  }
}
