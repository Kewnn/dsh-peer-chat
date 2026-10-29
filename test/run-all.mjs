/**
 * run-all.mjs —— 顺序跑完 test/ 下所有 *.test.mjs，逐套报 PASS/FAIL 计数。
 *
 * 用法：
 *   node test/run-all.mjs                 # 跑全部
 *   node test/run-all.mjs token chain     # 只跑指定套件（按名字前缀）
 *   node test/run-all.mjs --timeout=60000 # 改每套超时（默认 120000ms）
 *
 * 约定：
 *   - 每套是**独立 node 进程**（互不污染模块级缓存，如自动发现的 30s 缓存）；
 *   - 每套 120s 硬超时：超时杀进程树、标 TIMEOUT、继续下一套；
 *   - 退出码：全 PASS 为 0，否则 1（CI 可直接用）；
 *   - 套件靠最后一行 `SUMMARY passed=… failed=… total=…` 报数，缺这行按 ERROR 处理。
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = dirname(TEST_DIR)
const DEFAULT_TIMEOUT_MS = 120_000
const SUMMARY_RE = /^SUMMARY passed=(\d+) failed=(\d+) total=(\d+)$/m

/** 解析命令行：位置参数=套件名前缀；--timeout=毫秒。 */
function parseArgs(argv) {
  const only = []
  let timeoutMs = DEFAULT_TIMEOUT_MS
  for (const arg of argv) {
    const match = /^--timeout=(\d+)$/.exec(arg)
    if (match !== null) {
      timeoutMs = Number(match[1])
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log('用法：node test/run-all.mjs [套件名…] [--timeout=毫秒]')
      process.exit(0)
    }
    only.push(arg)
  }
  return { only, timeoutMs }
}

/** 列出 test/ 下的测试文件；给了前缀就只留匹配的。 */
function listSuites(only) {
  const files = readdirSync(TEST_DIR)
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
  if (only.length === 0) return files
  return files.filter((file) => only.some((name) => file.startsWith(name)))
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* 下面再补一刀 */ }
  }
  try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
}

/** 跑一套，边跑边把子进程输出透传到本进程 stdout。 */
function runOne(file, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [join(TEST_DIR, file)], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    const collect = (chunk) => { output += chunk.toString() }
    child.stdout.on('data', (chunk) => { collect(chunk); process.stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { collect(chunk); process.stderr.write(chunk) })
    child.on('error', (error) => {
      output += `\n[spawn error] ${error.message}\n`
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const match = SUMMARY_RE.exec(output)
      const counts = match === null
        ? null
        : { passed: Number(match[1]), failed: Number(match[2]), total: Number(match[3]) }
      const failLines = output.split(/\r?\n/).filter((line) => line.startsWith('FAIL'))
      const state = timedOut ? 'TIMEOUT' : counts === null ? 'ERROR' : counts.failed > 0 ? 'FAIL' : 'PASS'
      resolve({ file, state, counts, failLines, code, timedOut, ms: Date.now() - started })
    })
  })
}

function pad(text, width) {
  const value = String(text)
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function padLeft(text, width) {
  const value = String(text)
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

async function main() {
  const { only, timeoutMs } = parseArgs(process.argv.slice(2))
  const suites = listSuites(only)
  if (suites.length === 0) {
    console.error(`没有匹配的测试文件（test/*.test.mjs）${only.length > 0 ? `：${only.join(', ')}` : ''}`)
    process.exit(2)
  }

  console.log(`dsh-peer-chat 测试 · ${suites.length} 套 · 每套超时 ${Math.round(timeoutMs / 1000)}s · node ${process.version}`)
  console.log(`目录：${TEST_DIR}\n`)

  const results = []
  for (const file of suites) {
    console.log(`\n${'═'.repeat(72)}\n▶ ${file}\n${'═'.repeat(72)}`)
    const result = await runOne(file, timeoutMs)
    results.push(result)

    const label = result.state === 'PASS' ? 'PASS   ' : result.state === 'FAIL' ? 'FAIL   ' : `${result.state.padEnd(7)}`
    const counts = result.counts === null
      ? '没有 SUMMARY 行'
      : `passed=${result.counts.passed} failed=${result.counts.failed} total=${result.counts.total}`
    console.log(`\n${label} ${file}  ${counts}  ${(result.ms / 1000).toFixed(1)}s`)
    if (result.timedOut) console.log(`       TIMEOUT：超过 ${Math.round(timeoutMs / 1000)}s，已杀进程树并继续下一套`)
    if (result.state === 'ERROR') console.log(`       子进程退出码=${result.code}，但没有输出 SUMMARY 行（看上面的输出定位）`)
  }

  // ── 汇总表 ────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}\n汇总\n${'═'.repeat(72)}`)
  console.log(`${pad('套件', 26)}${pad('结果', 9)}${padLeft('passed', 9)}${padLeft('failed', 9)}${padLeft('total', 8)}${padLeft('耗时', 9)}`)
  for (const result of results) {
    const name = result.file.replace(/\.test\.mjs$/, '')
    const counts = result.counts ?? { passed: 0, failed: 0, total: 0 }
    console.log(`${pad(name, 26)}${pad(result.state, 9)}${padLeft(counts.passed, 9)}${padLeft(counts.failed, 9)}${padLeft(counts.total, 8)}${padLeft(`${(result.ms / 1000).toFixed(1)}s`, 9)}`)
  }

  const totals = results.reduce((sum, result) => {
    const counts = result.counts ?? { passed: 0, failed: 0, total: 0 }
    return { passed: sum.passed + counts.passed, failed: sum.failed + counts.failed, total: sum.total + counts.total }
  }, { passed: 0, failed: 0, total: 0 })

  const bad = results.filter((result) => result.state !== 'PASS')
  console.log(`\n合计：${results.length - bad.length}/${results.length} 套 PASS ｜ passed=${totals.passed} failed=${totals.failed} total=${totals.total}`)

  if (bad.length > 0) {
    console.log('\n失败套件的 FAIL 行（便于直接定位断言）：')
    for (const result of bad) {
      console.log(`\n[${result.state}] ${result.file}`)
      if (result.failLines.length === 0) console.log('  （没有 FAIL 行：超时或子进程崩溃，见上方输出）')
      for (const line of result.failLines) console.log(`  ${line}`)
    }
  }

  process.exit(bad.length === 0 ? 0 : 1)
}

await main()
