import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import https from 'node:https'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const EXTRA_PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/Applications/Docker.app/Contents/Resources/bin',
  // Windows: Docker Desktop CLI lives under Program Files.
  'C:\\Program Files\\Docker\\Docker\\resources\\bin',
  'C:\\Program Files\\Docker\\Docker\\resources',
]
const DEFAULT_PENTEST_IMAGE = 'vxcontrol/kali-linux'
const DEFAULT_ADMIN = 'admin@pentagi.com'
const DEFAULT_PASSWORD = 'admin'
const LOCAL_PASSWORD = 'DshPentagi1!'
const DEFAULT_PORT = 8443
const RANDOM_PORT_MIN = 18000
const RANDOM_PORT_MAX = 29999
const LOCAL_EMBED_PORT = 63229
const LOCAL_EMBED_MODEL = 'BAAI/bge-small-en-v1.5'

function readPentagiSettings(env = process.env) {
  try {
    const settings = JSON.parse(readFileSync(join(userHome(env), 'desktop-settings.json'), 'utf8'))
    return settings?.coldbrew?.pentagi ?? {}
  } catch {
    return {}
  }
}

/** 同步读：环境变量 → 已保存设置 → 默认 8443。异步路径先用 ensureRandomListenPort 落盘。 */
export function pentagiListenPort(env = process.env) {
  const fromEnv = Number(env.PENTAGI_LISTEN_PORT || env.DSH_PENTAGI_PORT)
  if (fromEnv >= 1 && fromEnv <= 65535) return fromEnv
  const saved = Number(readPentagiSettings(env).port)
  if (saved >= 1 && saved <= 65535) return saved
  return DEFAULT_PORT
}

/** 探测某个 TCP 端口当前是否空闲（IPv4 回环，1s 超时）。 */
async function portFree(port) {
  return new Promise(resolve => {
    const net = createConnection({ host: '127.0.0.1', port, timeout: 900 })
    const done = ok => { net.destroy(); resolve(ok) }
    net.once('connect', () => done(false))
    net.once('timeout', () => done(true))
    net.once('error', () => done(true))
  })
}

async function pickRandomPort() {
  const span = RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1
  const tries = Math.min(span, 40)
  for (let i = 0; i < tries; i++) {
    const candidate = RANDOM_PORT_MIN + Math.floor(Math.random() * span)
    if (await portFree(candidate)) return candidate
  }
  return 22443
}

/** 查 docker 里是否已有名字带 pentagi 的容器，且对外端口映射了给定端口（= 端口被“自己”占用）。 */
async function pentagiContainerOwnsPort(port, env = process.env) {
  if (!port) return false
  const docker = which('docker', env)
  const probe = await run(docker, ['ps', '--format', '{{.Names}}|{{.Ports}}'], { timeoutMs: 8_000, env }).catch(() => null)
  if (!probe || !probe.ok) return false
  return probe.stdout.split('\n').some(line => {
    const [name, ports] = line.split('|')
    if (!/pentagi/i.test(name ?? '')) return false
    return (ports ?? '').includes(`:${port}->`)
  })
}

/**
 * 启动前调用一次：确保「对外监听端口」已确定并落盘。
 * 8443 太容易被其他程序占用，首次使用（或已保存端口被占）时在
 * 18000-29999 随机挑一个空闲端口写回设置，后续稳定复用。
 */
export async function ensureRandomListenPort(env = process.env, onLog = () => {}) {
  const fromEnv = Number(env.PENTAGI_LISTEN_PORT || env.DSH_PENTAGI_PORT)
  if (fromEnv >= 1 && fromEnv <= 65535) {
    if (readPentagiSettings(env).port !== fromEnv) savePentagiSettings({ port: fromEnv }, env)
    return fromEnv
  }
  const saved = Number(readPentagiSettings(env).port)
  if (saved >= 1 && saved <= 65535) {
    if (await portFree(saved)) return saved
    // 端口被占：先看是不是自己之前起的 pentagi 容器在听——是的话绝不换端口
    //（否则每次 start 都会把端口搬到新随机值，容器反复重建、API 永远等超时）。
    if (await pentagiContainerOwnsPort(saved, env)) return saved
    onLog(`端口 ${saved} 已被其他程序占用，换一个随机空闲端口…`)
    const next = await pickRandomPort()
    savePentagiSettings({ port: next }, env)
    return next
  }
  onLog('分配 PentAGI 对外端口（18000-29999 随机空闲端口，避开常用 8443）…')
  const picked = await pickRandomPort()
  savePentagiSettings({ port: picked }, env)
  return picked
}

export function pentagiApiUrl(env = process.env) {
  const fromEnv = String(env.DSH_PENTAGI_URL ?? env.PENTAGI_URL ?? '').trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  const saved = String(readPentagiSettings(env).url ?? '').trim()
  if (saved) return saved.replace(/\/$/, '')
  return `https://127.0.0.1:${pentagiListenPort(env)}`
}

export function pentagiStopOnExit(env = process.env) {
  const v = readPentagiSettings(env).stopOnExit
  return v !== false
}

export function pentagiSandboxEnabled(env = process.env) {
  if (String(env.DSH_PENTAGI_SANDBOX ?? '') === '1') return true
  if (String(env.DSH_PENTAGI_SANDBOX ?? '') === '0') return false
  return readPentagiSettings(env).sandbox !== false
}

export function pentagiDindEnabled(env = process.env) {
  if (String(env.DSH_PENTAGI_DIND ?? '') === '1') return true
  if (String(env.DSH_PENTAGI_DIND ?? '') === '0') return false
  const saved = readPentagiSettings(env).dind
  if (saved !== undefined) return saved === true
  // 未显式设置：跟随沙箱开关——开了 Kali 沙箱就默认带 DinD
  // （vxcontrol/kali-linux 镜像自带 docker CLI，挂 VM sock 即可用）。
  return pentagiSandboxEnabled(env)
}

/** Colima/Linux VM 内的 docker.sock。挂进 Kali 才能让容器里的 docker CLI 说话。macOS 转发 sock 对不上。 */
export function dockerSocketInVm() {
  return '/var/run/docker.sock'
}

function API_URL(env = process.env) {
  return pentagiApiUrl(env)
}

function userHome(env = process.env) {
  const configured = String(env.DSH_HOME ?? '').trim()
  if (!configured) return join(homedir(), '.dsh')
  return resolve(configured)
}

function dockerHost(env = process.env) {
  if (env.DOCKER_HOST) return env.DOCKER_HOST
  const colimaSock = join(homedir(), '.colima/default/docker.sock')
  if (existsSync(colimaSock)) return `unix://${colimaSock}`
  const desktopSock = join(homedir(), '.docker/run/docker.sock')
  if (existsSync(desktopSock)) return `unix://${desktopSock}`
  return env.DOCKER_HOST
}

