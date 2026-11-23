# Auto review fails closed: three distinct reviewer failures block every tool call

**Status:** reproducible on DSH 0.2.2-rc.5 with `@deepseek-ai/dsh-experimental-auto-review`.
**Fix in this repo:** [`dsh-auto-review-fix`](../../README.md)

## Symptom

With the *Auto review* permission preset enabled, ordinary commands stop working. The tool call is
rejected with an `auto-review:` error even though the action is harmless (`echo hi` is enough).
Because `tools/pre-execute` throws, the whole tool pipeline fails closed — the session is stuck
until the user switches back to another preset.

## What the logs show

Across 45 real sessions, 86 blocked tool results fall into three classes. They look alike to the
user but have different causes.

| class | exact error | evidence in the request | root cause |
| --- | --- | --- | --- |
| A | `auto-review: reviewer must emit zero or more reasoning blocks followed by exactly one text block` | `provider=custom-route model=DeepSeek-V4.1-Flash tools=101 hasTool=true` | the reviewer call **reuses the main session's provider**; a third-party route does not follow the review protocol (it emits ordinary prose or several text blocks), so shape validation always fails. `Unexpected token 'I'` (main-session prose parsed as a verdict) has the same origin |
| B | `auto-review: reviewer ended with error STREAM_CLOSED: …` | `provider=deepseek-account model=deepseek-flash` | transient upstream stream close; the integration **never retries** |
| C | `auto-review: the pending native tool schema is missing or ambiguous` | `provider=deepseek-account … tools=142 hasTool=false` | `session.requestHeader()` can point at a non-chat request (title generation or compaction); the tool schema is not in that header, so building the snapshot fails |

A and B can be fixed at the LLM-call layer. C throws *before* the call, so it needs a gate-level
fallback.

## Fix

Two service wrappers; no vendor file is modified, so it survives plugin/app updates.

### 1. Reviewer route: session first, fallback only on failure

Wrap `ctx.llm.stream` and only touch calls whose system prompt contains the fixed reviewer text
(`You are the final authorization reviewer`); everything else passes through untouched.

- **First attempt uses the call parameters verbatim** — the reviewer uses the same provider/model as
  the session.
- Each attempt is pre-validated against the integration's own acceptance rules: a terminating
  `finish`, `stop` reason, zero or more reasoning blocks followed by exactly one text block, and
  text that parses as the closed risk/decision protocol. If not, that route counts as unusable.
- Only then retry once with a fixed fallback route (default `deepseek-account` / `deepseek-flash`).
  `retries` controls extra attempts on the primary route.
- If every attempt fails, throw the last real error and let the gate fallback decide.

### 2. Gate fallback

`prepend` a `tools/pre-execute` hook so it runs before the integration and can catch its exception.
Only `auto-review:`-prefixed errors are converted — by default into `ask`, i.e. the normal approval
prompt (one click), not a failed tool call. Exceptions from other plugins are re-thrown untouched.

Every route fallback and every gate fallback writes one line to
`~/.dsh/dsh-auto-review-fix/audit.jsonl`.

## Configuration

```yaml
- id: dsh-auto-review-fix
  config:
    enabled: true
    route: session                   # session (default) | fixed
    fallbackProvider: deepseek-account
    fallbackModel: deepseek-flash
    retries: 0                       # extra attempts on the primary route
    fallback: ask                    # ask (default) | allow | deny
    auditPath: '~/.dsh/dsh-auto-review-fix/audit.jsonl'
```

`allow` bypasses review and must only be used on a machine you fully control; `deny` keeps the old
fail-closed behaviour but with a clearer message.

## Suggested upstream changes

1. Do not inherit the session's provider by default for the reviewer call; either pin a
   protocol-compatible route or validate adaptively.
2. Retry `STREAM_CLOSED` at least once before failing closed.
3. Handle the "pending request header is not a chat request" case in the integration itself, so a
   title/compaction request cannot break every tool call.
4. Convert reviewer failures into `ask` rather than throwing from `pre-execute` — a broken reviewer
   should degrade to a human decision, not to a dead session.
