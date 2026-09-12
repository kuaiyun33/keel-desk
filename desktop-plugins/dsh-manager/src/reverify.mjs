import { spawn } from 'node:child_process'
import { accessSync, existsSync, readFileSync } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const REVERIFY_VERSION = '0.9.0'
export const REVERIFY_COMMIT = 'f80dc1a080de'
export const REVERIFY_SOURCE = 'https://github.com/2akouwu/reverify'

export const ARMOR_MODES = ['coldbrew', 'reverify', 'pentagi']
export const DEFAULT_ARMOR_MODE = 'coldbrew'

export const PENTAGI_VERSION = '1.0.0'
export const PENTAGI_SOURCE = 'https://github.com/vxcontrol/pentagi'

const TOOL_TIMEOUT_MS = {
  re_semantic: 180_000,
  re_verify_claim: 120_000,
  re_auto_triage: 60_000,
  re_parse: 60_000,
  re_parse_pe: 60_000,
  default: 45_000,
}

export const REVERIFY_TOOLS = [
  {
    name: 're_auto_triage',
    description: 'Inspect a binary: format, architecture, sections, and a hex sample. Grounded in the real bytes.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative file path' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 're_parse_pe',
    description: 'Parse PE32/PE32+ headers, sections, imports and exports.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target PE executable/DLL path' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 're_parse',
    description: 'Parse PE, ELF or Mach-O: format, arch, entry, sections, imports, exports.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target binary path' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 're_backends',
    description: 'Report which Reverify engines are active (capstone, unicorn, lief, z3, angr).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 're_pattern_scan',
    description: 'Scan a binary for a hex AOB signature with ?? wildcards.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target binary file path' },
        pattern: { type: 'string', description: "Hex pattern with ?? wildcards, e.g. '48 89 ?? 24'" },
      },
      required: ['file_path', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 're_disasm',
    description: 'Disassemble raw hex opcodes into x86/x64 assembly.',
    parameters: {
      type: 'object',
      properties: {
        hex_bytes: { type: 'string', description: 'Hexadecimal byte stream' },
        arch: { type: 'string', enum: ['x86_64', 'x86_32'], description: 'Architecture (default x86_64)' },
      },
      required: ['hex_bytes'],
      additionalProperties: false,
    },
  },
  {
    name: 're_verify_claim',
    description: 'Judge a hypothesis about a binary against the real bytes. Returns VERIFIED / REFUTED / INCONCLUSIVE / OBSERVED with evidence. Use before reporting any structural fact.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target binary file path' },
        claims: {
          type: 'array',
          description: 'Claim objects {kind, params, note?, observe?, id?, depends_on?}',
          items: { type: 'object', additionalProperties: true },
        },
        record: { type: 'boolean', description: 'Record grounded results in the durable ledger (default true)' },
        goal: { type: 'string', description: 'Optional: what you are trying to establish' },
        session: { type: 'string', description: 'Optional session label for the ledger' },
      },
      required: ['file_path', 'claims'],
      additionalProperties: false,
    },
  },
  {
    name: 're_semantic',
    description: 'Function boundaries, call graph, xrefs (angr when installed; otherwise entry/exports only). query=summary|functions|function_at|callees|callers|references|reachable.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target binary file path' },
        query: {
          type: 'string',
          enum: ['summary', 'functions', 'function_at', 'callees', 'callers', 'references', 'reachable'],
        },
        offset: {
          oneOf: [
            { type: 'integer' },
            { type: 'string' },
          ],
          description: 'Address (file offset unless space says rva/va)',
        },
        space: { type: 'string', enum: ['file', 'rva', 'va'] },
        name: { type: 'string', description: 'Function, export or import name' },
        limit: { type: 'integer' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 're_ledger',
    description: 'Restore or manage the durable ledger of grounded facts for a binary. Call after compaction or /clear. action=show|index|clear.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target binary file path' },
        action: { type: 'string', enum: ['show', 'index', 'clear'] },
        max_facts: { type: 'integer' },
        max_false: { type: 'integer' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
]

function pathExistsSync(path) {
  try {
    accessSync(path)
    return true
  } catch {
    return false
  }
}

export function reverifyPackageRoot() {
  const bundled = join(here, 'vendor', 'reverify')
  const sibling = join(here, '..', 'vendor', 'reverify')
  if (pathExistsSync(join(bundled, 'reverify', 'cli.py'))) return bundled
  if (pathExistsSync(join(sibling, 'reverify', 'cli.py'))) return sibling
  return bundled
}