function spawnEnv(env = process.env) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const path = [...EXTRA_PATH, env.PATH ?? process.env.PATH ?? ''].filter(Boolean).join(sep)
  const host = dockerHost(env)
  return { ...env, PATH: path, ...(host ? { DOCKER_HOST: host } : {}) }
}

function which(bin, env = process.env) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const dirs = [...EXTRA_PATH, ...(spawnEnv(env).PATH.split(sep))]
  // Windows: bare names resolve through PATHEXT (.exe/.cmd/.bat). Probe both
  // the bare file and common extensions so spawn never fails on "EINVAL".
  const exts = process.platform === 'win32'
    ? ['', '.exe', '.cmd', '.bat', '.ps1']
    : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, bin + ext)
      if (existsSync(p)) return p
    }
  }
  return bin
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const onLog = options.onLog
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      // 调用方显式传 env（如 composeEnv 已按需删掉 DOCKER_HOST）时直接透传；
      // 只有没传 env 的普通调用才做一次 PATH 扩展 + DOCKER_HOST 注入。
      env: options.env === undefined ? spawnEnv(process.env) : options.env,
      shell: false,
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolvePromise({ ok: false, code: -1, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms`.trim() })
    }, timeoutMs)
    const take = (chunk, sink) => {
      const text = chunk.toString()
      if (sink === 'out') stdout += text
      else stderr += text
      const line = text.trim()
      if (line) onLog?.(line)
    }
    child.stdout?.on('data', chunk => take(chunk, 'out'))
    child.stderr?.on('data', chunk => take(chunk, 'err'))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, code: -1, stdout, stderr: error.message })
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code: code ?? 1, stdout, stderr })
    })
  })
}

function pentagiRoot(env = process.env) {
  const candidates = [
    env.DSH_PENTAGI_ROOT,
    join(userHome(env), 'pentagi-src'),
    resolve(process.cwd(), 'vendor/pentagi'),
    '/Users/admin/pro-v4/vendor/pentagi',
    resolve(here, '../../../../vendor/pentagi'),
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'docker-compose.yml'))) return dir
  }
  return join(userHome(env), 'pentagi-src')
}

function insecureHttpsRequest(url, init = {}) {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url)
    const headers = { ...(init.headers ?? {}) }
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: init.method || 'GET',
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const headersMap = new Map(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')]))
        const getSetCookie = () => {
          const raw = res.headers['set-cookie']
          return Array.isArray(raw) ? raw : raw ? [raw] : []
        }
        resolvePromise({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          headers: {
            get: (name) => headersMap.get(String(name).toLowerCase()) ?? null,
            getSetCookie,
          },
          text: async () => buf.toString('utf8'),
          json: async () => JSON.parse(buf.toString('utf8')),
        })
      })
    })
    req.on('error', reject)
    if (init.body) req.write(init.body)
    req.end()
  })
}

async function insecureFetch(url, init = {}) {
  if (/^https:\/\/(127\.0\.0\.1|localhost)\b/i.test(url)) {
    return insecureHttpsRequest(url, init)
  }
  return fetch(url, init)
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function absorbSetCookie(jar, response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  for (const line of raw) {
    const pair = String(line).split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

function readCredentials(env = process.env) {
  const file = join(userHome(env), '.credentials.yaml')
  if (!existsSync(file)) return {}
  const out = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+):\s*(.+)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

function colimaSock() {
  return join(homedir(), '.colima/default/docker.sock')
}

function ensureEnvFile(root, env = process.env) {
  const dest = join(root, '.env')
  const example = join(root, '.env.example')
  if (!existsSync(dest) && existsSync(example)) copyFileSync(example, dest)
  const creds = readCredentials(env)
  const deepseek = creds.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || ''
  let text = existsSync(dest) ? readFileSync(dest, 'utf8') : ''
  const set = (key, value) => {
    if (value === undefined || value === null) return
    const re = new RegExp(`^${key}=.*$`, 'm')
    if (re.test(text)) text = text.replace(re, `${key}=${value}`)
    else text += `\n${key}=${value}\n`
  }
  const port = pentagiListenPort(env)
  set('PUBLIC_URL', `https://127.0.0.1:${port}`)
  set('SERVER_USE_SSL', 'true')
  set('PENTAGI_LISTEN_PORT', String(port))
  set('PENTAGI_LISTEN_IP', '127.0.0.1')
  // default 'salt' disables API token creation (see schema.resolvers.go)
  if (!/^COOKIE_SIGNING_SALT=(?!salt\b).+/m.test(text)) {
    set('COOKIE_SIGNING_SALT', 'dsh-pentagi-' + Math.random().toString(36).slice(2) + Date.now().toString(36))
  }
  // Inside the pentagi container the socket is always /var/run/docker.sock
  // (compose bind-mounts the host sock there). Never leak the host DOCKER_HOST.
  set('DOCKER_HOST', 'unix:///var/run/docker.sock')
  set('DOCKER_SOCKET', '/var/run/docker.sock')
  // colima 容器必须挂 VM 内 /var/run/docker.sock，不能挂 macOS 上的转发 sock。
  set('PENTAGI_DOCKER_SOCKET', '/var/run/docker.sock')
  // Official primary terminal defaults to debian:latest; pin Kali so specialists get nmap.
  if (!/^DOCKER_DEFAULT_IMAGE=\S+/m.test(text) || /^DOCKER_DEFAULT_IMAGE=\s*$/m.test(text)) {
    set('DOCKER_DEFAULT_IMAGE', DEFAULT_PENTEST_IMAGE)
  }
  if (!/^DOCKER_DEFAULT_IMAGE_FOR_PENTEST=\S+/m.test(text) || /^DOCKER_DEFAULT_IMAGE_FOR_PENTEST=\s*$/m.test(text)) {
    set('DOCKER_DEFAULT_IMAGE_FOR_PENTEST', DEFAULT_PENTEST_IMAGE)
  }
  if (!/^DOCKER_NET_ADMIN=\S+/m.test(text) || /^DOCKER_NET_ADMIN=\s*$/m.test(text)) {
    set('DOCKER_NET_ADMIN', 'true')
  }
  if (deepseek) {
    set('DEEPSEEK_API_KEY', deepseek)
    set('LLM_SERVER_URL', 'https://api.deepseek.com')
    set('LLM_SERVER_KEY', deepseek)
    set('LLM_SERVER_PROVIDER', 'openai')
    set('LLM_SERVER_MODEL', 'deepseek-chat')
  }
  if (!/^SCRAPER_PRIVATE_URL=https?:\/\/\S+/m.test(text)) {
    set('SCRAPER_PRIVATE_URL', 'https://someuser:somepass@scraper/')
  }
  if (!/^SCRAPER_PUBLIC_URL=https?:\/\/\S+/m.test(text)) {
    set('SCRAPER_PUBLIC_URL', 'https://someuser:somepass@host.docker.internal:9443/')
  }
  set('LOCAL_SCRAPER_USERNAME', 'someuser')
  set('LOCAL_SCRAPER_PASSWORD', 'somepass')
  mkdirSync(root, { recursive: true })
  writeFileSync(dest, text)
  return dest
}

export function pentagiEnvPath(env = process.env) {
  return join(pentagiRoot(env), '.env')
}

export function writePentagiEnvText(text, env = process.env) {
  const dest = pentagiEnvPath(env)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, text)
  return dest
}

