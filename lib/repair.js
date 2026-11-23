/**
 * dsh-auto-review-fix — pure repair helpers.
 *
 * The official Auto review integration (`@deepseek-ai/dsh-experimental-auto-review`)
 * has three entry-side failure modes, all observed on this machine:
 *
 * 1. the reviewer runs on the *main* request's provider, and some third-party
 *    routes (`custom-route/DeepSeek-V4.1-Flash`) do not honour the fixed review
 *    protocol — the model streams ordinary prose or several text blocks, so
 *    `readDecision` throws `reviewer must emit zero or more reasoning blocks
 *    followed by exactly one text block`;
 * 2. transient provider errors surface as `reviewer ended with error
 *    STREAM_CLOSED: …` with no retry;
 * 3. `session.requestHeader()` can point at a non-conversation request (title /
 *    compaction), so the pending tool is missing from `header.tools` and the
 *    snapshot throws `the pending native tool schema is missing or ambiguous`.
 *
 * Every one of those is thrown from the `tools/pre-execute` listener, and the
 * tools pipeline turns a thrown gate into a failed call — so one broken review
 * blocks every tool in the session.
 *
 * The repair keeps the review on the session's own route first (so the reviewer
 * sees exactly the model the session was configured with) and only falls back
 * to the fixed `deepseek-account` route when that route cannot serve a review.
 * To know whether a route "served" it, the helpers re-implement the
 * integration's own acceptance test: one terminal `stop`, zero or more
 * reasoning blocks, then exactly one text block holding the closed
 * risk/decision JSON.
 *
 * These helpers stay pure so the repair is testable without a Host.
 *
 * @module dsh-auto-review-fix/repair
 */

/** Marker of the fixed reviewer system prompt (starts with `REVIEW_POLICY`). */
export const REVIEW_MARKER = 'You are the final authorization reviewer'

/** Every error the integration throws is prefixed with this. */
export const AUTO_REVIEW_PREFIX = 'auto-review:'

/**
 * Whether one LLM call is the Auto review probe.
 * @param {unknown} options - options passed to `llm.stream`.
 * @returns {boolean} true for the reviewer call.
 */
export function isReviewCall(options) {
  if (options === null || typeof options !== 'object') return false
  const system = /** @type {Record<string, unknown>} */ (options).system
  return typeof system === 'string' && system.includes(REVIEW_MARKER)
}

/**
 * Rewrite a review call onto another route.
 * @param {Record<string, any>} options - original call options.
 * @param {{provider?: string, model?: string}} route - route to apply.
 * @returns {Record<string, any>} options for the underlying call.
 */
export function rewriteRoute(options, route) {
  const provider = route?.provider
  const model = route?.model
  if (provider === undefined && model === undefined) return options
  const next = { ...options }
  if (typeof provider === 'string' && provider !== '') next.provider = provider
  if (typeof model === 'string' && model !== '') next.model = model
  return next
}

/**
 * Whether an error came from the Auto review integration.
 * @param {unknown} error - thrown value.
 * @returns {boolean} true when this repair may handle it.
 */
export function isAutoReviewError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(AUTO_REVIEW_PREFIX) || message.startsWith('auto-review')
}

/**
 * Whether a thrown value is a cancellation rather than a provider failure.
 * @param {unknown} error - thrown value.
 * @returns {boolean} true when retrying would be wrong.
 */
export function isAbortLike(error) {
  if (error === null || typeof error !== 'object') return false
  const name = /** @type {Record<string, unknown>} */ (error).name
  const code = /** @type {Record<string, unknown>} */ (error).code
  return name === 'AbortError' || code === 'ABORT_ERR'
}

/**
 * Build the decision returned when the reviewer is unavailable.
 *
 * `ask` keeps the human gate (the approval UI prompts once) instead of blocking
 * the tool outright; `allow`/`deny` are escape hatches for unattended setups.
 *
 * @param {string} mode - `ask`, `allow` or `deny`.
 * @param {string} reason - audited explanation.
 * @returns {{kind: 'ask'|'allow'|'deny', reason?: string}} pipeline decision.
 */
