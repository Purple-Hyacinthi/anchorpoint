/**
 * run-lab.mjs — one-command anchored-preset lab.
 *
 * Builds an ISOLATED copy of $DSH_HOME (sessions excluded), installs the
 * anchored-standard / anchored-standard-skills presets into it, swaps the
 * headless profile's stock runner for the preset-aware runner
 * (experiments/preset-runner.mjs), then runs the same task once per preset
 * and prints the first-request anchor report side by side.
 *
 * The real $DSH_HOME is never touched, so this is safe to run next to a live
 * `dsh web`. It DOES spend model tokens: one fresh session per run.
 *
 * Usage:
 *   DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js \
 *   node experiments/run-lab.mjs \
 *     --presets anchored-standard-skills,standard \
 *     --task "create a small script ..."
 *
 * Requires Node >= 22.15 (node:zlib zstd) on Windows, and a lab directory
 * (default: <repo>/lab-run) that does not yet exist.
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decompressSession, report } from './session-report.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const DEFAULT_TASK = 'In the current directory, create sort.py that reads lines from input.txt, sorts them, and writes them to output.txt. Then create input.txt with three lines: banana, apple, cherry. Run sort.py and show me the final output.txt.'

function parseArgs(argv) {
  const args = { presets: ['anchored-standard-skills', 'standard'], task: DEFAULT_TASK, runs: 1, lab: resolve(join(repoRoot, 'lab-run')), bridgeText: undefined }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    if (flag === '--presets') args.presets = next.split(',').map((s) => s.trim()).filter(Boolean)
    else if (flag === '--task') args.task = next
    else if (flag === '--runs') args.runs = Number(next)
    else if (flag === '--lab') args.lab = resolve(next)
    else if (flag === '--bridge-text') args.bridgeText = next
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`)
  }
  return args
}

/**
 * Mirror one directory tree, preserving every symlink/junction as a junction
 * to the SAME target. Used for the profiles tree, where dsh requires
 * `profiles/node_modules` and each `profiles/<profile>/node_modules` to stay
 * links into the installed app's node_modules (a materialized copy makes
 * `healProfilesModuleFallback` refuse to boot).
 */
function mirrorLinks(src, dst) {
  mkdirSync(dst, { recursive: true })
  if (!existsSync(src)) return
  for (const entry of readdirSync(src)) {
    const from = join(src, entry)
    const to = join(dst, entry)
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) {
      if (existsSync(to)) rmSync(to, { recursive: true, force: true })
      symlinkSync(readlinkSync(from), to, 'junction')
    } else if (stat.isDirectory()) {
      mirrorLinks(from, to)
    } else {
      cpSync(from, to)
    }
  }
}

/**
 * Copy a DSH home into the lab, excluding sessions and every node_modules
 * under profiles (re-created as junctions afterwards — see mirrorLinks).
 */
function buildLabHome(srcHome, labHome) {
  if (existsSync(labHome)) throw new Error(`lab home already exists: ${labHome}`)
  mkdirSync(labHome, { recursive: true })
  const copyTree = (src, dst, insideProfiles) => {
    for (const entry of readdirSync(src)) {
      if (entry === 'sessions') continue
      const from = join(src, entry)
      const to = join(dst, entry)
      const stat = lstatSync(from)
      if (stat.isSymbolicLink()) continue // re-created by mirrorLinks for profiles
      if (stat.isDirectory()) {
        if (insideProfiles && entry === 'node_modules') continue
        mkdirSync(to, { recursive: true })
        copyTree(from, to, insideProfiles || entry === 'profiles')
      } else {
        cpSync(from, to)
      }
    }
  }
  copyTree(srcHome, labHome, false)
  const profilesDir = join(labHome, 'profiles')
  if (existsSync(join(srcHome, 'profiles'))) {
    if (existsSync(profilesDir)) rmSync(profilesDir, { recursive: true, force: true })
    mirrorLinks(join(srcHome, 'profiles'), profilesDir)
  }
  return labHome
}

/** Point the headless profile patch at the preset-aware runner. */
function patchHeadless(labHome, defaultPreset) {
  const profileDir = join(labHome, 'profiles', 'headless')
  cpSync(join(here, 'preset-runner.mjs'), join(profileDir, 'preset-runner.mjs'))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '# Lab patch: replace the stock one-shot runner (which does not join an',
    '# agent preset) with the preset-aware runner, and mount the preset roster.',
    '- id: headless-runner',
    '  disabled: true',
    '',
    '- insert:',
    '    - id: agent-presets',
    "      name: '@deepseek-ai/dsh-agent-presets'",
    '      config:',
    `        default: ${defaultPreset}`,
    '',
    '    - id: preset-runner',
    '      name: ./preset-runner.mjs',
    '      inject: [headlessStartup, agentPresets]',
    '      config:',
    '        task: !!js ctx.headlessStartup.task',
    "        preset: !!js process.env.DSH_PRESET ?? 'anchored-standard-skills'",
    '',
  ].join('\n'))
}

/** Install the two presets into the lab user preset root. */
function installPresets(labHome) {
  const root = join(labHome, '.agent-presets')
  mkdirSync(root, { recursive: true })
  // The variants share their plugin modules through `../preset/...` relative
  // rows, so the shared directory must live under its literal name `preset`.
  cpSync(join(repoRoot, 'preset'), join(root, 'preset'), { recursive: true })
  cpSync(join(repoRoot, 'anchored-standard-skills'), join(root, 'anchored-standard-skills'), { recursive: true })
}