function composeEnv(env = process.env) {
  const next = spawnEnv(env)
  // composeEnv 用于宿主 docker-compose 上下文（start/stop/ps）：
  // 绝不能让宿主路径 DOCKER_HOST 渗进 compose 插值——宿主路径只存在于
  // 宿主机器，pentagi 容器看到它只会连死（connect: no such file）。
  // 删掉 env 里的 DOCKER_HOST 后 compose 进程走默认 context（如 colima），
  // .env 里的 DOCKER_HOST=unix:///var/run/docker.sock（ensureEnvFile）
  // 仅传进 compose 文件，被挂载到 bind-mount /var/run/docker.sock 的容器使用。
  delete next.DOCKER_HOST
  next.PENTAGI_DOCKER_SOCKET = '/var/run/docker.sock'
  return next
}

let composeMode = 'unknown' // unknown | docker | legacy | missing（进程内缓存探测结果）

/**
 * 探测本机可用的 compose 形态：
 *  - 'docker'：`docker compose` 子命令可用（Docker Desktop / 新版 CLI 自带插件）；
 *  - 'legacy'：独立 `docker-compose` v2 二进制可用（brew 安装）；
 *  - 'missing'：都不可用。
 */
async function composeAvailable(docker, env) {
  if (composeMode !== 'unknown') return composeMode
  const probe = await run(docker, ['compose', 'version'], { timeoutMs: 8_000, env })
  if (probe.ok) {
    composeMode = 'docker'
    return composeMode
  }
  const legacy = which('docker-compose', env)
  composeMode = (legacy !== 'docker-compose' && existsSync(legacy)) ? 'legacy' : 'missing'
  return composeMode
}

/**
 * 统一 compose 执行：优先 `docker compose <args>`，退回 legacy `docker-compose <args>`。
 * 缺插件时返回明确报错（而不是把 `-d` 喂给裸 docker 产生 confusing 的 flag 错误）。
 */
async function runCompose(docker, cmdArgs, { env, cwd, timeoutMs, onLog } = {}) {
  const current = process.env ?? {}
  const e = env ?? current
  const mode = await composeAvailable(docker, e)
  if (mode === 'docker') {
    return run(docker, ['compose', ...cmdArgs], { cwd, env: e, timeoutMs, onLog })
  }
  if (mode === 'legacy') {
    const legacy = which('docker-compose', e)
    return run(legacy, cmdArgs, { cwd, env: e, timeoutMs, onLog })
  }
  return {
    ok: false,
    stderr: 'docker compose 插件不可用：macOS 装 Homebrew docker-compose（brew install docker-compose）或 Docker Desktop；Windows 用 Docker Desktop；Linux 装 docker-compose-plugin。然后重试。',
  }
}

export function hostArch() {
  const a = process.arch
  if (a === 'arm64' || a === 'aarch64') return 'arm64'
  return 'amd64'
}

function brewBin(env = process.env) {
  return which('brew', env)
}

/** Docker Desktop 安装路径（macOS / Windows），Windows 版也能被探测到。 */
function dockerDesktopApp() {
  if (process.platform === 'win32') return 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
  return '/Applications/Docker.app'
}

/** Windows 包管理器：优先 winget，其次 choco。返回可用命令名或 ''。 */
function windowsPackageManager(env = process.env) {
  const winget = which('winget', env)
  if (winget !== 'winget' && existsSync(winget)) return 'winget'
  const choco = which('choco', env)
  if (choco !== 'choco' && existsSync(choco)) return 'choco'
  return ''
}

async function installWindowsDockerDesktop(onLog, env) {
  const mgr = windowsPackageManager(env)
  if (!mgr) {
    return { ok: false, error: 'Windows 未找到 winget/choco。请先装 Docker Desktop（https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe）再点重试。' }
  }
  if (mgr === 'winget') {
    onLog('$ winget install Docker.DockerDesktop')
    const r = await run('winget', ['install', '--id', 'Docker.DockerDesktop', '-e', '--silent', '--scope', 'machine', '--accept-source-agreements', '--accept-package-agreements'], { timeoutMs: 20 * 60_000, env, onLog })
    if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'winget install failed' }
  } else {
    onLog('$ choco install docker-desktop -y')
    const r = await run('choco', ['install', 'docker-desktop', '-y'], { timeoutMs: 20 * 60_000, env, onLog })
    if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'choco install failed' }
  }
  return { ok: true }
}

/** 启动 Docker Desktop：macOS 用 open，Windows 直接起 exe。 */
async function openDockerDesktop(onLog, env = process.env) {
  onLog('发现 Docker Desktop，正在打开…')
  if (process.platform === 'win32') {
    const exe = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe')
    if (existsSync(exe)) return run(exe, [], { timeoutMs: 20_000, env, onLog })
    return run('cmd', ['/c', 'start', '', '"Docker Desktop"'], { timeoutMs: 20_000, env, onLog })
  }
  return run('open', ['-a', 'Docker'], { timeoutMs: 15_000, env, onLog })
}

/** 用一个最小镜像探 daemon 的 registry 解析是否可用（区分 DNS 死和普通失败）。 */
async function checkDaemonDns(docker, onLog, env) {
  onLog('$ docker pull hello-world（探 registry 连通）')
  const r = await run(docker, ['pull', '--quiet', 'hello-world:latest'], { timeoutMs: 90_000, env, onLog })
  if (r.ok) {
    return { ok: true }
  }
  const text = `${r.stderr || ''}\n${r.stdout || ''}`
  // DNS 死的典型指纹：lookup … connection refused / no such host / server misbehaving
  if (/lookup .* (connection refused|no such host|server misbehaving|i\/o timeout)/i.test(text)) {
    return { ok: false, dns: true, error: (r.stderr || r.stdout || '').split('\n').pop() }
  }
  return { ok: false, dns: false, error: (r.stderr || r.stdout || '').split('\n').pop() || 'pull failed' }
}

