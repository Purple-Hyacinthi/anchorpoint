/**
 * skill-home-provider.mjs — preset-owned skill provider for the USER skill
 * roots, immune to the session sandbox policy.
 *
 * WHY: the official `dsh-skill-filesystem` provider discovers roots through
 * the sandbox-bound `ctx.fs`. Under any permission mode below danger-full
 * access (e.g. workspace-write) its reads of `~/.dsh/skills` fail, its
 * `list()` throws, the registry SKIPS the provider, and the snapshot comes
 * back `complete: false` with no candidates — so both the official catalog
 * listener and the preset's deferred catalog inject nothing. The model-visible
 * skill surface therefore silently depends on the permission preset.
 *
 * This provider reads the SAME two user roots (`<DSH_HOME>/skills` and
 * `<DSH_AGENTS_HOME | ~/.agents>/skills`) with `node:fs` directly. The roots
 * are fixed and never model-controllable, so no sandbox boundary is crossed
 * for the model: only skill discovery/load stops being permission-gated.
 *
 * Registration layering: this row sits in the preset layer next to the
 * official provider. Within one layer lower ranks win, so the user-dsh /
 * user-agents entries below (350 / 450) shadow the official provider's
 * (400 / 500) for the SAME names, while the official provider keeps serving
 * project (100/200), custom (300) and bundled (600) roots. When the snapshot
 * is complete (full access), the catalog content is identical; when the
 * official provider is skipped (restricted modes), these entries are the
 * only candidates and keep the catalog and the `skill` loader working.
 *
 * ZERO bare imports beyond node: builtins — user preset roots resolve no
 * node_modules (same constraint as skill-catalog-deferred.mjs).
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'skill-home-provider'

export const inject = ['skills']

const USER_DSH_RANK = 350
const USER_AGENTS_RANK = 450

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return join(homedir(), '.dsh')
}

function agentsHome() {
  const configured = process.env.DSH_AGENTS_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return join(homedir(), '.agents')
}

/** Strip surrounding quotes from a single-line YAML scalar. */
export function unquoteYaml(value) {
  const v = value.trim()
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return v.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") {
    return v.slice(1, -1).replaceAll("''", "'")
  }
  return v
}

/**
 * Parse the leading `---` frontmatter block of a SKILL.md body into a small
 * key/value table, returning the metadata and the body without the block.
 * Tolerates CRLF, BOMs, a missing block, and single-line quoted scalars —
 * the subset the user skill roots actually use.
 */
export function parseSkillFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')
  const meta = {}
  let start = -1
  let end = -1
  if (lines[0]?.trim() === '---') {
    start = 0
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        end = i
        break
      }
    }
  }
  if (start === 0 && end > start) {
    let key = undefined
    let buffer = ''
    const flush = () => {
      if (key !== undefined) {
        meta[key] = unquoteYaml(buffer)
        key = undefined
        buffer = ''
      }
    }
    for (let i = start + 1; i < end; i++) {
      const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(lines[i])
      if (match !== null) {
        flush()
        key = match[1]
        buffer = match[2].trim()
      } else if (key !== undefined && lines[i].trim().length > 0) {
        // Continuation line of a folded multi-line scalar.
        buffer += (buffer.length > 0 ? '\n' : '') + lines[i].trim()
      }
    }
    flush()
  }
  const content = end > start ? lines.slice(end + 1).join('\n') : normalized
  return { meta, content }
}

function booleanMeta(meta, key, fallback) {
  const raw = meta[key]
  if (raw === undefined) return fallback
  return raw === true || raw === 'true'
}

function invocationOf(meta) {
  return {
    modelInvocable: booleanMeta(meta, 'model-invocable', true),
    userInvocable: booleanMeta(meta, 'user-invocable', true),
  }
}

/**
 * Parse one SKILL.md file (or flat .md skill) into the registry's
 * SkillDefinition leaf fields, or undefined when the frontmatter carries no
 * valid skill name.
 */
export async function parseSkillFile(path, source) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const { meta, content } = parseSkillFrontmatter(text)
  const skillName = typeof meta.name === 'string' ? meta.name.trim() : ''
  if (!SKILL_NAME_PATTERN.test(skillName)) return undefined
  const description = typeof meta.description === 'string' ? meta.description : ''
  const whenToUse = typeof meta['when-to-use'] === 'string' && meta['when-to-use'].length > 0
    ? meta['when-to-use']
    : undefined
  return {
    name: skillName,
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    invocation: invocationOf(meta),
    source,
    content,
  }
}

/** Scan one skill root into provider candidates (directory bundles + flat .md). */
async function scanRoot(root, providerName) {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    // Absent roots are the normal empty case; anything else degrades to
    // incomplete discovery rather than throwing the whole provider away.
    if (error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return { candidates: [] }
    return { candidates: [], failed: true }
  }
  const candidates = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem === true && entry.name === '.system') continue
    const locator = entry.isDirectory()
      ? { path: join(root.path, entry.name, 'SKILL.md'), directory: join(root.path, entry.name) }
      : !entry.isDirectory() && entry.name.endsWith('.md')
        ? { path: join(root.path, entry.name), directory: root.path }
        : undefined
    if (locator === undefined) continue
    const parsed = await parseSkillFile(locator.path, root.source)
    if (parsed === undefined) continue
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: parsed.invocation,
      source: root.source,
      provider: providerName,
      rank: root.rank,
      locator,
      path: locator.path,
      resourceBase: { kind: 'directory', path: locator.directory },
    })
  }
  return { candidates }
}

/** The policy-independent user skill provider registered on `ctx.skills`. */
export function createProvider(providerName) {
  const provider = providerName ?? 'anchored-home'
  return {
    name: provider,
    async list() {
      const roots = [
        { path: join(dshHome(), 'skills'), source: 'user-dsh', rank: USER_DSH_RANK, skipSystem: true },
        { path: join(agentsHome(), 'skills'), source: 'user-agents', rank: USER_AGENTS_RANK },
      ]
      const candidates = []
      let complete = true
      for (const root of roots) {
        const result = await scanRoot(root, provider)
        if (result.failed === true) complete = false
        candidates.push(...result.candidates)
      }
      // A complete array is the shorthand observation; incomplete discovery
      // still contributes its usable candidates.
      return complete ? candidates : { candidates, complete }
    },
    async get(candidate) {
      const parsed = await parseSkillFile(candidate.locator.path, candidate.source)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
        invocation: parsed.invocation,
        source: candidate.source,
        provider,
        resourceBase: { kind: 'directory', path: candidate.locator.directory },
        path: candidate.locator.path,
        content: parsed.content,
      }
    },
  }
}

export function apply(ctx, config = {}) {
  const provider = createProvider(typeof config?.providerName === 'string' && config.providerName.length > 0 ? config.providerName : undefined)
  ctx.effect(() => ctx.skills.registerProvider(() => provider))
}
