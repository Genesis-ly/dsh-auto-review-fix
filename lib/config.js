/**
 * dsh-auto-review-fix — configuration normalisation.
 *
 * @module dsh-auto-review-fix/config
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/**
 * Defaults: review on the session's own route, fall back to the official
 * account route only when that route cannot serve a review, and ask the human
 * when even the fallback is broken.
 */
export const DEFAULTS = {
  enabled: true,
  route: 'session',
  provider: undefined,
  model: undefined,
  fallbackProvider: 'deepseek-account',
  fallbackModel: 'deepseek-flash',
  retries: 0,
  fallback: 'ask',
  auditPath: '~/.dsh/dsh-auto-review-fix/audit.jsonl',
}

/** Accepted fallback modes. */
export const FALLBACK_MODES = ['ask', 'allow', 'deny']

/** Accepted primary-route modes. */
export const ROUTE_MODES = ['session', 'fixed']

/**
 * Collapse `.`/`..` segments so logged paths stay readable.
 * @param {string} path - absolute path.
 * @returns {string} normalised path.
 */
export function normalizePath(path) {
  if (typeof path !== 'string' || path === '') return ''
  const win = /^[A-Za-z]:/.test(path) || path.includes('\\')
  const separator = win ? '\\' : '/'
  const out = []
  for (const part of path.split(/[\\/]+/)) {
    if (part === '' && out.length === 0) continue
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(part)
  }
  const head = out.length > 0 ? out[0] : ''
  const tail = out.slice(1).join(separator)
  return tail === '' ? head : `${head}${separator}${tail}`
}

/**
 * Trimmed string or undefined.
 * @param {unknown} value - raw config value.
 * @returns {string|undefined} trimmed value.
 */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Build the runtime config the plugin uses.
 * @param {unknown} raw - config object from the cordis patch layer.
 * @param {NodeJS.ProcessEnv} [env] - environment source (tests).
 * @returns {object} normalised config.
 */
export function normalizeConfig(raw, env = process.env) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const home = env.DSH_AUTO_REVIEW_FIX_HOME ?? homedir()
  const auditRaw = text(source.auditPath) ?? DEFAULTS.auditPath
  const expanded = auditRaw.replace(/^~(?=$|[\\/])/, home)
  // `route` is the current switch; `inheritRoute` stays accepted as the old alias.
  const route =
    source.route === 'fixed' || source.inheritRoute === false
      ? 'fixed'
      : source.route === 'session' || source.inheritRoute === true
        ? 'session'
        : DEFAULTS.route
  const fallbackProvider = source.fallbackProvider === '' ? undefined : (text(source.fallbackProvider) ?? DEFAULTS.fallbackProvider)
  const fallbackModel = source.fallbackModel === '' ? undefined : (text(source.fallbackModel) ?? DEFAULTS.fallbackModel)
  return {
    enabled: source.enabled !== false,
    route,
    provider: route === 'fixed' ? (text(source.provider) ?? 'deepseek-account') : undefined,
    model: route === 'fixed' ? (text(source.model) ?? 'deepseek-flash') : undefined,
    fallbackProvider,
    fallbackModel,
    retries:
      typeof source.retries === 'number' && Number.isFinite(source.retries) && source.retries >= 0
        ? Math.min(3, Math.floor(source.retries))
        : DEFAULTS.retries,
    fallback: FALLBACK_MODES.includes(/** @type {string} */ (source.fallback)) ? /** @type {string} */ (source.fallback) : DEFAULTS.fallback,
    auditPath: normalizePath(isAbsolute(expanded) ? expanded : resolve(home, expanded)),
  }
}