async function writeDaemonJsonDns(onLog, env) {
  const path = join(homedir(), '.docker', 'daemon.json')
  let conf = {}
  try { conf = JSON.parse(readFileSync(path, 'utf8')) } catch { conf = {} }
  conf.dns = ['8.8.8.8', '1.1.1.1', '223.5.5.5']
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(conf, null, 2))
  onLog(`已写 ${path} 的 dns: 8.8.8.8 / 1.1.1.1 / 223.5.5.5`)
  return path
}

function colimaYamlPath() {
  return join(homedir(), '.colima', process.platform === 'win32' ? '_lima' : 'default', 'colima.yaml')
}

/** Colima VM resolv 断链的自愈：写死公共 DNS + 重启 VM。 */
async function healColimaDns(onLog, env) {
  const yaml = join(homedir(), '.colima', 'default', 'colima.yaml')
  try {
    if (existsSync(yaml)) {
      const text = readFileSync(yaml, 'utf8')
      if (/^\s*dns:\s*null\s*$/m.test(text)) {
        const next = text.replace(/^\s*dns:\s*null\s*$/m, '  dns:\n    - 8.8.8.8\n    - 1.1.1.1')
        writeFileSync(yaml, next)
        onLog('已在 colima.yaml 写入显式 DNS')
      }
    }
  } catch { /* 继续 */ }
  await writeDaemonJsonDns(onLog, env)
  const colima = which('colima', env)
  onLog('$ colima restart（应用 DNS 配置）')
  const restarted = await run(colima, ['restart'], { timeoutMs: 300_000, env, onLog })
  if (!restarted.ok) return { ok: false, error: restarted.stderr || 'colima restart failed' }
  return { ok: true }
}

/** Docker 宿主 DNS 自愈（跨平台）：daemon 通但 registry 解析死时调用。 */
async function healDaemonDns(stack, onLog, env) {
  const colima = which('colima', env)
  const hasColima = (colima !== 'colima' && existsSync(colima)) || existsSync(join(homedir(), '.colima', 'default', 'colima.yaml'))
  if (hasColima) {
    onLog('检测到 Colima：用显式公共 DNS 修复 VM 解析…')
    const healed = await healColimaDns(onLog, env)
    if (!healed.ok) return healed
  } else if (process.platform === 'win32') {
    // Windows Docker Desktop（WSL2 后端）：杀掉重开 + 写 DNS 常能恢复解析。
    onLog('重启 Docker Desktop（WSL2 后端）以恢复 DNS…')
    try { await run('taskkill', ['/IM', 'Docker Desktop.exe', '/F'], { timeoutMs: 20_000, env, onLog }) } catch { /* not running */ }
    await openDockerDesktop(onLog, env)
    try { await writeDaemonJsonDns(onLog, env) } catch { /* 忽略 */ }
  } else if (process.platform === 'darwin') {
    onLog('重启 Docker Desktop 以恢复 DNS…')
    try { await run('osascript', ['-e', 'tell application "Docker" to quit'], { timeoutMs: 20_000, env, onLog }) } catch { /* not running */ }
    await openDockerDesktop(onLog, env)
    try { await writeDaemonJsonDns(onLog, env) } catch { /* 忽略 */ }
  } else {
    return { ok: false, error: 'registry 解析失败。Linux 原生 docker 请在 /etc/docker/daemon.json 加 {"dns":["8.8.8.8","1.1.1.1"]} 后 sudo systemctl restart docker，再重试。' }
  }
  const docker = which('docker', env)
  const verify = await checkDaemonDns(docker, onLog, env)
  if (verify.ok) {
    onLog('DNS 已恢复，registry 可达')
    return { ok: true }
  }
  return { ok: false, error: `DNS 自动修复后仍失败：${verify.error}。手动办法：Docker Desktop → Settings → Resources → Network → DNS 固定为 8.8.8.8 后重启。` }
}

export async function probeDockerStack(env = process.env) {
  const docker = which('docker', env)
  const colima = which('colima', env)
  const brew = brewBin(env)
  const dockerCli = docker !== 'docker' && existsSync(docker)
  const colimaCli = colima !== 'colima' && existsSync(colima)
  const brewOk = brew !== 'brew' && existsSync(brew)
  const desktop = existsSync(dockerDesktopApp())
  const version = dockerCli ? await run(docker, ['--version'], { timeoutMs: 5_000, env }) : { ok: false }
  const daemon = dockerCli ? await run(docker, ['info'], { timeoutMs: 8_000, env }) : { ok: false }
  const images = {}
  if (daemon.ok) {
    for (const name of ['vxcontrol/kali-linux', 'vxcontrol/pentagi:latest', 'vxcontrol/pgvector:latest', 'vxcontrol/scraper:latest']) {
      const inspect = await run(docker, ['image', 'inspect', name, '--format', '{{.Os}}/{{.Architecture}}'], { timeoutMs: 8_000, env })
      images[name] = inspect.ok ? inspect.stdout.trim() : ''
    }
  }
  return {
    os: process.platform,
    arch: hostArch(),
    dockerCli,
    dockerBin: dockerCli ? docker : '',
    colimaCli,
    brew: brewOk,
    dockerDesktop: desktop,
    daemon: daemon.ok,
    version: version.ok ? version.stdout.trim() : '',
    images,
    ready: dockerCli && daemon.ok,
  }
}

async function installBrewPackages(packages, onLog, env) {
  const brew = brewBin(env)
  if (brew === 'brew' || !existsSync(brew)) {
    return { ok: false, error: 'Homebrew 未安装。请先安装 https://brew.sh 或安装 Docker Desktop。' }
  }
  onLog(`$ brew install ${packages.join(' ')}  (${hostArch()})`)
  const installed = await run(brew, ['install', ...packages], { timeoutMs: 15 * 60_000, env, onLog })
  if (!installed.ok) {
    const upgraded = await run(brew, ['upgrade', ...packages], { timeoutMs: 15 * 60_000, env, onLog })
    if (!upgraded.ok) return { ok: false, error: installed.stderr || upgraded.stderr || 'brew install failed' }
  }
  return { ok: true }
}

async function startColima(onLog, env) {
  const colima = which('colima', env)
  const arch = hostArch() === 'arm64' ? 'aarch64' : 'x86_64'
  const args = ['start', '--arch', arch]
  if (process.platform === 'darwin' && hostArch() === 'arm64') args.push('--vm-type', 'vz')
  onLog(`$ colima ${args.join(' ')}`)
  const started = await run(colima, args, { timeoutMs: 8 * 60_000, env, onLog })
  if (started.ok) return started
  onLog('指定参数启动失败，改用 colima start 默认配置…')
  return run(colima, ['start'], { timeoutMs: 8 * 60_000, env, onLog })
}

