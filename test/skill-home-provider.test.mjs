import assert from 'node:assert/strict'
import test from 'node:test'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  createProvider,
  name,
  parseSkillFile,
  parseSkillFrontmatter,
  unquoteYaml,
} from '../preset/skill-home-provider.mjs'

test('exports a diagnostic plugin name and registers the provider on ctx.skills', () => {
  assert.equal(name, 'skill-home-provider')
  let registered
  let disposer
  const ctx = {
    skills: {
      registerProvider(callback) {
        registered = callback
        return () => { disposer = true }
      },
    },
    effect(callback) {
      const returned = callback()
      assert.equal(typeof returned, 'function')
      return returned
    },
  }
  apply(ctx, {})
  assert.equal(typeof registered, 'function')
  assert.equal(disposer, undefined)
})

test('unquoteYaml strips double quotes and escapes', () => {
  assert.equal(unquoteYaml('"a \\"quoted\\" value"'), 'a "quoted" value')
  assert.equal(unquoteYaml("'single''quoted'"), 'single\'quoted')
  assert.equal(unquoteYaml('plain'), 'plain')
})

test('parseSkillFrontmatter reads the standard user-skill frontmatter', () => {
  const text = [
    '---',
    'name: solid',
    'description: "Use this skill when writing code, implementing features."',
    '---',
    '',
    '# Body',
    'real content',
  ].join('\r\n')
  const { meta, content } = parseSkillFrontmatter('\uFEFF' + text)
  assert.equal(meta.name, 'solid')
  assert.equal(meta.description, 'Use this skill when writing code, implementing features.')
  assert.equal(content, '\n# Body\nreal content')
})

test('parseSkillFrontmatter tolerates a missing block', () => {
  const { meta, content } = parseSkillFrontmatter('# Just a body\nline two')
  assert.deepEqual(meta, {})
  assert.equal(content, '# Just a body\nline two')
})

test('the provider lists user-root skills with node:fs, independent of the sandbox fs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'skill-home-provider-'))
  try {
    await mkdir(join(home, 'skills', 'example-skill'), { recursive: true })
    await writeFile(join(home, 'skills', 'example-skill', 'SKILL.md'), [
      '---',
      'name: example-skill',
      'description: Does example things.',
      '---',
      '',
      '# Example',
      'body text',
    ].join('\n'))
    const previous = process.env.DSH_HOME
    const previousAgents = process.env.DSH_AGENTS_HOME
    process.env.DSH_HOME = home
    process.env.DSH_AGENTS_HOME = join(home, 'agents')
    try {
      const provider = createProvider()
      const candidates = await provider.list({})
      assert.equal(candidates.length, 1)
      const candidate = candidates[0]
      assert.equal(candidate.name, 'example-skill')
      assert.equal(candidate.source, 'user-dsh')
      assert.equal(candidate.rank, 350)
      assert.equal(candidate.provider, 'anchored-home')
      assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
      const definition = await provider.get(candidate, {})
      assert.equal(definition.content, '\n# Example\nbody text')
      assert.equal(definition.resourceBase.kind, 'directory')
      assert.equal(definition.path, join(home, 'skills', 'example-skill', 'SKILL.md'))
    } finally {
      process.env.DSH_HOME = previous
      process.env.DSH_AGENTS_HOME = previousAgents
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('parseSkillFile rejects files without a valid skill name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-parse-'))
  try {
    const path = join(dir, 'SKILL.md')
    await writeFile(path, '# no frontmatter here')
    assert.equal(await parseSkillFile(path, 'user-dsh'), undefined)
    await writeFile(path, ['---', 'name: Not Valid Name', 'description: x', '---', 'body'].join('\n'))
    assert.equal(await parseSkillFile(path, 'user-dsh'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an absent skill root yields no candidates', async () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(tmpdir(), 'does-not-exist-skill-root')
  try {
    const provider = createProvider()
    const candidates = await provider.list({})
    assert.deepEqual(candidates, [])
  } finally {
    process.env.DSH_HOME = previous
  }
})