export function reverifyBridgePath() {
  const bundled = join(here, 'reverify-bridge.py')
  if (pathExistsSync(bundled)) return bundled
  return join(here, '..', 'src', 'reverify-bridge.py')
}

export function normalizeArmorMode(value) {
  return value === 'reverify' || value === 'pentagi' ? value : DEFAULT_ARMOR_MODE
}

function userHome(env = process.env) {
  const configured = String(env.DSH_HOME ?? '').trim()
  if (configured.length === 0) return join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return resolve(join(homedir(), configured.slice(2)))
  }
  return resolve(configured)
}

export function reverifyVenvPython(env = process.env) {
  const venv = join(userHome(env), 'reverify-venv')
  return process.platform === 'win32'
    ? join(venv, 'Scripts', 'python.exe')
    : join(venv, 'bin', 'python')
}

export function reverifyVenvDir(env = process.env) {
  return join(userHome(env), 'reverify-venv')
}

export function ledgerDir(env = process.env) {
  return join(userHome(env), 'reverify')
}

const ANGR_MIN = { major: 3, minor: 10 }

function parsePythonVersion(text) {
  const [major, minor] = String(text ?? '').split('.').map(n => Number(n))
  return { major: major || 0, minor: minor || 0 }
}

function versionAtLeast(version, min) {
  const parsed = typeof version === 'string' ? parsePythonVersion(version) : version
  return parsed.major > min.major || (parsed.major === min.major && parsed.minor >= min.minor)
}

function hostPythonCandidates(env = process.env) {
  const out = []
  const explicit = String(env.REVERIFY_PYTHON ?? '').trim()
  if (explicit) out.push({ command: explicit, prefix: [], source: 'env' })
  if (process.platform === 'win32') {
    out.push({ command: 'py', prefix: ['-3.12'], source: 'py-3.12' })
    out.push({ command: 'py', prefix: ['-3.11'], source: 'py-3.11' })
    out.push({ command: 'py', prefix: ['-3'], source: 'py-launcher' })
    out.push({ command: 'python', prefix: [], source: 'python' })
    return out
  }
  for (const abs of [
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/usr/local/bin/python3.13',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
  ]) {
    if (pathExistsSync(abs)) out.push({ command: abs, prefix: [], source: abs })
  }
  out.push({ command: 'python3', prefix: [], source: 'python3' })
  out.push({ command: '/usr/bin/python3', prefix: [], source: '/usr/bin/python3' })
  out.push({ command: 'python', prefix: [], source: 'python' })
  return out
}

function pythonCandidates(env = process.env) {
  const venvPy = reverifyVenvPython(env)
  const out = []
  if (pathExistsSync(venvPy)) out.push({ command: venvPy, prefix: [], source: 'venv' })
  out.push(...hostPythonCandidates(env))
  return out
}

