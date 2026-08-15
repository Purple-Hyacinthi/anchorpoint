/**
 * Anchored tool bootstrap — keep the FIRST model request on the Minimal
 * preset's REAL tool schema (persistent `bash` + `str_replace_editor`), free
 * of auto-injected workspace/skill context, then narrow the catalog to a
 * minimal RESIDENT set once the session has produced its first durable
 * promotion signal.
 *
 * The phase is derived from durable session events, so resume and reload
 * preserve it. By default (`promoteOn: 'either'`) a session promotes after the
 * first `tool/call` OR the first `assistant/message`, whichever comes first:
 * request #1 always sees the bootstrap catalog and request #2 always sees the
 * resident catalog. The original `'tool-call'` mode is kept for compatibility,
 * but it can trap a session in bootstrap forever when the first model reply
 * makes no tool call — the `'either'` default removes that trap while keeping
 * the first-request anchor intact.
 *
 * @module preset/tool-bootstrap
 */
import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * First-request conditions established by the reproduction work (issues #6
 * and #11, 2026-08-15):
 *
 *  1. Tool schema. The API-visible first-request catalog decides whether the
 *     session anchors on the Minimal trajectory. At the adapter-default
 *     maxTokens (256000 on the official endpoint) the Minimal tool pair —
 *     persistent `bash` + `str_replace_editor` — anchored 5/5 runs with zero
 *     `let me` first-lines, while every standard-family schema (pwsh/read,
 *     pwsh only, sandboxed bash/read) fell into standard-like behavior
 *     (11/11). Bootstrap therefore exposes exactly the Minimal pair, not
 *     Standard's `pwsh`/`read`.
 *
 *  2. Output budget. On the official endpoint the first request's `max_tokens`
 *     also dominated the trajectory anchor at 1024 (`We need` style in 26/32
 *     runs against 0/5 at 256000, independent of tool descriptions). The
 *     Minimal tool schema, however, anchors at 256000 WITHOUT any cap, and the
 *     cap's delivery depends on the profile package's `prepareCall` behavior
 *     (it reaches the request on the 0.1.0-rc.5 source checkout; a prebuilt
 *     rc.6-reporting profile package observed in issue #11 overwrote it with
 *     `adapterDefaults.maxTokens`). `bootstrapMaxTokens` is therefore OPT-IN:
 *     leave it unset to run the Minimal schema at the adapter default, or set
 *     it to cap the first request. When set, the cap is stripped after
 *     promotion — the next request's seed proposal carries the previous
 *     header's maxTokens forward, so the release must be explicit.
 *
 *  3. Injected reminders. dsh-agent-instructions and dsh-tool-skill inject
 *     workspace instructions (AGENTS.md) and the skill catalog into the first
 *     step as user messages whenever such content exists. With the skill
 *     catalog present the anchor did not reproduce at all (0/9); without it
 *     the same request reproduces at ~81%. Both message kinds are therefore
 *     stripped during bootstrap and allowed again after promotion. The
 *     stripped set is configurable via `suppressedContextSources` (default
 *     `['skill-catalog', 'agent-instructions']`); an explicitly empty array
 *     disables the context filter while keeping the tool bootstrap. A
 *     user-initiated skill gesture (`skill-invocation`) is NOT in the default
 *     set: it is not an automatic injection, and stripping it would lose the
 *     skill content once the gesture scrolls out of the per-step claim.
 *
 * POST-PROMOTION RESIDENT SET (local addition, user-measured): the promoted
 * phase does NOT dump the whole Standard catalog at once — that dump pulls
 * the trajectory back to standard-like behavior (the root cause of the
 * post-promotion regression measured on the zero variant). Instead the
 * catalog narrows to the bootstrap tool pair PLUS the discovery tools
 * (`dev_tool_search`, `skill_search`, `skill_load` — each skipped silently
 * when a composition does not mount it) PLUS the configured `residentTools`
 * PLUS whatever the model explicitly unlocked via `dev_tool_search`. Heavier
 * Standard tools (web_search, subagent, workflow, …) are one
 * `dev_tool_search` call away; unlocked names are derived from durable
 * `tool/call` events, so resume and reload keep them.
 * read/write/edit/glob/grep/todo/ask are deliberately NOT resident:
 * bash + str_replace_editor cover file work.
 *
 * `residentTools` (default `[]`) is the SKILLS seam: a composition that keeps
 * the official `dsh-tool-skill` mounted sets `residentTools: [skill]` so the
 * loader tool stays resident after promotion (see the anchored-standard-skills
 * variant). The skill CATALOG reminder is still deferred past the anchor —
 * the pre-step strip below suppresses the `skill-catalog` source on
 * request #1 and lets it return from request #2, which is the "load the skill
 * plugin's context last" effect implemented as a phase gate. YAML row
 * position cannot do this: the cordis-plugin-loader applies rows
 * concurrently (EntryGroup.update → Promise.allSettled), so moving skill rows
 * to the bottom of agent.cordis.yml changes nothing about listener order.
 *
 * COMPACTION (local addition): a compaction rewrites the whole surface, so the
 * first post-compaction request is a "second first request". Promotion is
 * epoch-aware (see compaction-epoch.mjs): after `compaction/end` the session
 * falls back to the controlled phase — the bootstrap pair plus
 * `compactionTools` (a core work set, default none) — until a NEW durable
 * promotion signal exists past that boundary. The model is mid-task and needs
 * to keep working, but still faces a small catalog instead of the full
 * Standard set.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process; the
 *    durable event scan runs once per session per process, then O(1).
 *  - Subagents (delegationDepth > 0) are always promoted (resident catalog).
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of throwing, so a composition drift can never brick
 *    every request of a session.
 *  - The pre-step context filter degrades to "keep everything" on failure:
 *    a filter bug must never eat the user's context.
 *  - Invalid config (bad tool lists, unknown `promoteOn`, malformed
 *    `suppressedContextSources`, non-positive `bootstrapMaxTokens`) fails at
 *    apply time, i.e. at preset mount, where it is visible and fixable.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Row position alone cannot order plugins anyway — the
 * cordis-plugin-loader applies composition rows concurrently
 * (`EntryGroup.update` runs `Promise.allSettled` over every row), so
 * dsh-agent-instructions and dsh-tool-skill may register before or after this
 * plugin regardless of YAML order. The ordering guarantee comes from Cordis
 * listener registration instead: the pre-step listener below registers with
 * `prepend: true`, which unshifts it to the FRONT of the listener list, and
 * waterfall after-next transforms apply in reverse — so the first-request
 * strip is the OUTERMOST transform and actually removes what later listeners
 * inject, against host-plane listeners and future row reordering alike.
 * (With an inject here those plugins would additionally re-inject their
 * messages after the strip.)
 */
export const inject = []

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['bootstrapTools', 'promoteOn', 'bootstrapMaxTokens', 'suppressedContextSources', 'zhBridgeText', 'bridgeTrace', 'compactionTools', 'residentTools'])

