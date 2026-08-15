import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name, renderCatalogMessage } from '../preset/skill-catalog-deferred.mjs'

function skillsSnapshot(skills, complete = true) {
  return { complete, skills }
}

const invocable = (over = {}) => ({
  name: 'example-skill',
  description: 'Does example things.',
  invocation: { modelInvocable: true, userInvocable: true },
  ...over,
})

function register(snapshot) {
  const listeners = {}
  const warns = []
  const ctx = {
    on(event, callback) {
      listeners[event] = callback
    },
    skills: {
      snapshot: snapshot ?? (async () => skillsSnapshot([invocable()])),
    },
    logger: {
      warn(message) {
        warns.push(message)
      },
    },
  }
  apply(ctx, {})
  return { listeners, warns }
}

function agent(events = [], visibleSeqs = []) {
  return {
    session: {
      header: { cwd: 'C:\\work' },
      surface: { nodes: visibleSeqs },
      events,
    },
  }
}

function prestep(listener, nextMessages, ag = agent(), signal = { throwIfAborted() {} }) {
  return listener({ agent: ag, signal }, async () => ({ kind: 'enter', messages: nextMessages }))
}

const userMessage = { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }

test('exports a diagnostic plugin name', () => {
  assert.equal(name, 'skill-catalog-deferred')
})

test('injects the available-skills catalog when the decision has none', async () => {
  const { listeners } = register()
  const decision = await prestep(listeners['agent/pre-step'], [userMessage])
  const kinds = decision.messages.map((message) => message.source.kind)
  assert.deepEqual(kinds, ['user', 'skill-catalog'])
})

test('the rendered catalog is the official reminder, byte-for-byte framing', () => {
  const entries = [{ name: 'example-skill', description: 'Does example things.' }]
  const message = renderCatalogMessage(entries)
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'skill-catalog')
  assert.equal(message.source.form, 'catalog')
  assert.deepEqual(message.source.entries, entries)
  const text = message.content[0].text
  assert.match(text, /<system-reminder>/)
  assert.match(text, /<available_skills>/)
  assert.match(text, /- `example-skill`: Does example things\./)
  assert.match(text, /call the `skill` tool with the exact skill name/)
})

test('does not duplicate a catalog already in the decision with the same digest', async () => {
  const { listeners } = register()
  const existing = renderCatalogMessage([{ name: 'example-skill', description: 'Does example things.' }])
  const decision = await prestep(listeners['agent/pre-step'], [userMessage, existing])
  const kinds = decision.messages.map((message) => message.source.kind)
  assert.deepEqual(kinds, ['user', 'skill-catalog'])
})

test('skips when a durable visible catalog already carries the same digest', async () => {
  const { listeners } = register()
  const durable = {
    seq: 7,
    type: 'user/message',
    data: renderCatalogMessage([{ name: 'example-skill', description: 'Does example things.' }]),
  }
  const decision = await prestep(listeners['agent/pre-step'], [userMessage], agent([durable], [7]))
  const kinds = decision.messages.map((message) => message.source.kind)
  assert.deepEqual(kinds, ['user'])
})

test('injects usable candidates even when the snapshot is incomplete', async () => {
  // The registry reports complete:false when a sandbox-gated provider fails,
  // but usable candidates from other providers are still collected — the
  // fallback must inject from them (permission-mode independence).
  const { listeners } = register(async () => skillsSnapshot([invocable()], false))
  const decision = await prestep(listeners['agent/pre-step'], [userMessage])
  assert.deepEqual(decision.messages.map((message) => message.source.kind), ['user', 'skill-catalog'])
})

test('skips when no skill is model-invocable', async () => {
  const { listeners } = register(async () => skillsSnapshot([invocable({ invocation: { modelInvocable: false, userInvocable: true } })]))
  const decision = await prestep(listeners['agent/pre-step'], [userMessage])
  assert.deepEqual(decision.messages.map((message) => message.source.kind), ['user'])
})

test('a snapshot failure is advisory: the decision survives unchanged', async () => {
  const { listeners, warns } = register(async () => {
    throw new Error('discovery exploded')
  })
  const decision = await prestep(listeners['agent/pre-step'], [userMessage])
  assert.deepEqual(decision.messages, [userMessage])
  assert.ok(warns.some((message) => message.includes('catalog injection failed')))
})

test('a rejected decision passes through untouched', async () => {
  const { listeners } = register()
  const decision = await listeners['agent/pre-step'](
    { agent: agent(), signal: { throwIfAborted() {} } },
    async () => ({ kind: 'reject', reason: 'policy' }),
  )
  assert.equal(decision.kind, 'reject')
})