function spawnEnv(env = process.env) {
  const extra = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  const sep = process.platform === 'win32' ? ';' : ':'
  const path = [...extra, env.PATH ?? process.env.PATH ?? ''].filter(Boolean).join(sep)
  return { ...env, PATH: path }
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const input = options.input
  const onOutput = options.onOutput
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: spawnEnv({
        ...(options.env ?? process.env),
        PYTHONUNBUFFERED: '1',
      }),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`reverify timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const take = (chunk, sink) => {
      const text = chunk.toString()
      if (sink === 'out') stdout += text
      else stderr += text
      onOutput?.(text)
    }
    child.stdout.on('data', chunk => take(chunk, 'out'))
    child.stderr.on('data', chunk => take(chunk, 'err'))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function lineLogger(onLog) {
  let leftover = ''
  return (chunk) => {
    leftover += chunk.replaceAll('\r', '\n')
    const parts = leftover.split('\n')
    leftover = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (trimmed) onLog(trimmed)
    }
  }
}

export async function resolvePython(env = process.env) {
  const errors = []
  for (const candidate of pythonCandidates(env)) {
    try {
      const result = await runProcess(
        candidate.command,
        [...candidate.prefix, '-c', 'import sys; print(sys.version.split()[0]); print(sys.executable)'],
        { timeoutMs: 8_000, env },
      )
      if (result.code !== 0) {
        errors.push(`${candidate.command}: ${result.stderr.trim() || `exit ${result.code}`}`)
        continue
      }
      const [version, executable] = result.stdout.trim().split(/\n/)
      if (!versionAtLeast(version, { major: 3, minor: 8 })) {
        errors.push(`${candidate.command}: Python ${version} < 3.8`)
        continue
      }
      return {
        command: candidate.command,
        prefix: candidate.prefix,
        source: candidate.source,
        version,
        executable: executable || candidate.command,
      }
    } catch (error) {
      errors.push(`${candidate.command}: ${error.message}`)
    }
  }
  return { error: errors.join('; ') || 'no Python 3.8+ found' }
}

function pythonEnv(env = process.env) {
  const root = reverifyPackageRoot()
  const sep = process.platform === 'win32' ? ';' : ':'
  const pythonPath = [root, env.PYTHONPATH].filter(Boolean).join(sep)
  return {
    ...env,
    PYTHONPATH: pythonPath,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    REVERIFY_LEDGER_DIR: ledgerDir(env),
  }
}

export async function probeReverify(env = process.env) {
  const python = await resolvePython(env)
  const root = reverifyPackageRoot()
  const present = pathExistsSync(join(root, 'reverify', 'cli.py'))
  const versionFile = join(root, 'VERSION')
  const versionText = pathExistsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : REVERIFY_VERSION
  if (python.error) {
    return {
      ok: false,
      version: REVERIFY_VERSION,
      commit: REVERIFY_COMMIT,
      source: REVERIFY_SOURCE,
      packageRoot: root,
      present,
      versionText,
      python,
      engines: null,
      venv: pathExistsSync(reverifyVenvPython(env)),
      venvDir: reverifyVenvDir(env),
    }
  }
  let engines = null
  let ok = present
  try {
    const result = await runProcess(
      python.command,
      [...python.prefix, '-m', 'reverify.cli', 'backends', '--json'],
      { timeoutMs: 20_000, env: pythonEnv(env) },
    )
    if (result.code === 0) {
      engines = JSON.parse(result.stdout)
      ok = true
    } else {
      engines = { error: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}` }
      ok = false
    }
  } catch (error) {
    engines = { error: error.message }
    ok = false
  }
  return {
    ok,
    version: REVERIFY_VERSION,
    commit: REVERIFY_COMMIT,
    source: REVERIFY_SOURCE,
    packageRoot: root,
    present,
    versionText,
    python,
    engines,
    venv: pathExistsSync(reverifyVenvPython(env)),
    venvDir: reverifyVenvDir(env),
  }
}

export async function runReverifyTool(name, args = {}, env = process.env) {
  const python = await resolvePython(env)
  if (python.error) {
    return { error: `Python 3.8+ required for Reverify: ${python.error}` }
  }
  const timeoutMs = TOOL_TIMEOUT_MS[name] ?? TOOL_TIMEOUT_MS.default
  const result = await runProcess(
    python.command,
    [...python.prefix, reverifyBridgePath(), name],
    {
      timeoutMs,
      env: pythonEnv(env),
      input: JSON.stringify(args ?? {}),
    },
  )
  const text = (result.stdout || '').trim() || (result.stderr || '').trim()
  if (!text) return { error: `reverify ${name} produced no output (exit ${result.code})` }
  try {
    return JSON.parse(text)
  } catch {
    return { error: text, exit: result.code }
  }
}

export async function resolveHostPython(env = process.env, min = { major: 3, minor: 8 }) {
  const errors = []
  for (const candidate of hostPythonCandidates(env)) {
    try {
      const result = await runProcess(
        candidate.command,
        [...candidate.prefix, '-c', 'import sys; print(sys.version.split()[0]); print(sys.executable)'],
        { timeoutMs: 8_000, env },
      )
      if (result.code !== 0) {
        errors.push(`${candidate.command}: ${result.stderr.trim() || `exit ${result.code}`}`)
        continue
      }
      const [version, executable] = result.stdout.trim().split(/\n/)
      if (!versionAtLeast(version, min)) {
        errors.push(`${candidate.command}: Python ${version} < ${min.major}.${min.minor}`)
        continue
      }
      return {
        command: candidate.command,
        prefix: candidate.prefix,
        source: candidate.source,
        version,
        executable: executable || candidate.command,
      }
    } catch (error) {
      errors.push(`${candidate.command}: ${error.message}`)
    }
  }
  return { error: errors.join('; ') || `no Python ${min.major}.${min.minor}+ found` }
}

async function venvPythonInfo(env = process.env) {
  const venvPy = reverifyVenvPython(env)
  if (!pathExistsSync(venvPy)) return null
  const result = await runProcess(
    venvPy,
    ['-c', 'import sys; print(sys.version.split()[0])'],
    { timeoutMs: 8_000, env },
  )
  if (result.code !== 0) return { command: venvPy, prefix: [], source: 'venv', version: '0.0' }
  return {
    command: venvPy,
    prefix: [],
    source: 'venv',
    version: result.stdout.trim().split(/\n/)[0],
    executable: venvPy,
  }
}