/**
 * Context sources stripped from the first request by default. These are
 * automatic `agent/pre-step` injections: the available-skills reminder
 * (`skill-catalog`), the AGENTS.md/CLAUDE.md workspace digest
 * (`agent-instructions`), and the approval-policy STARTUP notice
 * (`plugin:user-approval` — the host approval stack emits "The approval
 * policy changed from …" once when the saved policy is applied to a new
 * session; in a blank session it is pure noise). True Minimal mounts none
 * of these. A `kind:plugin` entry matches the exact plugin only; plugin
 * messages from other sources pass through. A genuine mid-session policy
 * switch still reaches the model because promotion has already happened
 * by then (the strip only runs during bootstrap).
 */
const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions', 'plugin:user-approval']

/**
 * The CJK bridge prepended to the FIRST user message during bootstrap when
 * that message contains Han script. Measured language effect: with identical
 * anchor conditions (46-char persona, 2 tools, user-only request), English
 * tasks open the first reasoning block with the emergent `We need to …`
 * (3/5 in the headless lab) while Chinese tasks open with a translation
 * preamble (`The user is speaking Chinese: …`; 4/4 in GUI tests) — the
 * anchor window is consumed by task comprehension. The bridge states the
 * language facts in a `We need` framing, forbids the translation preamble,
 * AND explicitly instructs the reasoning opener to be a `We need to`
 * sentence. Measured: v1 (framing only) anchored 1/3 (puzzles, ignored by
 * coding tasks); v2 (framing + anti-preamble clause) still lost programming
 * tasks; v3 makes the anchor explicit. An empty string disables the bridge
 * entirely (pure-Minimal surface).
 */
const DEFAULT_ZH_BRIDGE = 'We need to fulfill the request below. (The user wrote in Chinese — reply in Chinese.) Begin your reasoning with a sentence that starts with "We need to" describing the work ahead; do not open with a restatement or translation of the request.'

