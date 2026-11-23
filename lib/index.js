/**
 * dsh-auto-review-fix — Host half.
 *
 * Repairs two entry-side defects of the official Auto review integration
 * without touching the vendored package:
 *
 * 1. **Reviewer route.** The integration reviews with the *main* request's
 *    provider/model — which is what the session was configured with, and what
 *    this repair keeps as the first choice. When that route cannot serve a
 *    review (provider error, `STREAM_CLOSED`, or output that violates the fixed
 *    reasoning/text/JSON protocol — observed with `custom-route/DeepSeek-V4.1-Flash`),
 *    the call is retried once on the fixed `deepseek-account` route.
 * 2. **Fail-closed blast radius.** Every review failure is thrown from the
 *    `tools/pre-execute` listener, and the tools pipeline turns that into a
 *    failed call — so one broken review blocks every tool in the session. This
 *    plugin prepends its own gate that wraps `next()` and converts only
 *    `auto-review:` failures into a configured fallback decision (default:
 *    `ask`, i.e. the normal approval prompt) instead of an error.
 *
 * Both hooks are reversible service wrappers, so updating the official package
 * keeps the repair working and disabling this plugin restores stock behaviour.
 *
 * @module dsh-auto-review-fix
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeConfig } from './config.js'
import { attemptingStream, fallbackDecision, isAutoReviewError, isReviewCall, planReviewAttempts } from './repair.js'

/** Plugin id used by the profile patch layer. */
export const name = 'dsh-auto-review-fix'

/** `llm` owns the reviewer stream; `tools` owns the pre-execute gate. */
export const inject = ['llm', 'tools']

/** Idempotence marker so a re-mount never wraps the same service twice. */
const STREAM_WRAPPED = Symbol.for('dsh-auto-review-fix.stream')

/**
 * Append one audit record; never throws into the approval path.
 * @param {object} config - normalised config.
 * @param {object} record - audit fields.
 * @returns {void}
 */
export function audit(config, record) {
  try {
    mkdirSync(dirname(config.auditPath), { recursive: true })
    appendFileSync(config.auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch {
    /* auditing is best effort */
  }
}

/**
 * Describe the primary review route for logs.
 * @param {object} config - normalised config.
 * @returns {string} human label.
 */
function primaryLabel(config) {
  return config.route === 'fixed' ? `${String(config.provider)}/${String(config.model)}` : 'the session route'
}

/**
 * Keep review calls on the session route and fall back only when it fails.
 *
 * Only calls carrying the fixed reviewer system prompt are touched; every other
 * request passes through unchanged. Each attempt is buffered and checked against
 * the integration's own acceptance test, so an unusable route is retried on the
 * next one instead of failing the whole tool call.
 *
 * @param {any} ctx - cordis context.
 * @param {object} config - normalised config.
 * @returns {boolean} whether the stream service is wrapped.
 */
export function wrapReviewStream(ctx, config) {
  const llm = ctx.llm
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') return false
  if (llm[STREAM_WRAPPED] === true) return true
  const original = llm.stream

  const patched = function patchedStream(options, ...rest) {
    if (!isReviewCall(options)) return original.call(llm, options, ...rest)
    const attempts = planReviewAttempts(options, config)
    // Stock call on the session route with nothing to fall back to: pass it on.
    if (attempts.length === 1 && attempts[0].route === 'session') return original.call(llm, options, ...rest)
    const aborted = () => options?.signal?.aborted === true
    let lastFailure
    return attemptingStream((attemptOptions) => original.call(llm, attemptOptions, ...rest), attempts, {
      aborted,
      onFailure: (attempt, error) => {
        lastFailure = error
      },
      onSuccess: (attempt) => {
        if (attempt.route !== 'fallback') return
        const reason = lastFailure instanceof Error ? lastFailure.message.slice(0, 300) : undefined
        audit(config, {
          kind: 'route-fallback',
          from: { provider: options?.provider, model: options?.model },
          to: { provider: config.fallbackProvider, model: config.fallbackModel },
          reason,
        })
        ctx.logger?.warn?.(
          `${name}: review on ${String(options?.provider)}/${String(options?.model)} failed (${String(reason)}); retried on ${String(config.fallbackProvider)}/${String(config.fallbackModel)}`,
        )
      },
    })
  }

  llm.stream = patched
  try {
    Object.defineProperty(llm, STREAM_WRAPPED, { value: true, enumerable: false, configurable: true })
  } catch {
    llm[STREAM_WRAPPED] = true
  }

  // Restore only when the current method is still ours (another plugin may wrap later).
  ctx.effect(() => () => {
    if (llm.stream !== patched) return
    llm.stream = original
    try {
      delete llm[STREAM_WRAPPED]
    } catch {
      llm[STREAM_WRAPPED] = false
    }
  })
  return true
}

/**
 * Wrap the tools pre-execute gate so a broken reviewer degrades instead of
 * blocking every call.
 *
 * Prepend matters: the integration registers its own prepended gate, and the
 * later `unshift` runs first — so this listener observes its rejection.
 *
 * @param {any} ctx - cordis context.
 * @param {object} config - normalised config.
 * @returns {void}
 */
export function installGateWatchdog(ctx, config) {
  ctx.on(
    'tools/pre-execute',
    async (/** @type {any} */ exec, /** @type {() => Promise<any>} */ next) => {
      try {
        return await next()
      } catch (error) {
        if (!isAutoReviewError(error)) throw error
        const detail = error instanceof Error ? error.message : String(error)
        audit(config, {
          kind: 'gate-fallback',
          tool: exec?.name,
          callId: exec?.callId === undefined ? undefined : String(exec.callId),
          session: exec?.agent?.session?.id,
          fallback: config.fallback,
          error: detail.slice(0, 400),
        })
        ctx.logger?.warn?.(
          `${name}: Auto review failed for tool "${String(exec?.name)}"; falling back to "${config.fallback}": ${detail}`,
        )
        return fallbackDecision(config.fallback, `Auto review is unavailable: ${detail}`)
      }
    },
    { prepend: true },
  )
}

/**
 * Install both repairs.
 * @param {any} ctx - cordis plugin context.
 * @param {unknown} [rawConfig] - configuration from the patch layer.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger?.info?.(`${name}: disabled by config`)
    return
  }
  const streamWrapped = wrapReviewStream(ctx, config)
  installGateWatchdog(ctx, config)
  const fallbackRoute =
    config.fallbackProvider === undefined
      ? 'none'
      : `${String(config.fallbackProvider)}/${String(config.fallbackModel ?? '')}`
  ctx.logger?.info?.(
    `${name}: review route ${primaryLabel(config)}, fallback ${fallbackRoute}, retries ${config.retries}, gate fallback ${config.fallback}, stream hook ${streamWrapped ? 'on' : 'off'}`,
  )
}
