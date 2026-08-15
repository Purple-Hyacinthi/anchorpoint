/**
 * session-report.mjs — decompress and analyze one DSH headless session log.
 *
 * Usage:
 *   node experiments/session-report.mjs <session.jsonl.zstd> [--json]
 *
 * Reads the append-only zstd frame log (session.jsonl.zstd), decompresses
 * every complete frame with node:zlib's built-in zstd support (Node >= 22.15),
 * and reports the FIRST-REQUEST ANCHOR facts the anchored-standard presets
 * control:
 *
 *   - request #1 tools (the API-visible catalog) and its maxTokens
 *   - request #1 system prompt (which persona was in effect)
 *   - which step first carried the `<available_skills>` catalog message
 *   - request #1 message list (user / runtime-context / skill-catalog / ...)
 *   - the first assistant reasoning block: first line, and we / "we need" /
 *     "let me" / "let's" counts (the V4 "We need…" trajectory markers)
 *
 * This is a measurement script, not a harness plugin: it never touches the
 * running DSH home. Never write its decompressed output back into the session
 * directory — the jsonl backend rejects a stray uncompressed `session.jsonl`
 * next to `session.jsonl.zstd`.
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Split one buffer into zstd frames by magic; each frame decodes alone. */
function splitFrames(buf) {
  const frames = []
  let start = -1
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      if (start >= 0) frames.push(buf.subarray(start, i))
      start = i
    }
  }
  if (start >= 0) frames.push(buf.subarray(start))
  return frames
}

/** Decompress a `.jsonl.zstd` artifact to its full JSONL text. */
export function decompressSession(file) {
  const buf = readFileSync(file)
  let text = ''
  for (const [i, frame] of splitFrames(buf).entries()) {
    try {
      text += zstdDecompressSync(frame).toString('utf8')
    } catch (error) {
      throw new Error(`frame ${i} failed to decompress: ${error.message}`)
    }
  }
  return text
}

/** Parse one session log into the anchor report. */
export function report(text) {
  const events = text.trim().split('\n').map((line) => JSON.parse(line))
  let step = 0
  let firstRequest = undefined
  let catalogStep = undefined
  const step1Messages = []
  const step1Reasoning = []
  let firstAssistantStep1 = undefined

  for (const event of events) {
    if (event.type === 'step/start') step = event.data.step
    if (event.type === 'request/header' && firstRequest === undefined) firstRequest = event.data
    if (event.type === 'user/message') {
      if (step === 1) step1Messages.push(event.data.source)
      if (catalogStep === undefined && event.data.source?.kind === 'skill-catalog') catalogStep = step
    }
    if (event.type === 'assistant/message' && event.data.step === 1 && firstAssistantStep1 === undefined) {
      firstAssistantStep1 = event.data.message
      for (const block of event.data.message.content) {
        if (block.type === 'reasoning') step1Reasoning.push(block.text)
      }
    }
  }

  const header = firstRequest?.header
  const tools = (header?.tools ?? []).map((tool) => tool.name)
  const system = header?.system ?? ''
  const reasoning = step1Reasoning.join('\n')
  const words = (pattern) => (reasoning.match(pattern) ?? []).length
  const firstLine = reasoning.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''

  return {
    tools,
    toolCount: tools.length,
    maxTokens: header?.config?.maxTokens ?? 'adapter-default',
    model: header?.config ? `${header.config.provider}/${header.config.model} (${header.config.reasoningEffort})` : 'unknown',
    persona: system.startsWith('You are a helpful software engineer assistant.') ? 'minimal-complete' : 'harness-identity',
    systemLength: system.length,
    step1MessageKinds: step1Messages.map((source) => source.kind),
    catalogStep,
    reasoning,
    firstLine,
    reasoningChars: reasoning.length,
    we: words(/\bwe\b/gi),
    weNeed: words(/we need/gi),
    letMe: words(/\blet me\b/gi),
    lets: words(/\blet's\b/gi),
  }
}

/** Human-readable one-run summary. */
export function summarize(label, r) {
  const lines = []
  lines.push(`── ${label} ──────────────────────────────`)
  lines.push(`model            ${r.model}`)
  lines.push(`persona          ${r.persona} (${r.systemLength} chars)`)
  lines.push(`request#1 tools  [${r.tools.join(', ')}]`)
  lines.push(`request#1 count  ${r.toolCount}   maxTokens: ${r.maxTokens}`)
  lines.push(`request#1 msgs   ${r.step1MessageKinds.join(' + ') || '(none)'}`)
  lines.push(`skill catalog    step ${r.catalogStep ?? 'never'}`)
  lines.push(`reasoning head   ${JSON.stringify(r.firstLine.slice(0, 120))}`)
  lines.push(`reasoning stats  chars=${r.reasoningChars}  we=${r.we}  "we need"=${r.weNeed}  "let me"=${r.letMe}  "let's"=${r.lets}`)
  return lines.join('\n')
}

/** CLI entry: node session-report.mjs <file.zstd> [--json] */
const runCli = async () => {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node session-report.mjs <session.jsonl.zstd> [--json]')
    process.exit(2)
  }
  const r = report(decompressSession(file))
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log(summarize(file.split(/[\\/]/).slice(-4, -1).join('/'), r))
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/experiments/session-report.mjs')) {
  await runCli()
}