async function pullPentagiImages(docker, onLog, env) {
  const names = ['vxcontrol/kali-linux', 'vxcontrol/pentagi:latest', 'vxcontrol/pgvector:latest', 'vxcontrol/scraper:latest']
  const results = []
  for (const name of names) {
    onLog(`$ docker pull --platform linux/${hostArch()} ${name}`)
    const pulled = await run(docker, ['pull', '--platform', `linux/${hostArch()}`, name], { timeoutMs: 20 * 60_000, env, onLog })
    results.push({ name, ok: pulled.ok, error: pulled.ok ? undefined : (pulled.stderr || pulled.stdout || '').split('\n').pop() })
    if (!pulled.ok) onLog(`pull ${name} 失败：${results.at(-1).error}`)
  }
  return results
}

export async function installDockerStack(onLog = () => {}, env = process.env, { pullImages = true } = {}) {
  await ensureRandomListenPort(env, onLog)
  onLog(`本机 ${process.platform}/${hostArch()}，开始检查 Docker…`)
  let stack = await probeDockerStack(env)
  if (stack.ready) {
    onLog('Docker daemon 已就绪')
    // daemon 虽通，registry 解析可能坏的（Colima VM resolv 断链之类）：
    // 拉个 13KB hello-world 探一下，不行就自动修 DNS 再继续。
    const dns = await checkDaemonDns(stack.dockerBin, onLog, env)
    if (!dns.ok) {
      const healed = await healDaemonDns(stack, onLog, env)
      if (!healed.ok) return { ok: false, error: healed.error, stack: await probeDockerStack(env) }
      stack = await probeDockerStack(env)
    }
    const docker = stack.dockerBin
    const images = pullImages ? await pullPentagiImages(docker, onLog, env) : []
    return { ok: true, installed: false, stack: await probeDockerStack(env), images }
  }

  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
    return { ok: false, error: `暂不自动安装 ${process.platform} 上的 Docker，请手动安装 Docker / 容器引擎。`, stack }
  }

  // Windows：winget/choco 装 Docker Desktop，然后打开并等 daemon。
  if (process.platform === 'win32') {
    if (!stack.dockerDesktop && !stack.dockerCli) {
      const installed = await installWindowsDockerDesktop(onLog, env)
      if (!installed.ok) return { ...installed, stack }
      stack = await probeDockerStack(env)
    }
    if (!stack.daemon) {
      await openDockerDesktop(onLog, env)
      const docker = which('docker', env)
      const info = await waitForDocker(docker, env, onLog, 240_000)
      if (!info.ok) return { ok: false, error: info.stderr || 'docker still unreachable', stack: await probeDockerStack(env) }
      stack = await probeDockerStack(env)
    }
  } else if (!stack.dockerCli || !stack.colimaCli) {
    const pkgs = []
    if (!stack.dockerCli) pkgs.push('docker')
    if (!stack.colimaCli && !stack.dockerDesktop) pkgs.push('colima')
    if (pkgs.length) {
      const brew = await installBrewPackages(pkgs, onLog, env)
      if (!brew.ok && !stack.dockerDesktop) return { ...brew, stack }
    }
  }

  if (stack.dockerDesktop && !stack.daemon) {
    await openDockerDesktop(onLog, env)
  } else if (!stack.daemon && process.platform !== 'win32') {
    const colima = which('colima', env)
    if (colima === 'colima' || !existsSync(colima)) {
      return { ok: false, error: 'docker CLI 或 colima 仍未找到。请安装 Homebrew 后重试，或安装 Docker Desktop。', stack: await probeDockerStack(env) }
    }
    const status = await run(colima, ['status'], { timeoutMs: 15_000, env, onLog })
    const running = /colima is running/i.test(status.stdout + status.stderr)
    if (running) {
      onLog('colima 已 Running，执行 restart 打通 sock…')
      const restarted = await run(colima, ['restart'], { timeoutMs: 240_000, env, onLog })
      if (!restarted.ok) return { ok: false, error: restarted.stderr || 'colima restart failed', stack }
    } else {
      const started = await startColima(onLog, env)
      if (!started.ok) return { ok: false, error: started.stderr || 'colima start failed', stack }
    }
  }

  const docker = which('docker', env)
  const info = await waitForDocker(docker, env, onLog, 180_000)
  if (!info.ok) return { ok: false, error: info.stderr || 'docker still unreachable', stack: await probeDockerStack(env) }
  onLog('Docker daemon 已通')
  const images = pullImages ? await pullPentagiImages(docker, onLog, env) : []
  return { ok: true, installed: true, stack: await probeDockerStack(env), images }
}

async function waitForDocker(docker, env, onLog, timeoutMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const info = await run(docker, ['info'], { timeoutMs: 8_000, env })
    if (info.ok) return info
    onLog?.('等待 docker.sock…')
    await new Promise(r => setTimeout(r, 2000))
  }
  return { ok: false, stderr: 'docker.sock never became ready' }
}

async function ensureDocker(onLog, env = process.env) {
  const docker = which('docker', env)
  const info = await run(docker, ['info'], { timeoutMs: 8_000, env })
  if (info.ok) return { ok: true, docker, daemon: true }
  onLog?.('Docker 未就绪，开始按本机架构安装/启动…')
  const installed = await installDockerStack(onLog, env, { pullImages: false })
  if (!installed.ok) return { ok: false, docker, daemon: false, error: installed.error }
  return { ok: true, docker: which('docker', env), daemon: true }
}

async function waitForApi(onLog, timeoutMs = 180_000, env = process.env) {
  const start = Date.now()
  const url = API_URL(env)
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await insecureFetch(url, { redirect: 'follow' })
      if (res.ok || res.status === 401 || res.status === 302 || res.status === 200) {
        onLog?.(`API 已起来 · HTTP ${res.status}`)
        return { ok: true, status: res.status }
      }
    } catch { /* still booting */ }
    await new Promise(r => setTimeout(r, 3000))
  }
  return { ok: false, error: `timed out waiting for ${url}` }
}

