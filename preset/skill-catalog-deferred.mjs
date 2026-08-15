/**
 * skill-catalog-deferred.mjs — preset-owned fallback for the available-skills
 * catalog injection. ZERO bare imports: user preset roots resolve no
 * node_modules, so this file inlines the three tiny helpers it needs
 * (message shape, catalog escaping, invocation policy) instead of importing
 * dsh-llm / dsh-skill.
 *
 * Why it exists: dsh-tool-skill emits the `<available_skills>` reminder only
 * when its internal identity check (`ctx.tools.get('skill', agent) === skillTool`)
 * resolves its own exact tool registration. Measured in the headless lab: with
 * the base layer's `skill` registration present (most profiles mount
 * dsh-tool-skill in dsh-base), that check fails for the preset's instance and
 * the official catalog listener silently never injects — the `skill` TOOL and
 * `/skill` gesture injection still work. With the base row disabled the
 * official listener injects normally, so the failure is the layering, not the
 * code path. This plugin performs the same catalog injection from the preset
 * itself, so the catalog is guaranteed to reach the model in both topologies.
 *
 * Cooperation rules:
 *  - It NEVER duplicates: if the decision already carries a `skill-catalog`
 *    message with the same digest, it leaves it alone. When the official
 *    plugin injects (web gateway), this plugin is a no-op.
 *  - Suppression stays with tool-bootstrap: `suppressedContextSources:
 *    [skill-catalog, ...]` strips the FIRST request's catalog (this plugin's
 *    or the official one's — the source kind is identical) and lets it return
 *    from request #2 on. That is the phase gate that keeps the anchor intact.
 *  - The catalog entries are rendered byte-identically to dsh-tool-skill's
 *    `renderCatalogMessage`, so the model sees the exact official reminder.
 */

import { createHash, randomUUID } from 'node:crypto'

export const name = 'skill-catalog-deferred'

/** No inject list: resolve everything at event time, like tool-bootstrap. */
export const inject = ['tools', 'skills']

const DEFAULT_DESCRIPTION_MAX_LENGTH = 500

/** Inline of @deepseek-ai/dsh-llm createUserMessage({content, source}). */
function createUserMessage(content, source) {
  return {
    id: `skill-catalog-deferred-${randomUUID()}`,
    role: 'user',
    content,
    source,
  }
}

/** Inline of dsh-skill isModelInvocable (summary.invocation.modelInvocable). */
function isModelInvocable(skill) {
  return skill.invocation?.modelInvocable === true
}

/** Minimal XML escaping matching dsh-skill escapeText for catalog lines. */
function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function boundedDescription(value, maxLength) {
  return String(value ?? '').slice(0, maxLength)
}

function catalogEntries(skills, maxLength) {
  return skills.map((skill) => ({
    name: skill.name,
    description: boundedDescription(skill.description, maxLength),
  }))
}

function digestOf(entries) {
  const canonical = entries.map((entry) => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

function renderEntries(entries) {
  return entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

/** Render the official first-catalog reminder, byte-identical to dsh-tool-skill. */
export function renderCatalogMessage(entries) {
  return createUserMessage([{
    type: 'text',
    text: [
      '<system-reminder>',
      'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
      '',
      '<available_skills>',
      ...renderEntries(entries),
      '</available_skills>',
      '',
      'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill\'s instructions until it has been loaded.',
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
      '</system-reminder>',
    ].join('\n'),
  }], { kind: 'skill-catalog', form: 'catalog', entries })
}

function readEntries(source) {
  const entries = source.entries
  if (!Array.isArray(entries)) return undefined
  const readable = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name, description } = entry
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    readable.push({ name, description })
  }
  return readable
}

function existingCatalogMessage(messages) {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const entries = readEntries(message.source)
    if (entries !== undefined) return { message, entries }
  }
  return undefined
}

/**
 * Mirror dsh-tool-skill's catalogHistory(agent): the digest of the newest
 * durable catalog event that is still visible on the session surface. When a
 * matching catalog is already visible, re-injecting it every step would
 * append a ~10KB duplicate per request; the official plugin skips, so do we.
 */
function visibleCatalogDigest(agent) {
  const session = agent?.session
  if (session === undefined) return undefined
  let visible
  try {
    visible = new Set(session.surface.nodes)
  } catch {
    visible = undefined
  }
  const events = session.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'skill-catalog') continue
    const entries = readEntries(event.data.source)
    if (entries === undefined) continue
    const digest = digestOf(entries)
    if (visible === undefined || visible.has(event.seq)) return digest
  }
  return undefined
}

export function apply(ctx, config = {}) {
  const maxLength = typeof config.maxDescriptionLength === 'number' && config.maxDescriptionLength >= 3
    ? config.maxDescriptionLength
    : DEFAULT_DESCRIPTION_MAX_LENGTH

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      signal.throwIfAborted()
      const snapshot = await ctx.skills.snapshot({
        cwd: agent.session.header.cwd,
        signal,
        scope: agent,
      })
      // Permission-mode independence: the official filesystem provider is
      // sandbox-fs-gated, so under restricted modes (workspace-write) its
      // discovery fails and the registry reports `complete: false` while
      // still collecting USABLE candidates — including the preset's own
      // skill-home-provider entries. Bailing out on `!complete` here would
      // silently gate the catalog on danger-full access (measured bug), so
      // inject from whatever usable candidates exist instead; only an EMPTY
      // catalog is a reason to skip.
      const skills = snapshot.skills.filter(isModelInvocable)
      if (skills.length === 0) return decision
      const entries = catalogEntries(skills, maxLength)
      const digest = digestOf(entries)
      const existing = existingCatalogMessage(decision.messages ?? [])
      if (existing !== undefined && digestOf(existing.entries) === digest) return decision
      // Already durable AND visible with the same digest: the official
      // listener treats that as "no injection needed"; match it.
      if (existing === undefined && visibleCatalogDigest(agent) === digest) return decision
      const catalog = renderCatalogMessage(entries)
      const messages = existing === undefined
        ? [...decision.messages, catalog]
        : decision.messages.map((message) => message.id === existing.message.id ? catalog : message)
      return { kind: 'enter', messages }
    } catch (error) {
      // Injection is advisory: a failure here must never break the request.
      try {
        ctx.logger.warn(`skill-catalog-deferred: catalog injection failed: ${String((error && error.message) || error)}`)
      } catch {
        // Logger unavailable — nothing else to do.
      }
      return decision
    }
  })
}