/**
 * Override the CJK bridge text in the LAB copies only (the repo stays on its
 * default), so an A/B lab can compare bridge versions without code edits.
 * The override is written as a YAML block scalar right after the
 * suppressedContextSources config key of the tool-bootstrap row.
 */
function patchBridgeText(labHome, text) {
  const root = join(labHome, '.agent-presets')
  const marker = '    suppressedContextSources: [agent-instructions, skill-catalog, plugin:user-approval]'
  const block = `    zhBridgeText: |-${text.split('\n').map((line) => `\n      ${line}`).join('')}`
  for (const rel of ['preset/agent.cordis.yml', 'anchored-standard-skills/agent.cordis.yml']) {
    const path = join(root, rel)
    const source = readFileSync(path, 'utf8')
    if (!source.includes(marker)) throw new Error(`bridge-text patch: marker not found in ${path}`)
    writeFileSync(path, source.replace(marker, `${marker}\n${block}`))
  }
}

/** Run one headless session and return its anchor report. */
function runHeadless(bin, labHome, preset, task, workDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    mkdirSync(workDir, { recursive: true })
    const child = spawn(process.execPath, [bin, '--profile', 'headless', task], {
      cwd: workDir,
      env: { ...process.env, DSH_HOME: labHome, DSH_PRESET: preset },
      stdio: 'inherit',
    })
    child.on('error', rejectPromise)
    child.on('exit', (code) => {
      if (code !== 0) return rejectPromise(new Error(`headless run for ${preset} exited ${code}`))
      resolvePromise(report(decompressSession(newestSession(labHome, workDir))))
    })
  })
}

/** The session artifact this run produced (newest `.jsonl.zstd` for this cwd). */
function newestSession(labHome, workDir) {
  const sessions = join(labHome, 'sessions')
  // DSH names session roots `--<cwd with path separators replaced by ->--`.
  const encoded = workDir.replaceAll(/[\\/:]+/g, '-').replaceAll(/^-+|-+$/g, '')
  const marker = `-${encoded}-`
  let best
  let bestMtime = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl.zstd' && dir.includes(marker)) {
        const mtime = lstatSync(path).mtimeMs
        if (mtime > bestMtime) {
          best = path
          bestMtime = mtime
        }
      }
    }
  }
  walk(sessions)
  if (best === undefined) throw new Error(`no session artifact found under ${marker} after headless run`)
  return best
}

function table(results) {
  const header = ['preset', 'persona', '#tools req#1', 'catalog@step', 'we', '"we need"', '"let me"', 'reasoning head']
  const rows = results.map((r) => [
    r.preset,
    r.report.persona,
    String(r.report.toolCount),
    String(r.report.catalogStep ?? 'never'),
    String(r.report.we),
    String(r.report.weNeed),
    String(r.report.letMe),
    JSON.stringify(r.report.firstLine.slice(0, 40)),
  ])
  const width = (idx) => Math.max(header[idx].length, ...rows.map((row) => row[idx].length))
  const line = header.map((_, i) => ''.padEnd(width(i))).join(' | ')
  const render = (row) => row.map((cell, i) => cell.padEnd(width(i))).join(' | ')
  return [render(header), header.map((_, i) => ''.padEnd(width(i), '-')).join('-+-'), ...rows.map(render)].join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const srcHome = resolve(process.env.DSH_HOME ?? '')
  if (!process.env.DSH_HOME) throw new Error('DSH_HOME is not set; the lab copies it')
  const bin = resolve(process.env.DSH_BIN ?? '')
  if (!process.env.DSH_BIN) throw new Error('DSH_BIN is not set; point it at <checkout>/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const labHome = join(args.lab, '.dsh')
  const runRoot = join(args.lab, 'work')

  console.log(`lab home   ${labHome}`)
  console.log(`presets    ${args.presets.join(', ')}  (${args.runs} run(s) each)`)
  console.log(`task       ${JSON.stringify(args.task.slice(0, 80))}${args.task.length > 80 ? '…' : ''}`)
  console.log('')
  console.log('NOTE: the lab home receives a COPY of your credentials (.credentials.yaml)')
  console.log('so the headless runs can authenticate. Delete the lab directory afterwards.')
  console.log('')

  buildLabHome(srcHome, labHome)
  patchHeadless(labHome, args.presets[0])
  installPresets(labHome)
  if (args.bridgeText !== undefined) {
    patchBridgeText(labHome, args.bridgeText)
    console.log(`bridge-text override applied (${args.bridgeText.length} chars)`)
  }

  const results = []
  for (const preset of args.presets) {
    for (let i = 1; i <= args.runs; i++) {
      const workDir = join(runRoot, `run-${preset}-${i}`)
      console.log(`== ${preset} run ${i} ==  (cwd ${workDir})`)
      const rep = await runHeadless(bin, labHome, preset, args.task, workDir)
      results.push({ preset, run: i, report: rep })
      console.log('')
    }
  }
  console.log(table(results))
  const json = join(args.lab, 'results.json')
  writeFileSync(json, JSON.stringify(results, null, 2))
  console.log('')
  console.log(`raw reports   ${json}`)
  console.log(`session logs  ${join(labHome, 'sessions')}`)
}

main().catch((error) => {
  console.error(`run-lab: ${error.message}`)
  process.exit(1)
})