async function bootstrapToken(onLog, env = process.env) {
  const jar = new Map()
  const base = API_URL(env)
  const login = await insecureFetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mail: DEFAULT_ADMIN, password: DEFAULT_PASSWORD }),
  })
  absorbSetCookie(jar, login)
  const loginText = await login.text()
  onLog?.(`login ${login.status}`)
  if (login.ok && jar.size) {
    const changed = await insecureFetch(`${base}/api/v1/user/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
      body: JSON.stringify({
        current_password: DEFAULT_PASSWORD,
        password: LOCAL_PASSWORD,
        confirm_password: LOCAL_PASSWORD,
      }),
    })
    absorbSetCookie(jar, changed)
    onLog?.(`password change ${changed.status}`)
  } else {
    const retry = await insecureFetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mail: DEFAULT_ADMIN, password: LOCAL_PASSWORD }),
    })
    absorbSetCookie(jar, retry)
    onLog?.(`login-with-local-password ${retry.status}`)
    if (!retry.ok) return { ok: false, error: `login failed: ${loginText.slice(0, 400)}` }
  }
  const minted = await insecureFetch(`${base}/api/v1/tokens/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ name: `dsh-harness-${Date.now()}`, ttl: 94_608_000 }),
  })
  const body = await minted.json().catch(() => null)
  const token = body?.data?.token
  if (!token) return { ok: false, error: `create token failed: ${JSON.stringify(body).slice(0, 500)}`, status: minted.status }
  return { ok: true, token, password: LOCAL_PASSWORD }
}

export async function pentagiGraphql(query, variables = {}, env = process.env) {
  const cfg = readPentagiSettings(env)
  const token = String(cfg.token || env.DSH_PENTAGI_TOKEN || '')
  const url = `${API_URL(env)}/api/v1/graphql`
  if (!token) return { ok: false, error: 'missing token', url }
  const body = JSON.stringify({ query, variables })
  try {
    const res = await insecureFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* */ }
    return { ok: res.ok && !json?.errors, status: res.status, url, json, body: text.slice(0, 8000) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), url }
  }
}

function persistToken(token, env = process.env) {
  const dest = join(userHome(env), 'desktop-settings.json')
  let settings = {}
  try { settings = JSON.parse(readFileSync(dest, 'utf8')) } catch { settings = {} }
  settings.coldbrew ??= {}
  settings.coldbrew.pentagi ??= {}
  settings.coldbrew.pentagi.token = token
  settings.coldbrew.pentagi.url = API_URL(env)
  settings.coldbrew.pentagi.port = pentagiListenPort(env)
  mkdirSync(userHome(env), { recursive: true })
  writeFileSync(dest, JSON.stringify(settings, null, 2))
  return dest
}

async function apiIsUp(env = process.env) {
  const url = API_URL(env)
  try {
    const res = await insecureFetch(url, { redirect: 'follow' })
    return { ok: res.ok || res.status === 401 || res.status === 302 || res.status === 200, url, status: res.status }
  } catch (error) {
    return { ok: false, url, error: String(error?.cause?.message ?? error?.message ?? error) }
  }
}

/**
 * First-install / expired-token path: if :8443 is already up, login and mint a
 * GraphQL Bearer into ~/.dsh/desktop-settings.json. Does not start compose
 * (that is autostart / pg_backend_start). Missing token + API down → caller stubs.
 */
export async function ensurePentagiApiToken(onLog = () => {}, env = process.env, { force = false } = {}) {
  const existing = String(readPentagiSettings(env).token || env.DSH_PENTAGI_TOKEN || '').trim()
  const probe = await apiIsUp(env)
  if (existing && !force) {
    if (!probe.ok) return { ok: true, token: existing, minted: false, api: probe, note: 'using saved token; api not probed live' }
    return { ok: true, token: existing, minted: false, api: probe }
  }
  if (!probe.ok) {
    return { ok: false, error: probe.error || `pentagi api is not reachable at ${probe.url}`, url: probe.url, api: probe }
  }
  onLog('登录默认账号并签发 GraphQL API Token…')
  const boot = await bootstrapToken(onLog, env)
  if (!boot.ok) return { ...boot, api: probe }
  persistToken(boot.token, env)
  onLog('token 已写入 ~/.dsh/desktop-settings.json')
  return { ok: true, token: boot.token, minted: true, api: probe }
}

export async function probePentagiRuntime(env = process.env) {
  const dockerBin = which('docker', env)
  const docker = await run(dockerBin, ['--version'], { timeoutMs: 5_000, env })
  const daemon = docker.ok ? await run(dockerBin, ['info'], { timeoutMs: 8_000, env }) : { ok: false }
  const root = pentagiRoot(env)
  const cfg = readPentagiSettings(env)
  const url = API_URL(env)
  let api = { ok: false, url }
  try {
    const res = await insecureFetch(url, { redirect: 'follow' })
    api = { ok: res.ok || res.status === 401 || res.status === 302, url, status: res.status }
  } catch (error) {
    api = { ok: false, url, error: String(error?.cause?.message ?? error?.message ?? error) }
  }
  const tokenPresent = Boolean(cfg.token)
  let compose = { ok: false }
  if (daemon.ok && existsSync(join(root, 'docker-compose.yml'))) {
    const ps = await runCompose(dockerBin, ['ps', '--format', 'json'], { cwd: root, timeoutMs: 15_000, env })
    compose = { ok: ps.ok, running: /pentagi/.test(ps.stdout), raw: ps.stdout.slice(0, 500) }
  }
  const image = pentestImage(env)
  const sandboxEnabled = pentagiSandboxEnabled(env)
  const dindEnabled = pentagiDindEnabled(env)
  let sandbox = {
    enabled: sandboxEnabled,
    ok: false,
    image,
    source: 'https://github.com/vxcontrol/kali-linux-image',
    work: join(userHome(env), 'pentagi', 'sandbox-work'),
    dind: { enabled: dindEnabled, ok: false, socket: dockerSocketInVm() },
  }
  if (daemon.ok) {
    const inspect = await run(dockerBin, ['image', 'inspect', image, '--format', '{{.Os}}/{{.Architecture}}'], { timeoutMs: 8_000, env })
    sandbox.ok = inspect.ok
    sandbox.inspect = inspect.stdout.trim() || inspect.stderr.slice(0, 400)
    sandbox.dind = {
      enabled: dindEnabled,
      ok: dindEnabled && inspect.ok,
      socket: dockerSocketInVm(),
      mode: 'colima-vm-socket',
      note: dindEnabled
        ? 'Kali 内 docker CLI 走 VM /var/run/docker.sock（开发机 DinD；不是独立加固 daemon）'
        : '关闭时 Kali 里没有 docker daemon',
    }
  }
  return {
    version: '1.0.0',
    source: 'https://github.com/vxcontrol/pentagi',
    root,
    docker: docker.ok
      ? { ok: true, version: docker.stdout.trim(), daemon: daemon.ok, bin: dockerBin }
      : { ok: false, error: docker.stderr || 'docker not found', daemon: false, bin: dockerBin },
    dockerStack: {
      os: process.platform,
      arch: hostArch(),
      brew: brewBin(env) !== 'brew' && existsSync(brewBin(env)),
      dockerDesktop: existsSync(dockerDesktopApp()),
      colima: which('colima', env) !== 'colima' && existsSync(which('colima', env)),
    },
    api,
    tokenPresent,
    port: pentagiListenPort(env),
    stopOnExit: pentagiStopOnExit(env),
    autostart: cfg.autostart !== false,
    compose,
    sandbox,
    backendReady: Boolean((api.ok || compose.running) && tokenPresent),
    harnessProvider: cfg.harnessProvider || 'auto',
    embedding: {
      source: embeddingSource(cfg),
      apiUrl: String(cfg.embeddingApiUrl || ''),
      apiModel: String(cfg.embeddingApiModel || 'text-embedding-3-small'),
      hasKey: Boolean(String(cfg.embeddingApiKey || '').trim()),
      local: await probeLocalEmbed(env),
      fastembed: await probeFastembedInstalled(env).catch(() => ({ ok: false })),
      port: localEmbedPort(env),
      model: LOCAL_EMBED_MODEL,
    },
  }
}

