/**
 * preset-runner.mjs — a headless one-shot runner that JOINS AN AGENT PRESET.
 *
 * The stock dsh-headless runner creates its Agent without joining an agent
 * preset (the web gateway normally does that through dsh-host-apiproxy), so
 * headless sessions resolve tools and prompt sections against the base layer.
 * This runner does what the gateway does: in the async agent-factory setup it
 * mounts the requested preset via `agentPresets.mount(agentCtx, id)` before
 * the Agent is published, then drives one task exactly like the stock runner.
 *
 * Install as a patch row of the headless profile, e.g.:
 *
 *   - id: headless-runner
 *     disabled: true
 *   - insert:
 *       - id: agent-presets
 *         name: '@deepseek-ai/dsh-agent-presets'
 *         config:
 *           default: anchored-standard-skills
 *       - id: preset-runner
 *         name: ./preset-runner.mjs
 *         inject: [headlessStartup, agentPresets]
 *         config:
 *           task: !!js ctx.headlessStartup.task
 *           preset: !!js process.env.DSH_PRESET ?? 'anchored-standard-skills'
 */

import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name used by loader diagnostics. */
export const name = 'preset-runner'

/** Services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets', 'headlessStartup']

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Report an unexpected driver failure and request a failing exit. */
function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one task through a freshly created Agent composed from `config.preset`.
 * @param ctx - plugin context carrying core services and the launcher exit hook.
 * @param config - `{ task, preset }`, preset resolvable by the agent-presets roster.
 * @param io - process-facing effects.
 */
async function run(ctx, config, io) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const presets = ctx.get('agentPresets')
  if (agents === undefined || defaultModel === undefined || sessions === undefined || presets === undefined) return
  const presetId = config.preset
  if (typeof presetId !== 'string' || presetId.length === 0) throw new Error('preset-runner: config.preset must be a preset id')
  const resolved = (await presets.resolve(presetId)).id
  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
    },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, {
        current: selection,
        assembled: undefined,
      })
      await presets.mount(agentCtx, resolved)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/** Mount the one-shot preset-aware driver. */
function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('preset-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io = { stdout: process.stdout, stderr: process.stderr, exit }
  run(ctx, config, io).catch((error) => {
    fail(io, error)
  })
}

export { apply }