export function fallbackDecision(mode, reason) {
  if (mode === 'allow') return { kind: 'allow' }
  if (mode === 'deny') return { kind: 'deny', reason }
  return { kind: 'ask', reason }
}

/**
 * Count members of the raw top-level JSON object (mirrors the integration).
 * @param {string} text - reviewer text block.
 * @returns {number} member count.
 */
function topLevelMemberCount(text) {
  const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, '')
  let depth = 0
  let count = 0
  for (const char of syntax) {
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ':' && depth === 1) count += 1
  }
  return count
}

/**
 * Parse the closed risk/decision protocol and its fixed safety combinations.
 * @param {string} text - the single reviewer text block.
 * @returns {{risk: string, decision: string, reason?: string}} accepted decision.
 */
export function parseReviewDecision(text) {
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('auto-review: reviewer output must be one JSON object')
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const keys = Object.keys(record)
  if (topLevelMemberCount(text) !== keys.length) throw new Error('auto-review: reviewer output repeats a JSON member')
  const risk = record.risk
  const decision = record.decision
  if (keys.length === 2 && decision === 'allow' && (risk === 'low' || risk === 'medium')) return { risk, decision }
  if (keys.length === 2 && decision === 'deny' && (risk === 'medium' || risk === 'high')) return { risk, decision }
  if (
    decision === 'deny' &&
    (risk === 'medium' || risk === 'high') &&
    keys.length === 3 &&
    Object.hasOwn(record, 'reason') &&
    typeof record.reason === 'string'
  ) {
    return { risk, decision, reason: record.reason }
  }
  throw new Error('auto-review: reviewer output does not match the risk/decision protocol')
}

/**
 * Assemble raw stream chunks the way the integration's BlockAssembler does.
 * @param {any[]} chunks - buffered stream chunks.
 * @returns {{blocks: any[], finish: any}} assembled blocks and terminal reason.
 */