export function embeddingSource(cfg = {}) {
  const raw = String(cfg.embeddingSource || 'none').trim()
  if (raw === 'local' || raw === 'api') return raw
  return 'none'
}

export function pentestImage(env = process.env) {
  return String(env.DOCKER_DEFAULT_IMAGE_FOR_PENTEST || env.DSH_PENTAGI_PENTEST_IMAGE || DEFAULT_PENTEST_IMAGE)
}

export function localEmbedPort(env = process.env) {
  const n = Number(env.DSH_EMBED_PORT)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : LOCAL_EMBED_PORT
}

export function localEmbedUrl(env = process.env) {
  return `http://127.0.0.1:${localEmbedPort(env)}/v1`
}

export function localEmbedContainerUrl(env = process.env) {
  return `http://host.docker.internal:${localEmbedPort(env)}/v1`
}

async function probeLocalEmbed(env = process.env) {
  try {
    const res = await fetch(`${localEmbedUrl(env)}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, status: res.status, json: await res.json().catch(() => ({})) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

function embedderScript() {
  const src = join(here, 'embedder-server.py')
  if (existsSync(src)) return src
  return join(here, '..', 'src', 'embedder-server.py')
}

function pythonBin(env = process.env) {
  return which('python3', env)
}

let fastembedCache = { at: 0, value: null }

export async function probeFastembedInstalled(env = process.env, { fresh = false } = {}) {
  if (!fresh && fastembedCache.value && Date.now() - fastembedCache.at < 30_000) return fastembedCache.value
  const py = pythonBin(env)
  const probe = await run(py, ['-c', 'import fastembed'], { timeoutMs: 8_000, env })
  const value = { ok: probe.ok, python: py, error: probe.ok ? undefined : (probe.stderr || probe.stdout || 'fastembed not installed') }
  fastembedCache = { at: Date.now(), value }
  return value
}

async function ensureFastembed(onLog, env = process.env) {
  const already = await probeFastembedInstalled(env)
  if (already.ok) return { ok: true, installed: false, python: already.python }
  const py = already.python
  onLog('本机尚未安装 fastembed，正在 pip install（第一次大约几十秒到几分钟）…')
  const pip = await run(py, ['-m', 'pip', 'install', '--user', '--upgrade', 'fastembed'], { timeoutMs: 10 * 60_000, env, onLog })
  if (!pip.ok) {
    return { ok: false, python: py, error: pip.stderr || pip.stdout || 'pip install fastembed failed' }
  }
  const again = await probeFastembedInstalled(env, { fresh: true })
  if (!again.ok) return { ok: false, python: py, error: 'fastembed import still failing after pip install' }
  return { ok: true, installed: true, python: py }
}

function embedderLogPath(env = process.env) {
  return join(userHome(env), 'pentagi', 'embedder.log')
}

export async function ensureLocalEmbedder(onLog = () => {}, env = process.env) {
  const live = await probeLocalEmbed(env)
  if (live.ok) return { ok: true, started: false, url: localEmbedUrl(env), containerUrl: localEmbedContainerUrl(env), model: LOCAL_EMBED_MODEL }
  const script = embedderScript()
  if (!existsSync(script)) return { ok: false, error: `missing ${script}` }
  const deps = await ensureFastembed(onLog, env)
  if (!deps.ok) return { ok: false, error: deps.error || 'python3 / fastembed missing' }
  const py = deps.python
  mkdirSync(join(userHome(env), 'pentagi'), { recursive: true })
  const logFile = embedderLogPath(env)
  const logFd = { write: (line) => { try { writeFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { flag: 'a' }) } catch { /* ignore */ } } }
  onLog('正在启动本机向量服务；第一次会下载约 270MB 模型，请等健康检查通过…')
  const child = spawn(py, [script], {
    env: {
      ...spawnEnv(env),
      DSH_EMBED_BIND: '127.0.0.1',
      DSH_EMBED_PORT: String(localEmbedPort(env)),
      DSH_EMBED_MODEL: LOCAL_EMBED_MODEL,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  onLog(`local embedder pid ${child.pid} → ${localEmbedUrl(env)}`)
  logFd.write(`spawn pid=${child.pid}`)
  // First boot downloads the ONNX weights inside Python; 20s is not enough.
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2_000))
    const again = await probeLocalEmbed(env)
    if (again.ok) {
      onLog('本机向量服务已就绪')
      return { ok: true, started: true, installed: deps.installed, pid: child.pid, url: localEmbedUrl(env), containerUrl: localEmbedContainerUrl(env), model: LOCAL_EMBED_MODEL }
    }
    if (i === 14 || i === 44 || i === 74) onLog(`仍在等待模型加载… ${i * 2}s`)
  }
  return { ok: false, error: 'local embedder did not become healthy (first install can take several minutes; check python3 and network)', pid: child.pid, url: localEmbedUrl(env) }
}

export async function stopLocalEmbedder(onLog = () => {}, env = process.env) {
  const port = localEmbedPort(env)
  const listed = await run(which('lsof', env), ['-ti', `tcp:${port}`], { timeoutMs: 5_000, env })
  const pids = listed.stdout.split(/\s+/).map(s => s.trim()).filter(Boolean)
  if (!pids.length) return { ok: true, stopped: false, note: 'not running' }
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM') } catch { /* gone */ }
  }
  onLog(`stopped local embedder on :${port} (${pids.join(',')})`)
  return { ok: true, stopped: true, pids }
}

export async function resolveEmbeddingForEnv(onLog = () => {}, env = process.env) {
  const cfg = readPentagiSettings(env)
  const source = embeddingSource(cfg)
  if (source === 'api') {
    const apiUrl = String(cfg.embeddingApiUrl || '').replace(/\/$/, '')
    const apiKey = String(cfg.embeddingApiKey || '').trim()
    const apiModel = String(cfg.embeddingApiModel || 'text-embedding-3-small').trim()
    if (!apiUrl || !apiKey) return { ok: false, source, error: 'embedding API url/key missing' }
    return {
      ok: true,
      source,
      provider: 'openai',
      url: apiUrl.replace('127.0.0.1', 'host.docker.internal').replace('localhost', 'host.docker.internal'),
      key: apiKey,
      model: apiModel,
    }
  }
  if (source === 'local') {
    const live = await probeLocalEmbed(env)
    if (!live.ok) {
      return { ok: false, source, error: 'local embedder is not running; start it from the PentAGI panel' }
    }
    return {
      ok: true,
      source,
      provider: 'openai',
      url: localEmbedContainerUrl(env),
      key: 'sk-dsh-local-embed',
      model: LOCAL_EMBED_MODEL,
    }
  }
  await stopLocalEmbedder(() => {}, env)
  return { ok: false, source: 'none' }
}

export function savePentagiSettings(patch = {}, env = process.env) {
  const dest = join(userHome(env), 'desktop-settings.json')
  let settings = {}
  try { settings = JSON.parse(readFileSync(dest, 'utf8')) } catch { settings = {} }
  settings.coldbrew ??= {}
  settings.coldbrew.pentagi ??= {}
  Object.assign(settings.coldbrew.pentagi, patch)
  if (patch.port) {
    settings.coldbrew.pentagi.url = `https://127.0.0.1:${Number(patch.port)}`
  }
  mkdirSync(userHome(env), { recursive: true })
  writeFileSync(dest, JSON.stringify(settings, null, 2))
  return settings.coldbrew.pentagi
}

export async function startPentagiRuntime(onLog = () => {}, env = process.env) {
  // 启动前先把对外端口选好并落盘（随机空闲端口，避开 8443），compose 与 probe 都读同一个。
  await ensureRandomListenPort(env, onLog)
  const dockerReady = await ensureDocker(onLog, env)
  if (!dockerReady.ok) throw new Error(dockerReady.error || 'docker daemon not running')
  let root = pentagiRoot(env)
  if (!existsSync(join(root, 'docker-compose.yml'))) {
    onLog(`clone pentagi → ${root}`)
    mkdirSync(dirname(root), { recursive: true })
    const cloned = await run(which('git', env), ['clone', '--depth', '1', 'https://github.com/vxcontrol/pentagi.git', root], {
      timeoutMs: 180_000, env, onLog,
    })
    if (!cloned.ok) throw new Error(cloned.stderr || 'git clone failed')
  }
  ensureEnvFile(root, env)
  let harnessLlm = null
  try {
    const { inspectHarnessLlms, pickHarnessLlm, applyLlmToEnvText, llmFingerprint, syncGraphqlProviders } = await import('./pentagi-providers.mjs')
    const inspected = await inspectHarnessLlms(env)
    const pick = pickHarnessLlm(inspected, env)
    if (pick) {
      const dest = join(root, '.env')
      const prev = existsSync(dest) ? readFileSync(dest, 'utf8') : ''
      const embedding = await resolveEmbeddingForEnv(onLog, env)
      const next = applyLlmToEnvText(prev, pick, { embedding })
      if (next !== prev) {
        writeFileSync(dest, next)
        onLog(`同步 Harness 模型 ${pick.displayName}/${pick.probe?.model || pick.model} → LLM_SERVER_*`)
      }
      harnessLlm = { pick, inspected, fingerprint: llmFingerprint(pick), embedding }
    } else {
      onLog('Harness 里没有带 key 的模型，PentAGI 仍用 .env 现有 LLM')
    }
  } catch (error) {
    onLog(`同步 Harness 模型失败：${error?.message ?? error}`)
  }
  let up = { ok: false, stderr: '', stdout: '' }
  for (let attempt = 1; attempt <= 4; attempt++) {
    onLog(`$ docker compose up -d  (${root})  attempt ${attempt}/4`)
    up = await runCompose(dockerReady.docker, ['up', '-d'], { cwd: root, timeoutMs: 15 * 60_000, env: composeEnv(env), onLog })
    if (up.ok) break
    onLog(`compose 失败，20s 后重试：${(up.stderr || up.stdout || '').split('\n').pop()}`)
    await new Promise(r => setTimeout(r, 20_000))
  }
  if (!up.ok) throw new Error(up.stderr || up.stdout || 'docker compose up failed')
  const api = await waitForApi(onLog, 180_000, env)
  if (!api.ok) throw new Error(api.error)
  const boot = await ensurePentagiApiToken(onLog, env)
  if (!boot.ok) throw new Error(boot.error)
  if (harnessLlm?.pick) {
    try {
      const { syncGraphqlProviders } = await import('./pentagi-providers.mjs')
      const synced = await syncGraphqlProviders(harnessLlm.pick, harnessLlm.inspected, env)
      onLog(synced.ok
        ? `GraphQL provider ${synced.name} 已对齐（${synced.model}）`
        : `GraphQL provider 同步失败：${JSON.stringify(synced.upsert?.errors || synced.error || synced).slice(0, 240)}`)
    } catch (error) {
      onLog(`GraphQL provider 同步失败：${error?.message ?? error}`)
    }
  }
  const status = await probePentagiRuntime(env)
  return {
    ...status,
    harnessLlm: harnessLlm && {
      pick: { id: harnessLlm.pick.id, model: harnessLlm.pick.probe?.model || harnessLlm.pick.model, healthy: harnessLlm.pick.healthy },
      embedding: harnessLlm.embedding && { ok: harnessLlm.embedding.ok, source: harnessLlm.embedding.source, url: harnessLlm.embedding.url },
    },
  }
}

export async function stopPentagiRuntime(onLog = () => {}, env = process.env) {
  const docker = which('docker', env)
  const root = pentagiRoot(env)
  if (!existsSync(join(root, 'docker-compose.yml'))) throw new Error(`pentagi root missing: ${root}`)
  onLog(`$ docker compose down  (${root})`)
  const down = await runCompose(docker, ['down'], { cwd: root, timeoutMs: 180_000, env: composeEnv(env), onLog })
  if (!down.ok) throw new Error(down.stderr || 'docker compose down failed')
  return probePentagiRuntime(env)
}

export {
  API_URL as PENTAGI_API_URL,
  which as whichBin,
  DEFAULT_PORT as PENTAGI_DEFAULT_PORT,
  DEFAULT_PENTEST_IMAGE,
  LOCAL_EMBED_MODEL,
  dockerHost,
  spawnEnv,
  which as whichDocker,
}