export async function ensureVenv(onLog = () => {}, env = process.env, options = {}) {
  const min = options.min ?? { major: 3, minor: 8 }
  const venvDir = reverifyVenvDir(env)
  const venvPy = reverifyVenvPython(env)
  const existing = await venvPythonInfo(env)
  if (existing && versionAtLeast(existing.version, min) && options.recreate !== true) {
    onLog(`venv already exists: ${venvDir} (Python ${existing.version})`)
    return { python: existing, venvDir }
  }
  const host = await resolveHostPython(env, min)
  if (host.error) throw new Error(host.error)
  if (existing && !versionAtLeast(existing.version, min)) {
    onLog(`现有 venv 是 Python ${existing.version}，调用图引擎需要 ${min.major}.${min.minor}+ 的官方 wheel，正在用 ${host.version} 重建`)
  }
  if (pathExistsSync(venvDir)) {
    await rm(venvDir, { recursive: true, force: true })
  }
  await mkdir(userHome(env), { recursive: true })
  onLog(`$ ${host.command} -m venv ${venvDir}`)
  const created = await runProcess(
    host.command,
    [...host.prefix, '-m', 'venv', venvDir],
    { timeoutMs: 120_000, env, onOutput: lineLogger(onLog) },
  )
  if (created.code !== 0) {
    throw new Error(created.stderr.trim() || created.stdout.trim() || `venv exit ${created.code}`)
  }
  if (!pathExistsSync(venvPy)) throw new Error(`venv python missing: ${venvPy}`)
  onLog(`venv ready · Python ${host.version}`)
  return {
    python: { command: venvPy, prefix: [], source: 'venv', version: host.version, executable: venvPy },
    venvDir,
    rebuilt: true,
  }
}

const EXTRAS = {
  full: ['capstone>=5.0', 'unicorn>=2.0', 'lief>=0.14', 'z3-solver>=4.12'],
  angr: ['angr>=9.2'],
}

async function pipInstall(python, packages, onLog, env, extraArgs = []) {
  const pipArgs = [
    ...python.prefix, '-u', '-m', 'pip', 'install', '--upgrade',
    '--progress-bar', 'off',
    ...extraArgs,
    ...packages,
  ]
  onLog(`$ ${python.command} -m pip install ${[...extraArgs, ...packages].join(' ')}`)
  const pip = await runProcess(
    python.command,
    pipArgs,
    { timeoutMs: 15 * 60_000, env, onOutput: lineLogger(onLog) },
  )
  if (pip.code !== 0) {
    throw new Error((pip.stderr || pip.stdout).trim() || `pip exit ${pip.code}`)
  }
}

export async function installReverifyExtras(which = 'full', onLog = () => {}, env = process.env) {
  const angr = which === 'angr'
  const min = angr ? ANGR_MIN : { major: 3, minor: 8 }
  const { python, venvDir, rebuilt } = await ensureVenv(onLog, env, { min, recreate: false })
  if (angr && !versionAtLeast(python.version ?? '0.0', ANGR_MIN)) {
    throw new Error(
      `调用图引擎 angr 在 Python ${python.version} 上没有 macOS 官方 wheel，会去源码编译 unicorn 并卡死。请安装 Homebrew python@3.12 后再点加装。`,
    )
  }
  onLog(`升级 pip…`)
  await runProcess(
    python.command,
    [...python.prefix, '-u', '-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'],
    { timeoutMs: 180_000, env, onOutput: lineLogger(onLog) },
  )
  if (angr) {
    if (rebuilt) onLog('已用新 Python 重建 venv，先装 angr 官方 wheel，再补高精度引擎')
    // angr 自带 capstone/unicorn 钉死版本；不要和 capstone>=5.0 绑在一起解依赖。
    // --only-binary=angr 禁止源码编译 angr 本体，mulpyplexer 等纯 Python 包仍走 sdist。
    try {
      await pipInstall(python, EXTRAS.angr, onLog, env, ['--only-binary=angr'])
    } catch (error) {
      throw new Error(`angr 安装失败（需要 Python 3.12 官方 wheel）：${error.message}`.slice(0, 1200))
    }
    onLog('补装 lief / unicorn（angr 已自带 capstone 和 z3）…')
    await pipInstall(python, ['unicorn>=2.0', 'lief>=0.14'], onLog, env)
  } else {
    await pipInstall(python, EXTRAS.full, onLog, env)
  }
  onLog(`installed ${which} extras into ${venvDir}`)
  return probeReverify(env)
}

export async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export { existsSync }