export function assembleReviewBlocks(chunks) {
  const partials = new Map()
  const order = []
  let finish
  const ensure = (index, type) => {
    let partial = partials.get(index)
    if (partial === undefined) {
      partial = { type, text: '', arguments: '' }
      partials.set(index, partial)
      order.push(index)
    }
    return partial
  }
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    switch (chunk.type) {
      case 'block-start':
        if (!partials.has(chunk.index)) {
          partials.set(chunk.index, { type: chunk.blockType, text: '', arguments: '' })
          order.push(chunk.index)
        }
        break
      case 'text-delta':
        ensure(chunk.index, 'text').text += typeof chunk.text === 'string' ? chunk.text : ''
        break
      case 'reasoning-delta':
        ensure(chunk.index, 'reasoning').text += typeof chunk.text === 'string' ? chunk.text : ''
        break
      case 'tool-call-delta':
        ensure(chunk.index, 'tool-call').arguments += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        break
      case 'block-end': {
        const partial = ensure(chunk.index, chunk.block?.type ?? 'text')
        partial.block = chunk.block
        break
      }
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  const blocks = order.map((index) => {
    const partial = partials.get(index)
    if (partial.block !== undefined) return partial.block
    if (partial.type === 'tool-call') return { type: 'tool-call', arguments: partial.arguments }
    return { type: partial.type, text: partial.text }
  })
  return { blocks, finish }
}

/**
 * Judge one buffered review attempt with the integration's own acceptance test.
 *
 * This is a pre-flight check: a route that fails here could never satisfy
 * `readDecision`, so the caller may retry it on another route instead of
 * letting the whole tool pipeline fail.
 *
 * @param {any[]} chunks - buffered stream chunks of one attempt.
 * @returns {{ok: true, decision: any} | {ok: false, error: Error}} verdict.
 */
export function validateReviewOutput(chunks) {
  const { blocks, finish } = assembleReviewBlocks(chunks)
  const failed = (message) => ({ ok: false, error: new Error(message) })
  const finishAt = chunks.findIndex((chunk) => chunk?.type === 'finish')
  if (finishAt >= 0 && finishAt < chunks.length - 1) {
    return failed('auto-review: reviewer emitted data after its terminal finish')
  }
  if (finish === undefined) return failed('auto-review: reviewer emitted no terminal finish')
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const code = finish.failure?.code ?? 'UNKNOWN'
    const message = finish.failure?.message ?? 'no failure detail'
    return failed(`auto-review: reviewer ended with ${finish.kind} ${code}: ${message}`)
  }
  if (finish.kind !== 'stop') return failed(`auto-review: reviewer ended with ${finish.kind}`)
  const final = blocks.at(-1)
  if (final?.type !== 'text' || blocks.slice(0, -1).some((block) => block.type !== 'reasoning')) {
    return failed('auto-review: reviewer must emit zero or more reasoning blocks followed by exactly one text block')
  }
  try {
    return { ok: true, decision: parseReviewDecision(final.text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * Build the ordered attempt list for one review call.
 *
 * The first attempt keeps the session's own route (the call options already
 * carry it), so the reviewer runs on the model the session was configured with.
 * Only when that route cannot serve a review does the fixed fallback route run.
 *
 * @param {Record<string, any>} options - original review call options.
 * @param {object} config - normalised config.
 * @returns {{options: Record<string, any>, route: 'session'|'fixed'|'fallback'}[]} attempts.
 */
export function planReviewAttempts(options, config) {
  const fixed = config?.route === 'fixed' && (config.provider !== undefined || config.model !== undefined)
  const primary = fixed ? rewriteRoute(options, { provider: config.provider, model: config.model }) : options
  const extra = Number.isFinite(config?.retries) && config.retries > 0 ? Math.floor(config.retries) : 0
  const attempts = []
  for (let index = 0; index <= extra; index += 1) attempts.push({ options: primary, route: fixed ? 'fixed' : 'session' })
  if (typeof config?.fallbackProvider === 'string' && config.fallbackProvider !== '') {
    attempts.push({
      options: rewriteRoute(options, { provider: config.fallbackProvider, model: config.fallbackModel }),
      route: 'fallback',
    })
  }
  return attempts
}

/**
 * Wrap one stream factory with the attempt plan and the acceptance test.
 *
 * Each attempt is buffered and judged; a rejected attempt is discarded and the
 * next route is tried. Cancellation is never retried, and when every attempt
 * fails the last real error is thrown so the integration (and the gate
 * watchdog) still reports the true cause.
 *
 * @param {(options: Record<string, any>) => AsyncIterable<any>} open - opens one attempt.
 * @param {{options: Record<string, any>, route: string}[]} attempts - ordered attempts.
 * @param {object} [hooks] - observation hooks.
 * @param {() => boolean} [hooks.aborted] - whether the caller cancelled.
 * @param {(attempt: object, error: Error) => void} [hooks.onFailure] - attempt rejected.
 * @param {(attempt: object, decision: any) => void} [hooks.onSuccess] - attempt accepted.
 * @returns {AsyncIterable<any>} chunk stream.
 */
export function attemptingStream(open, attempts, hooks = {}) {
  const aborted = typeof hooks.aborted === 'function' ? hooks.aborted : () => false
  return (async function* iterate() {
    let lastError
    for (const attempt of attempts) {
      const buffered = []
      try {
        for await (const chunk of open(attempt.options)) buffered.push(chunk)
      } catch (error) {
        if (aborted() || isAbortLike(error)) throw error
        lastError = error instanceof Error ? error : new Error(String(error))
        hooks.onFailure?.(attempt, lastError)
        continue
      }
      const verdict = validateReviewOutput(buffered)
      if (verdict.ok) {
        hooks.onSuccess?.(attempt, verdict.decision)
        for (const chunk of buffered) yield chunk
        return
      }
      lastError = verdict.error
      hooks.onFailure?.(attempt, verdict.error)
      if (aborted()) throw verdict.error
    }
    throw lastError ?? new Error('auto-review: reviewer produced no usable decision')
  })()
}
