import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, audit, installGateWatchdog, wrapReviewStream } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'
import {
  assembleReviewBlocks,
  attemptingStream,
  fallbackDecision,
  isAbortLike,
  isAutoReviewError,
  isReviewCall,
  parseReviewDecision,
  planReviewAttempts,
  rewriteRoute,
  validateReviewOutput,
} from '../lib/repair.js'

let counter = 0

/**
 * Unique audit path per test.
 * @returns {string} absolute path.
 */
function tempAudit() {
  counter += 1
  return join(tmpdir(), 'dsh-auto-review-fix-test', `audit-${process.pid}-${counter}.jsonl`)
}

/** Options shaped like the integration's reviewer call (session route = custom-route). */
function reviewOptions(extra = {}) {
  return {
    provider: 'custom-route',
    model: 'DeepSeek-V4.1-Flash',
    system: 'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PENDING_ACTION …' }] }],
    ...extra,
  }
}

/** A compliant reviewer stream: one reasoning block, one JSON text block, stop. */
function allowChunks() {
  return [
    { type: 'reasoning-delta', index: 0, text: 'weighing the risk' },
    { type: 'text-delta', index: 1, text: '{"risk":"low","decision":"allow"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A stream that breaks the protocol: two text blocks, no reasoning. */
function proseChunks() {
  return [
    { type: 'text-delta', index: 0, text: 'I think this command is fine.' },
    { type: 'text-delta', index: 1, text: 'It only prints a greeting.' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A stream that ends with a provider error. */
function closedChunks() {
  return [{ type: 'finish', reason: { kind: 'error', failure: { code: 'STREAM_CLOSED', message: 'closed' } } }]
}

/** Turn a chunk array into a fresh async iterable. */
function streamOf(chunks) {
  return (async function* run() {
    for (const chunk of chunks) yield chunk
  })()
}

/**
 * Fake cordis context with a fake llm service.
 * @param {object} [options] - harness options.
 * @returns {object} harness.
 */
function harness(options = {}) {
  const handlers = new Map()
  const disposers = []
  const warnings = []
  const infos = []
  const calls = []
  const respond = options.respond ?? (() => streamOf([]))
  const llm = {
    stream(callOptions, ...rest) {
      calls.push({ options: callOptions, rest })
      return respond(callOptions)
    },
  }
  const ctx = {
    logger: { info: (message) => infos.push(message), warn: (message) => warnings.push(message) },
    llm,
    on(event, handler, listenOptions) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push({ handler, listenOptions })
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }
  return { ctx, llm, handlers, disposers, warnings, infos, calls }
}

/** Collect an async iterable into an array. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const ENV = { DSH_AUTO_REVIEW_FIX_HOME: 'C:\\Users\\test' }

test('isReviewCall only matches the reviewer system prompt', () => {
  assert.equal(isReviewCall(reviewOptions()), true)
  assert.equal(isReviewCall({ system: 'You are a helpful assistant', messages: [] }), false)
  assert.equal(isReviewCall({ messages: [] }), false)
  assert.equal(isReviewCall(undefined), false)
  assert.equal(isReviewCall('REVIEW_POLICY'), false)
})

test('rewriteRoute only replaces configured halves', () => {
  const original = reviewOptions()
  const rewritten = rewriteRoute(original, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(rewritten.provider, 'deepseek-account')
  assert.equal(rewritten.model, 'deepseek-flash')
  assert.equal(original.provider, 'custom-route', 'original object untouched')
  assert.equal(rewriteRoute(original, {}), original, 'no route keeps the call identical')
  assert.equal(rewriteRoute(original, { provider: 'x' }).model, 'DeepSeek-V4.1-Flash')
})

test('isAutoReviewError only claims integration failures', () => {
  assert.equal(isAutoReviewError(new Error('auto-review: reviewer must emit zero or more reasoning blocks')), true)
  assert.equal(isAutoReviewError(new Error('auto-review: the pending native tool schema is missing or ambiguous')), true)
  assert.equal(isAutoReviewError(new Error('auto-review: reviewer ended with error STREAM_CLOSED: boom')), true)
  assert.equal(isAutoReviewError('auto-review: plain string'), true)
  assert.equal(isAutoReviewError(new Error('sandbox denied')), false)
})

test('isAbortLike distinguishes cancellation from provider failure', () => {
  const abort = new Error('cancelled')
  abort.name = 'AbortError'
  assert.equal(isAbortLike(abort), true)
  assert.equal(isAbortLike({ code: 'ABORT_ERR' }), true)
  assert.equal(isAbortLike(new Error('STREAM_CLOSED')), false)
  assert.equal(isAbortLike(undefined), false)
})

test('fallbackDecision maps each mode', () => {
  assert.deepEqual(fallbackDecision('ask', 'why'), { kind: 'ask', reason: 'why' })
  assert.deepEqual(fallbackDecision('allow', 'why'), { kind: 'allow' })
  assert.deepEqual(fallbackDecision('deny', 'why'), { kind: 'deny', reason: 'why' })
  assert.deepEqual(fallbackDecision('nonsense', 'why'), { kind: 'ask', reason: 'why' })
})

test('assembleReviewBlocks mirrors the integration assembler', () => {
  const deltaOnly = assembleReviewBlocks(allowChunks())
  assert.deepEqual(deltaOnly.blocks, [
    { type: 'reasoning', text: 'weighing the risk' },
    { type: 'text', text: '{"risk":"low","decision":"allow"}' },
  ])
  assert.equal(deltaOnly.finish.kind, 'stop')

  const explicit = assembleReviewBlocks([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'a' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'a' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(explicit.blocks, [{ type: 'text', text: 'a' }])
})

test('validateReviewOutput accepts only the closed protocol', () => {
  assert.equal(validateReviewOutput(allowChunks()).ok, true)

  const prose = validateReviewOutput(proseChunks())
  assert.equal(prose.ok, false)
  assert.match(prose.error.message, /zero or more reasoning blocks followed by exactly one text block/)

  const closed = validateReviewOutput(closedChunks())
  assert.equal(closed.ok, false)
  assert.match(closed.error.message, /reviewer ended with error STREAM_CLOSED: closed/)

  const noFinish = validateReviewOutput([{ type: 'text-delta', index: 0, text: '{}' }])
  assert.equal(noFinish.ok, false)
  assert.match(noFinish.error.message, /no terminal finish/)

  const trailing = validateReviewOutput([...allowChunks(), { type: 'text-delta', index: 2, text: 'more' }])
  assert.equal(trailing.ok, false)
  assert.match(trailing.error.message, /data after its terminal finish/)

  const truncated = validateReviewOutput([
    { type: 'text-delta', index: 0, text: '{"risk":"low","decision":"allow"}' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  assert.equal(truncated.ok, false)
  assert.match(truncated.error.message, /ended with max-tokens/)

  const unknownRisk = validateReviewOutput([
    { type: 'text-delta', index: 0, text: '{"risk":"high","decision":"allow"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(unknownRisk.ok, false)
  assert.match(unknownRisk.error.message, /does not match the risk\/decision protocol/)
})

test('parseReviewDecision accepts the fixed combinations', () => {
  assert.deepEqual(parseReviewDecision('{"risk":"low","decision":"allow"}'), { risk: 'low', decision: 'allow' })
  assert.deepEqual(parseReviewDecision('{"risk":"medium","decision":"allow"}'), { risk: 'medium', decision: 'allow' })
  assert.deepEqual(parseReviewDecision('{"risk":"high","decision":"deny"}'), { risk: 'high', decision: 'deny' })
  assert.deepEqual(parseReviewDecision('{"risk":"medium","decision":"deny","reason":"writes outside"}'), {
    risk: 'medium',
    decision: 'deny',
    reason: 'writes outside',
  })
  assert.throws(() => parseReviewDecision('not json'), /JSON/)
  assert.throws(() => parseReviewDecision('[1,2]'), /one JSON object/)
  assert.throws(() => parseReviewDecision('{"risk":"low","decision":"deny"}'), /protocol/)
  assert.throws(() => parseReviewDecision('{"risk":"low","decision":"allow","risk":"low"}'), /repeats a JSON member/)
})

test('planReviewAttempts keeps the session route first and falls back once', () => {
  const options = reviewOptions()
  const config = normalizeConfig({}, ENV)
  const plan = planReviewAttempts(options, config)
  assert.equal(plan.length, 2)
  assert.equal(plan[0].route, 'session')
  assert.equal(plan[0].options, options, 'session attempt passes the original options through')
  assert.equal(plan[1].route, 'fallback')
  assert.equal(plan[1].options.provider, 'deepseek-account')
  assert.equal(plan[1].options.model, 'deepseek-flash')
  assert.equal(options.provider, 'custom-route', 'original untouched')

  const retried = planReviewAttempts(options, normalizeConfig({ retries: 2 }, ENV))
  assert.deepEqual(retried.map((attempt) => attempt.route), ['session', 'session', 'session', 'fallback'])

  const fixed = planReviewAttempts(options, normalizeConfig({ route: 'fixed' }, ENV))
  assert.deepEqual(fixed.map((attempt) => attempt.route), ['fixed', 'fallback'])
  assert.equal(fixed[0].options.provider, 'deepseek-account')

  const noFallback = planReviewAttempts(options, normalizeConfig({ fallbackProvider: '' }, ENV))
  assert.deepEqual(noFallback.map((attempt) => attempt.route), ['session'])
})

test('attemptingStream passes a healthy session attempt straight through', async () => {
  const attempts = planReviewAttempts(reviewOptions(), normalizeConfig({}, ENV))
  let opened = 0
  const chunks = await collect(
    attemptingStream(
      () => {
        opened += 1
        return streamOf(allowChunks())
      },
      attempts,
    ),
  )
  assert.equal(opened, 1, 'a compliant reviewer never reaches the fallback')
  assert.deepEqual(chunks, allowChunks())
})

test('attemptingStream retries a protocol-breaking route on the fallback', async () => {
  const attempts = planReviewAttempts(reviewOptions(), normalizeConfig({}, ENV))
  const seen = []
  const failures = []
  const chunks = await collect(
    attemptingStream(
      (options) => {
        seen.push(`${options.provider}/${options.model}`)
        return streamOf(options.provider === 'custom-route' ? proseChunks() : allowChunks())
      },
      attempts,
      { onFailure: (attempt, error) => failures.push(error.message) },
    ),
  )
  assert.deepEqual(seen, ['custom-route/DeepSeek-V4.1-Flash', 'deepseek-account/deepseek-flash'])
  assert.equal(failures.length, 1)
  assert.match(failures[0], /exactly one text block/)
  assert.deepEqual(chunks, allowChunks())
})

test('attemptingStream retries a stream error on the fallback', async () => {
  const attempts = planReviewAttempts(reviewOptions(), normalizeConfig({}, ENV))
  let opened = 0
  const chunks = await collect(
    attemptingStream(
      () => {
        opened += 1
        return streamOf(opened === 1 ? closedChunks() : allowChunks())
      },
      attempts,
    ),
  )
  assert.equal(opened, 2)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('attemptingStream throws the last real cause when every route fails', async () => {
  const attempts = planReviewAttempts(reviewOptions(), normalizeConfig({}, ENV))
  await assert.rejects(
    () => collect(attemptingStream(() => streamOf(proseChunks()), attempts)),
    /auto-review: reviewer must emit zero or more reasoning blocks/,
  )
})

test('attemptingStream never retries a cancelled call', async () => {
  const attempts = planReviewAttempts(reviewOptions(), normalizeConfig({}, ENV))
  let opened = 0
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () =>
      collect(
        attemptingStream(
          () => {
            opened += 1
            const abort = new Error('aborted')
            abort.name = 'AbortError'
            throw abort
          },
          attempts,
          { aborted: () => true },
        ),
      ),
    /aborted/,
  )
  assert.equal(opened, 1)
})

test('apply keeps the session route and leaves every other call alone', async () => {
  const h = harness({ respond: () => streamOf(allowChunks()) })
  apply(h.ctx, { auditPath: tempAudit() })

  const normal = { system: 'You are an agent', messages: [] }
  h.llm.stream(normal)
  assert.equal(h.calls.at(-1).options, normal)
  assert.equal(h.calls.at(-1).options.provider, undefined)

  const options = reviewOptions()
  const chunks = await collect(h.llm.stream(options))
  assert.equal(h.calls.length, 2, 'one underlying review call')
  assert.equal(h.calls.at(-1).options.provider, 'custom-route', 'the session route is kept')
  assert.equal(h.calls.at(-1).options.model, 'DeepSeek-V4.1-Flash')
  assert.equal(h.calls.at(-1).options.system, options.system, 'the fixed policy is preserved')
  assert.deepEqual(chunks, allowChunks())
})

test('apply falls back to deepseek-account when the session route cannot review', async () => {
  const auditPath = tempAudit()
  const h = harness({
    respond: (options) => streamOf(options.provider === 'custom-route' ? proseChunks() : allowChunks()),
  })
  apply(h.ctx, { auditPath })

  const chunks = await collect(h.llm.stream(reviewOptions()))
  assert.deepEqual(
    h.calls.map((call) => `${call.options.provider}/${call.options.model}`),
    ['custom-route/DeepSeek-V4.1-Flash', 'deepseek-account/deepseek-flash'],
  )
  assert.deepEqual(chunks, allowChunks(), 'the fallback output is what the integration sees')
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0], /retried on deepseek-account\/deepseek-flash/)

  const record = JSON.parse(readFileSync(auditPath, 'utf8').trim().split('\n').at(-1))
  assert.equal(record.kind, 'route-fallback')
  assert.deepEqual(record.from, { provider: 'custom-route', model: 'DeepSeek-V4.1-Flash' })
  assert.deepEqual(record.to, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.match(record.reason, /exactly one text block/)
})

test('route: fixed still pins the primary route', async () => {
  const h = harness({ respond: () => streamOf(allowChunks()) })
  apply(h.ctx, { auditPath: tempAudit(), route: 'fixed' })
  await collect(h.llm.stream(reviewOptions()))
  assert.equal(h.calls.at(-1).options.provider, 'deepseek-account')
  assert.equal(h.calls.at(-1).options.model, 'deepseek-flash')
})

test('legacy inheritRoute alias still selects the session route', async () => {
  const h = harness({ respond: () => streamOf(allowChunks()) })
  apply(h.ctx, { auditPath: tempAudit(), inheritRoute: true })
  await collect(h.llm.stream(reviewOptions()))
  assert.equal(h.calls.at(-1).options.provider, 'custom-route')

  const pinned = harness({ respond: () => streamOf(allowChunks()) })
  apply(pinned.ctx, { auditPath: tempAudit(), inheritRoute: false })
  await collect(pinned.llm.stream(reviewOptions()))
  assert.equal(pinned.calls.at(-1).options.provider, 'deepseek-account')
})

test('a disabled fallback route leaves the session attempt alone', async () => {
  const h = harness({ respond: () => streamOf(proseChunks()) })
  apply(h.ctx, { auditPath: tempAudit(), fallbackProvider: '' })
  const chunks = await collect(h.llm.stream(reviewOptions()))
  assert.equal(h.calls.length, 1)
  assert.deepEqual(chunks, proseChunks(), 'stock behaviour when nothing can be retried')
})

test('the gate watchdog converts integration failures into the fallback', async () => {
  const auditPath = tempAudit()
  const h = harness()
  apply(h.ctx, { auditPath, fallback: 'ask' })
  const entry = h.handlers.get('tools/pre-execute').at(-1)
  assert.equal(entry.listenOptions.prepend, true, 'must run before the integration gate')

  const decision = await entry.handler(
    { name: 'ops_bash', callId: 'c1', agent: { session: { id: 's1' } } },
    () =>
      Promise.reject(
        new Error('auto-review: reviewer must emit zero or more reasoning blocks followed by exactly one text block'),
      ),
  )
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /Auto review is unavailable/)
  assert.equal(h.warnings.length, 1)
  const record = JSON.parse(readFileSync(auditPath, 'utf8').trim().split('\n').at(-1))
  assert.equal(record.kind, 'gate-fallback')
  assert.equal(record.tool, 'ops_bash')
  assert.equal(record.fallback, 'ask')
})

test('the watchdog rethrows everything else and passes healthy decisions through', async () => {
  const h = harness()
  apply(h.ctx, { auditPath: tempAudit() })
  const entry = h.handlers.get('tools/pre-execute').at(-1)

  await assert.rejects(
    () => entry.handler({ name: 'ops_bash' }, () => Promise.reject(new Error('sandbox denied'))),
    /sandbox denied/,
  )

  const allowed = { kind: 'allow' }
  assert.deepEqual(
    await entry.handler({ name: 'ops_bash' }, () => Promise.resolve(allowed)),
    allowed,
  )
})

test('fallback modes are honoured', async () => {
  const h = harness()
  apply(h.ctx, { auditPath: tempAudit(), fallback: 'allow' })
  const entry = h.handlers.get('tools/pre-execute').at(-1)
  assert.deepEqual(await entry.handler({ name: 'x' }, () => Promise.reject(new Error('auto-review: boom'))), {
    kind: 'allow',
  })
})

test('disabled config installs nothing', () => {
  const h = harness()
  apply(h.ctx, { enabled: false, auditPath: tempAudit() })
  assert.equal(h.handlers.size, 0)
  const original = h.llm.stream
  h.llm.stream(reviewOptions())
  assert.equal(h.calls.at(-1).options.provider, 'custom-route', 'stock behaviour untouched')
  assert.equal(typeof original, 'function')
})

test('dispose restores the original stream', async () => {
  const h = harness({ respond: () => streamOf(allowChunks()) })
  apply(h.ctx, { auditPath: tempAudit() })
  const patched = h.llm.stream
  assert.notEqual(patched.name, 'stream')
  for (const disposer of h.disposers) disposer()
  await collect(h.llm.stream(reviewOptions()))
  assert.equal(h.calls.at(-1).options.provider, 'custom-route', 'the wrapper is gone after dispose')
})

test('config normalisation', () => {
  const config = normalizeConfig(undefined, ENV)
  assert.equal(config.enabled, true)
  assert.equal(config.route, 'session')
  assert.equal(config.provider, undefined)
  assert.equal(config.model, undefined)
  assert.equal(config.fallbackProvider, 'deepseek-account')
  assert.equal(config.fallbackModel, 'deepseek-flash')
  assert.equal(config.retries, 0)
  assert.equal(config.fallback, 'ask')

  const fixed = normalizeConfig({ route: 'fixed' }, ENV)
  assert.equal(fixed.route, 'fixed')
  assert.equal(fixed.provider, 'deepseek-account')
  assert.equal(fixed.model, 'deepseek-flash')

  const inherited = normalizeConfig({ inheritRoute: true }, ENV)
  assert.equal(inherited.route, 'session')
  assert.equal(inherited.provider, undefined)

  const custom = normalizeConfig(
    { fallback: 'allow', retries: 9, fallbackProvider: '  ', auditPath: '~/x/a.jsonl' },
    ENV,
  )
  assert.equal(custom.fallback, 'allow')
  assert.equal(custom.retries, 3)
  assert.equal(custom.fallbackProvider, 'deepseek-account', 'blank keeps the default')
  assert.ok(custom.auditPath.startsWith('C:\\Users\\test'))

  const off = normalizeConfig({ fallbackProvider: '', fallbackModel: '' }, ENV)
  assert.equal(off.fallbackProvider, undefined)
  assert.equal(off.fallbackModel, undefined)
})

test('audit never throws on an unwritable path', () => {
  assert.doesNotThrow(() => audit({ auditPath: join('\0', 'nope.jsonl') }, { kind: 'x' }))
  const path = tempAudit()
  audit({ auditPath: path }, { kind: 'probe', tool: 'ops_bash' })
  assert.ok(existsSync(path))
  rmSync(path, { force: true })
})

test('wrapping twice keeps a single hop', async () => {
  const h = harness({ respond: () => streamOf(allowChunks()) })
  apply(h.ctx, { auditPath: tempAudit() })
  const once = wrapReviewStream(h.ctx, normalizeConfig({}, ENV))
  assert.equal(once, true)
  await collect(h.llm.stream(reviewOptions()))
  assert.equal(h.calls.length, 1, 'one underlying call per review')
  installGateWatchdog(h.ctx, normalizeConfig({}, ENV))
  assert.equal(h.handlers.get('tools/pre-execute').length, 2, 'gate is added per apply call')
})