/** Han-script detection for the bridge trigger (Unicode property escapes). */
const HAN_PATTERN = /\p{Script=Han}/u

/**
 * The default first-request catalog: the OFFICIAL Minimal preset's exact tool
 * pair — the persistent `bash` shell and `str_replace_editor`. Issue #11
 * measured this schema anchoring 5/5 at the adapter-default maxTokens while
 * every standard-family schema failed 11/11.
 */
const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** Discovery tools always resident after promotion (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Validate the suppressed context sources. Unlike the bootstrap tool lists,
 * an explicitly empty array is meaningful: it disables the context filter
 * while keeping the tool bootstrap.
 */
function sourceList(value, field, fallback) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return new Set(value)
}

/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens, and the
 * cap's delivery is profile-package dependent (see the header note), so it is
 * opt-in rather than the default.
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/** The CJK bridge text: a string, or the empty string to disable it. */
function validateZhBridge(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name}: zhBridgeText must be a string (empty string disables the bridge)`)
  }
  return value
}

/** The text blocks of a message, defensively read. */
function textBlocksOf(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return []
  return message.content.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
}

/** Whether any text block of the message contains Han script. */
function containsHan(message) {
  return textBlocksOf(message).some((block) => HAN_PATTERN.test(block.text))
}

/**
 * Merge the CJK bridge ahead of the first user message's first text block.
 * Returns a NEW message object; the original is never mutated.
 */
function bridgeMessage(message, bridgeText) {
  const blocks = Array.isArray(message.content) ? [...message.content] : []
  const firstText = blocks.findIndex((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
  if (firstText === -1) {
    blocks.unshift({ type: 'text', text: bridgeText })
  } else {
    blocks[firstText] = { type: 'text', text: `${bridgeText}\n\n${blocks[firstText].text}` }
  }
  return { ...message, content: blocks }
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }
  const bootstrapTools = stringList(source.bootstrapTools, 'bootstrapTools')
  const promoteEvents = parsePromoteOn(source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const suppressedSources = sourceList(source.suppressedContextSources, 'suppressedContextSources', DEFAULT_SUPPRESSED_SOURCES)
  // The CJK bridge for the first request. `undefined` falls back to the
  // default text; an explicit empty string disables the bridge.
  const zhBridgeText = source.zhBridgeText === undefined ? DEFAULT_ZH_BRIDGE : validateZhBridge(source.zhBridgeText)
  // Optional first-request trace to <DSH_HOME>/bridge-trace.jsonl — proves
  // which generation and bridge version a GUI session actually ran on.
  if (source.bridgeTrace !== undefined && typeof source.bridgeTrace !== 'boolean') {
    throw new TypeError(`${name}: bridgeTrace must be a boolean`)
  }
  const bridgeTrace = source.bridgeTrace === true
  // Core work set exposed after a compaction, before re-promotion. Empty
  // means "no compaction recovery catalog": the session stays on the
  // bootstrap pair until a new promotion signal.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')
  // Extra tool names always kept in the promoted resident set on top of the
  // discovery tools — the SKILLS seam: a composition that mounts the official
  // `dsh-tool-skill` sets `residentTools: [skill]`. Empty means no extras.
  const residentTools = stringListOrEmpty(source.residentTools, 'residentTools')

  const promotion = createEpochPromotion(promoteEvents)
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Diagnostic trace of the first-request bridge decision, appended to
   * `<DSH_HOME>/bridge-trace.jsonl` only when `bridgeTrace: true` is set.
   * The pre-step assembly is not durable, so this file is the only way to
   * prove which generation/bridge version a live session actually ran on.
   * Fire-and-forget; a trace failure must never affect the request.
   */
  const trace = (record) => {
    if (!bridgeTrace) return
    try {
      const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh')
      appendFile(join(home, 'bridge-trace.jsonl'), `${JSON.stringify(record)}\n`, 'utf8').catch(() => {})
    } catch {
      // Ignore: tracing is optional diagnostics.
    }
  }

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. The event's `arguments` is the raw JSON string the model produced;
   * we parse it defensively and read the `toolNames` array.
   */
  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined || !Array.isArray(session.events)) return unlocked
    for (const event of session.events) {
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
    }
    return unlocked
  }

  /**
   * Narrow the assembled catalog to a required keep-set; when any required
   * name is missing the whole catalog stays exposed with a one-time warning,
   * so a composition drift can never brick every request of a session.
   */
  const keepToolsOrFullCatalog = (assembled, keep) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const missing = [...keep].filter((toolName) => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + 'bootstrap disabled, full catalog exposed',
      )
      return assembled
    }
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keep.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        // PROMOTED: keep the minimal resident set — the bootstrap pair + the
        // discovery tools + the configured residentTools + whatever the model
        // explicitly unlocked via dev_tool_search — instead of dumping the
        // whole Standard catalog at once (the post-promotion regression fix;
        // see the header note). Discovery tools and residentTools that the
        // composition does not mount are skipped silently; only a missing
        // bootstrap tool is drift worth warning about.
        const available = new Set(assembled.tools.map((tool) => tool.name))
        const missingBootstrap = bootstrapTools.filter((toolName) => !available.has(toolName))
        if (missingBootstrap.length > 0) {
          warnOnce(
            `${name}: promoted phase missing bootstrap tool(s) ${JSON.stringify(missingBootstrap)} — `
            + 'continuing with what is available',
          )
        }
        const desired = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...residentTools, ...unlockedFor(context.agent?.session)])
        const keep = new Set([...desired].filter((toolName) => available.has(toolName)))
        return {
          ...assembled,
          tools: assembled.tools.filter((tool) => keep.has(tool.name)),
        }
      }
      // Controlled phase: the bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue.
      const { boundary } = status
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      return keepToolsOrFullCatalog(assembled, keep)
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Unset (`bootstrapMaxTokens` omitted) means the adapter default flows — the
  // Minimal tool schema anchors at 256000 without a cap (issue #11).
  if (bootstrapMaxTokens !== undefined) {
    // Same registration discipline as the pre-step strip below: `prepend`
    // keeps this listener the OUTERMOST transform of the agent/request
    // waterfall for the same registration-order reasons (loader row
    // application is concurrent; row order alone does not decide listener
    // order — see issue #6 and upstream PR #13), so a later listener can
    // never override the first-round budget after we set it.
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        // The next request's seed proposal carries the previous header's
        // maxTokens forward, so the injected cap must be stripped explicitly —
        // otherwise it would persist for the whole session.
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }

  // Strip first-step injected reminders (skill catalog, AGENTS.md) during
  // bootstrap. Because this listener is the first registered (see the inject
  // note, the row order in agent.cordis.yml, and `prepend` below), the strip
  // is the final waterfall transform and actually removes what later
  // listeners inject.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (!Array.isArray(decision.messages)) return decision
      const promoted = promotion.status(agent).promoted
      if (promoted) return decision
      let messages = decision.messages
      // CJK bridge: pull the first reasoning block back into the `We need`
      // planning style for Han-script tasks (see DEFAULT_ZH_BRIDGE).
      let bridgeApplied = false
      let bridgeReason = zhBridgeText.length === 0 ? 'bridge-disabled' : 'pending'
      if (zhBridgeText.length > 0) {
        const first = messages.findIndex((message) => message?.source?.kind === 'user')
        if (first === -1) bridgeReason = 'no-user-message'
        else if (!containsHan(messages[first])) bridgeReason = 'no-han'
        else if (textBlocksOf(messages[first]).some((block) => block.text.startsWith(zhBridgeText))) bridgeReason = 'already-bridged'
        else {
          messages = [...messages]
          messages[first] = bridgeMessage(messages[first], zhBridgeText)
          bridgeApplied = true
          bridgeReason = 'applied'
        }
      }
      trace({
        ts: Date.now(),
        session: agent?.session?.id,
        bridgeVersion: 3,
        bridgeLen: zhBridgeText.length,
        applied: bridgeApplied,
        reason: bridgeReason,
        firstKinds: decision.messages.slice(0, 3).map((message) => message?.source?.kind ?? '?'),
        firstUserHead: JSON.stringify(textBlocksOf(decision.messages.find((message) => message?.source?.kind === 'user') ?? {})[0]?.text ?? '').slice(0, 100),
      })
      if (suppressedSources.size > 0) {
        const kept = messages.filter((message) => {
          const source = message?.source
          if (typeof source?.kind !== 'string') return true
          if (suppressedSources.has(source.kind)) return false
          const plugin = typeof source.plugin === 'string' ? source.plugin : ''
          if (plugin.length > 0 && suppressedSources.has(`${source.kind}:${plugin}`)) return false
          return true
        })
        if (kept.length !== messages.length) messages = kept
      }
      return messages === decision.messages ? decision : { ...decision, messages }
    } catch (error) {
      // A filter bug must never eat context: degrade to keeping every message.
      warnOnce(`${name}: pre-step context transform failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
