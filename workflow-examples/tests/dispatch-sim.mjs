// 总调度模拟验证：用模拟节点替换 RUNNERS，执行的是 bowen-feature.js 中真实的总调度代码。
// 不调用模型（agent / parallel 被替换为直接抛错并计数）、不启动浏览器、不调用 Codex、不读写项目文件。
// 用法：node workflow-examples/tests/dispatch-sim.mjs
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, appendFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'bowen-feature.js'), 'utf8')

// 只做三处文本替换：去掉 export；让 RUNNERS 可以被模拟节点整体替换，或（__partial）只替换其中几个节点。生产脚本本身不变。
const marker = 'const RUNNERS = {'
const endMarker = '  W8: runW8,\n}\n'
if (source.split(marker).length !== 2 || source.split(endMarker).length !== 2) throw new Error('找不到唯一的 RUNNERS 定义')
const body = source.replace('export const meta', 'const meta')
  .replace(marker, 'const RUNNERS = __mockRunners && !__mockRunners.__partial ? __mockRunners : __merge(__mockRunners, {')
  .replace(endMarker, '  W8: runW8,\n})\n')
const __merge = (mock, real) => { const out = { ...real, ...(mock || {}) }; delete out.__partial; return out }
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const raw = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', '__mockRunners', '__merge', 'workflow', body)
// workflow({scriptPath})：与运行时一致，读取脚本文件并执行，返回其 return 值（只用于加载 export-records 生成的数据脚本）
const simWorkflow = async (ref) => {
  const text = readFileSync(ref.scriptPath, 'utf8')
  return new AsyncFunction(text.replace(/^export const meta = /m, 'const meta = '))()
}
const dispatcher = (args, agent, phase, log, parallel, mock, wf = simWorkflow) => raw(args, agent, phase, log, parallel, mock, __merge, wf)

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const cmdOf = (prompt) => { const m = prompt.match(/<<<CMD\n([\s\S]*?)\nCMD>>>/); return m ? m[1] : null }
// 第一、二部分用的结果保存桩：不写文件，只按工具的输出格式回答（结果哈希由 Node 重新计算，用来核对调度器的 sha256）
function fakeRecord(prompt) {
  const cmd = cmdOf(prompt)
  const m = cmd.match(/ record '([^']*)' '([^']*)' '([^']*)' ([0-9a-f]{64})[^\n]*<<'(WF_RESULT_[0-9a-f]+)'\n([\s\S]*)\n\5$/)
  if (!m) return { raw: JSON.stringify({ error: '桩：无法解析 record 命令' }) }
  const [, root, key, iter, sha, , payload] = m
  const actual = sha256(payload)
  return { raw: JSON.stringify(actual === sha
    ? { resultPath: `${root}/results/${key}-${iter}.json`, resultSha256: sha256(`rec:${payload}`), envelopeSha256: actual, fingerprints: {}, error: '无' }
    : { envelopeSha256: actual, error: '结果 JSON 的 sha256 与调度器给出的不一致' }) }
}
const isRecord = (opts) => /-record$/.test(opts.label)

const FEATURE_DIR = 'specs/sim-feature'
const TASKS_PATH = `${FEATURE_DIR}/tasks.md`

function env(node, iter, fields) {
  return { node, iteration: iter, nextNode: 'PAUSE', reason: '', stoppedAt: `${node}·sim`, batchId: null,
    writes: [], artifacts: [], decisionsNeeded: [], data: {}, ...fields }
}
const item = (id, request) => ({ id, basis: `r/evidence-${id}.md:1`, request })

// 模拟项目。overrides[node](up, it, state) 返回信封时替换默认行为，返回 null 时使用默认行为。
function mockProject({ tasks, plan, overrides = {}, filterDone = true, prechecked = [] }) {
  const s = { checked: new Set(prechecked), batchNo: 0, activeBatch: null, reworkNo: 0, tick: 0 }
  const snap = (node, it) => [{ kind: 'snapshot', path: `/sim/${node}-${it}`, sha256: `${node}-${it}-${(s.tick += 1)}` }]
  const custom = (node, up, it) => (overrides[node] ? overrides[node](up, it, s) : null)
  const runners = {
    W1: (up, it) => custom('W1', up, it) || env('W1', it, { nextNode: 'W3', reason: '模拟：规格齐全', data: { specGaps: [] } }),
    W2: (up, it) => custom('W2', up, it) || env('W2', it, { nextNode: 'W3', batchId: s.activeBatch, artifacts: snap('W2', it),
      reason: `模拟：按 ${up.data.revision.source} 修订规格`, writes: [{ path: `${FEATURE_DIR}/requirements.md`, action: '修改' }],
      data: { applied: up.data.revision.items } }),
    W3: (up, it) => {
      const c = custom('W3', up, it)
      if (c) return c
      if (up && up.data && up.data.rework) {          // 返工模式：在当前批次中追加返工任务
        const ids = up.data.rework.map(() => `R${(s.reworkNo += 1)}`)
        return env('W3', it, { nextNode: 'W4', batchId: s.activeBatch, artifacts: snap('W3', it), reason: `模拟：返工任务 ${ids.join('、')}`,
          data: { action: '返工更新', reworkTaskIds: ids, plan: { selectedTasks: [] } } })
      }
      if (up && up.node === 'W2') {                   // 规格修订后更新当前批次
        return env('W3', it, { nextNode: 'W4', batchId: s.activeBatch, artifacts: snap('W3', it), reason: '模拟：按修订更新任务包',
          data: { action: '更新', plan: { selectedTasks: plan[s.batchNo - 1].map((t) => `${t} 模拟任务`) } } })
      }
      if (tasks.every((t) => s.checked.has(t))) return env('W3', it, { nextNode: 'FEATURE_TASKS_COMPLETE', reason: '模拟：没有未完成任务', artifacts: snap('W3', it) })
      const selected = plan[s.batchNo].filter((t) => !filterDone || !s.checked.has(t))
      s.batchNo += 1
      s.activeBatch = `batch-0${s.batchNo}`
      return env('W3', it, { nextNode: 'W4', batchId: s.activeBatch, reason: `模拟：新建 ${s.activeBatch}`, artifacts: snap('W3', it),
        data: { plan: { selectedTasks: selected.map((t) => `${t} 模拟任务`) }, action: '新批次' } })
    },
    W4: (up, it) => {
      const ids = (up.data.reworkTaskIds && up.data.reworkTaskIds.length) ? up.data.reworkTaskIds : up.data.plan.selectedTasks.map((x) => x.split(' ')[0])
      return env('W4', it, { nextNode: 'W5', batchId: up.batchId, reason: `模拟：执行 ${ids.join('、')}`, artifacts: snap('W4', it),
        data: { tasks: ids.map((id) => ({ id })), results: ids.map((id) => ({ taskId: id, outcome: '已修改' })), reportPath: `r/${up.batchId}/W4-${it}.md` } })
    },
    W5: (up, it) => custom('W5', up, it) || env('W5', it, { nextNode: 'W6', batchId: up.batchId, reason: '模拟：审查通过', artifacts: snap('W5', it),
      data: { reportPath: `r/${up.batchId}/W5-${it}.md`, codex: { fingerprint: `fp-${it}` } } }),
    W6: (up, it) => custom('W6', up, it) || env('W6', it, { nextNode: 'W7', batchId: up.batchId, reason: `模拟：测试通过（上游 ${up.node}#${up.iteration}）`, artifacts: snap('W6', it),
      data: { reportPath: `r/${up.batchId}/W6-${it}.md` } }),
    W7: (up, it, history) => {
      const c = custom('W7', up, it)
      if (c) return c
      const ids = [...new Set(history.filter((h) => h.node === 'W4' && h.batchId === up.batchId).flatMap((h) => h.data.tasks.map((t) => t.id)))]
      const newlyChecked = ids.filter((id) => tasks.includes(id) && !s.checked.has(id))
      const reworkVerified = ids.filter((id) => !tasks.includes(id))
      newlyChecked.forEach((id) => s.checked.add(id))
      const remaining = tasks.filter((t) => !s.checked.has(t))
      return env('W7', it, { nextNode: remaining.length ? 'W3' : 'W8', batchId: up.batchId, artifacts: snap('W7', it),
        reason: `模拟：勾选 ${newlyChecked.join('、') || '无'}；返工通过 ${reworkVerified.join('、') || '无'}`,
        writes: newlyChecked.length ? [{ path: TASKS_PATH, action: '修改' }] : [],
        data: { checkedThisRun: newlyChecked, reworkVerified, remainingUnchecked: remaining, reportPath: `r/${up.batchId}/W7-${it}.md` } })
    },
    W8: (up, it) => custom('W8', up, it) || env('W8', it, { nextNode: 'DONE', reason: '模拟：交付核对通过', artifacts: snap('W8', it) }),
  }
  return { runners, state: s }
}

// 按次数切换返回值：第 n 次调用用 seq[n-1]，超出后用默认行为
const once = (fn) => (up, it, s) => (it === 1 ? fn(up, it, s) : null)

async function run(name, project, limits = {}) {
  let agentCalls = 0
  let recordCalls = 0
  const forbidden = () => { agentCalls += 1; throw new Error('模拟验证中不允许调用 agent / parallel') }
  const agentStub = async (prompt, opts) => { if (opts && isRecord(opts)) { recordCalls += 1; return fakeRecord(prompt) } return forbidden() }
  const args = {
    feature: { dir: FEATURE_DIR, title: '模拟功能', request: '模拟需求' },
    run: { id: 'sim-run', root: '/nonexistent/sim-run' },
    options: { limits },
  }
  const out = await dispatcher(args, agentStub, () => {}, () => {}, forbidden, project.runners)
  const w4 = out.results.filter((h) => h.node === 'W4').map((h) => `W4#${h.iteration}[${h.data.tasks.map((t) => t.id).join(',')}]`).join(' ')
  const w6up = out.results.filter((h) => h.node === 'W6').map((h) => h.reason.match(/上游 (\S+)）/)?.[1]).filter(Boolean)
  return { name, route: out.route.join(' → '), nextNode: out.nextNode, stoppedAt: out.stoppedAt, reason: out.reason,
    batches: out.batches.map((b) => `${b.batchId}[${b.checked.join(',')}${b.reworkVerified.length ? `; 返工 ${b.reworkVerified.join(',')}` : ''}]`).join(' '),
    w4, w6up: w6up.join(' '), rework: JSON.stringify(out.reworkCount), agentCalls, recordCalls, recordsOk: out.records.length === out.results.length }
}

const TASKS = ['T1', 'T2', 'T3', 'T4']
const PLAN = [['T1', 'T2'], ['T3', 'T4'], ['T3', 'T4']]
const ONE = { tasks: ['T1', 'T2'], plan: [['T1', 'T2']] }
const P = (o) => mockProject({ ...ONE, ...o })

const results = [
  // —— 已有的批次循环场景 ——
  await run('1. 两批任务完成后进入 W8', mockProject({ tasks: TASKS, plan: PLAN })),
  await run('2. 批次数达到上限（maxBatches=1）', mockProject({ tasks: TASKS, plan: PLAN }), { maxBatches: 1 }),
  await run('3. W7 没有勾选任何任务（无进展）', mockProject({ tasks: TASKS, plan: PLAN, overrides: {
    W7: (up, it) => env('W7', it, { nextNode: 'W3', batchId: up.batchId, reason: '模拟：部分完成', writes: [],
      data: { checkedThisRun: [], reworkVerified: [], remainingUnchecked: TASKS, reportPath: 'r/W7.md' } }),
  } })),
  await run('4. W3 沿用已结束的批次', mockProject({ tasks: TASKS, plan: PLAN, overrides: {
    W3: (up, it) => (up && up.node === 'W7'
      ? env('W3', it, { nextNode: 'W4', batchId: up.batchId, reason: '模拟：复用', data: { plan: { selectedTasks: ['T3 模拟任务'] } } }) : null),
  } })),
  await run('5. W3 重新选中已完成的任务', mockProject({ tasks: TASKS, plan: [['T1', 'T2'], ['T2', 'T3'], ['T4']], filterDone: false })),
  await run('6. 节点总数上限仍生效（maxNodeRuns=8）', mockProject({ tasks: TASKS, plan: PLAN }), { maxNodeRuns: 8 }),

  // —— 返工回路 ——
  await run('7. 规格返修：W5 → W2 → W3 → W4 …', P({ overrides: {
    W5: once((up, it) => env('W5', it, { nextNode: 'W2', batchId: up.batchId, reason: '模拟：规格意见',
      data: { revision: { source: 'W5', items: [item('S1-1', 'AC8 缺少前提')] } } })),
  } })),
  await run('8. 代码返工：W6 → (W3 规划返工) → W4 只执行返工任务', P({ overrides: {
    W6: once((up, it) => env('W6', it, { nextNode: 'W4', batchId: up.batchId, reason: '模拟：AC6 代码问题', data: { rework: [item('AC6', '悬停样式错误')] } })),
  } })),
  await run('9. 最终复验：W8 → W6（审查仍对应当前代码）', P({ overrides: {
    W8: once((up, it) => env('W8', it, { nextNode: 'W6', reason: '模拟：测试报告已过期', data: { rework: [], reverify: [{ report: 'r/W6-1.md' }] } })),
  } })),
  await run('10. 最终复验时审查已过期：W6 → W5（用真实 W4 结果）', P({ overrides: {
    W8: once((up, it) => env('W8', it, { nextNode: 'W6', reason: '模拟：测试报告已过期', data: { rework: [], reverify: [{ report: 'r/W6-1.md' }] } })),
    W6: (up, it) => (it === 2 ? env('W6', it, { nextNode: 'PAUSE', batchId: up.batchId, reason: '模拟：审查范围文件已变化', data: { reviewStale: true } }) : null),
  } })),
  await run('11. W8 发现代码问题：→ W3 返工 → W4 …', P({ overrides: {
    W8: once((up, it) => env('W8', it, { nextNode: 'W6', reason: '模拟：构建失败', data: { rework: [item('W8-C1', '构建报错')], reverify: [] } })),
  } })),
  await run('12. W8 → W2 / W3 按对应路线继续（W8 → W2）', P({ overrides: {
    W8: once((up, it) => env('W8', it, { nextNode: 'W2', reason: '模拟：验收标准缺失', data: { revision: { source: 'W8', items: [item('W8-AC9', '缺少统计验收')] } } })),
    W2: (up, it, s) => env('W2', it, { nextNode: 'W3', reason: '模拟：新增任务 T3', data: {} }),
    W3: (up, it, s) => (up && up.node === 'W2' ? env('W3', it, { nextNode: 'FEATURE_TASKS_COMPLETE', reason: '模拟：（新任务另行验证）没有未完成任务' }) : null),
  } })),
  await run('13. 返工超限（maxReworkPerBatch=2，W6 每次都报代码问题）', P({ overrides: {
    W6: (up, it) => env('W6', it, { nextNode: 'W4', batchId: up.batchId, reason: `模拟：第 ${it} 次代码问题`, data: { rework: [item(`AC6-${it}`, '仍有问题')] } }),
  } }), { maxReworkPerBatch: 2 }),

  // —— 缺证据暂停 ——
  await run('14. 缺返工内容：W6 → W4 但 rework 为空', P({ overrides: {
    W6: once((up, it) => env('W6', it, { nextNode: 'W4', batchId: up.batchId, reason: '模拟：代码问题', data: { rework: [] } })),
  } })),
  await run('15. 缺修订依据：W5 → W2 但没有 revision', P({ overrides: {
    W5: once((up, it) => env('W5', it, { nextNode: 'W2', batchId: up.batchId, reason: '模拟：规格意见', data: {} })),
  } })),
  await run('16. 缺有效上游：W3 直接进入 W8 后要求复验，本次运行没有 W5', P({ prechecked: ['T1', 'T2'], overrides: {
    W8: once((up, it) => env('W8', it, { nextNode: 'W6', reason: '模拟：测试报告已过期', data: { rework: [], reverify: [{ report: 'r/old.md' }] } })),
  } })),
  await run('17. W3 收到返工意见却没有规划返工任务', P({ overrides: {
    W6: once((up, it) => env('W6', it, { nextNode: 'W4', batchId: up.batchId, reason: '模拟：代码问题', data: { rework: [item('AC6', '悬停样式错误')] } })),
    W3: (up, it, s) => (up && up.data && up.data.rework ? env('W3', it, { nextNode: 'W4', batchId: s.activeBatch, reason: '模拟：忽略返工', data: { action: '复用', plan: { selectedTasks: [] } } }) : null),
  } })),
]

for (const r of results) {
  console.log(`\n${r.name}\n  route    : ${r.route}\n  nextNode : ${r.nextNode}（stoppedAt ${r.stoppedAt}）`)
  if (r.batches) console.log(`  batches  : ${r.batches}`)
  if (r.w4) console.log(`  W4 轮次  : ${r.w4}`)
  if (r.w6up) console.log(`  W6 上游  : ${r.w6up}`)
  if (r.rework !== '{}') console.log(`  返工计数 : ${r.rework}`)
  console.log(`  reason   : ${r.reason}\n  agent 调用: ${r.agentCalls}（另有结果保存 ${r.recordCalls} 次，每个节点都已保存：${r.recordsOk}）`)
}

// ======================================================================
// 第二部分：真实 runW4 的问题分类与 deferred 处理
// 使用生产脚本中真实的 RUNNERS 和 runW4；只把 agent() 替换为返回固定结果的桩函数（不调用模型）。
// maxNodeRuns=1，W4 结束后由调度器停止，不进入 W5。
// ======================================================================
const W4_RUN = 'sim-w4'
const REPORT = `${FEATURE_DIR}/reports/batch-02/W4-development-${W4_RUN}-1.md`
const RUNS = `${FEATURE_DIR}/reports/RUNS.md`
const SPEC = ['requirements.md', 'design.md', 'tasks.md'].map((f) => `${FEATURE_DIR}/${f}`)
const cb = { [TASKS_PATH]: { missingIds: [], stateChanged: [], newIds: [], checkedNow: [] } }
const snapRaw = JSON.stringify({ snapshotDir: '/sim/W4-1/snapshot', manifestPath: '/sim/m', manifestSha256: 'm1', fileCount: 1, head: 'h1', outsideRepo: true, probes: [], error: '无' })
const taskDiff = JSON.stringify({ changed: [], headAfter: 'h1', checkbox: cb, prefix: {}, same: {}, lines: {}, error: '无' })
const reportDiff = JSON.stringify({ changed: [{ path: REPORT, change: '新增', sha256: 'r1' }, { path: RUNS, change: '新增', sha256: 'r2' }], headAfter: 'h1',
  checkbox: cb, prefix: { [RUNS]: true }, same: Object.fromEntries([`${FEATURE_DIR}/current-batch.md`, ...SPEC].map((p) => [p, true])), lines: {}, error: '无' })

const planOut = {
  snapshotRaw: snapRaw, batchId: 'batch-02', currentBatchSha256: 'b1', lastRegisteredSha256: 'b1', mode: '串行', preexistingChanges: [], problems: [],
  tasks: [
    { id: 'T7', name: '核对 CSS', kind: '核对', goal: 'g', dependencies: [], allowedFiles: [], acceptance: ['AC6'], verification: 'v', order: 1, sourceLines: '38-56' },
    { id: 'T1', name: '更正 T1', kind: '报告更正', goal: 'g', dependencies: [], allowedFiles: [], acceptance: ['AC1'], verification: 'v', order: 2, sourceLines: '58-73' },
    { id: 'T2', name: '更正 T2', kind: '报告更正', goal: 'g', dependencies: ['T7'], allowedFiles: [], acceptance: ['AC12'], verification: 'v', order: 3, sourceLines: '75-88' },
  ],
}
const taskOut = (id, extra = {}) => ({ taskId: id, outcome: '核对完成', stateCheck: '模拟', acChecks: [], corrections: [], issues: [], deferredResolution: [],
  diffRaw: taskDiff, summary: `模拟 ${id}`, ...extra })
const issue = (kind, text, owner = '无', coverage = '无', needsWrite = false) =>
  ({ kind, basis: 'development-report.md:40', text, ownerTaskId: owner, ownerCoverageBasis: coverage, needsWrite })
const T2_OWNS = issue('后续任务负责', '旧报告第 40 行 T2 段落写着"没有修改业务代码"', 'T2', 'current-batch.md:83 T2 更正约第 54 行基础验证中 T2 那一半')

async function runW4Sim(name, outs) {
  const calls = []
  const prompts = {}
  const stub = async (prompt, opts) => {
    if (isRecord(opts)) return fakeRecord(prompt)
    calls.push(opts.label)
    prompts[opts.label] = prompt
    if (opts.label === 'w4-plan') return planOut
    if (opts.label === 'w4-report') return { action: '新建', diffRaw: reportDiff, error: '无' }
    const id = opts.label.replace('w4-', '')
    return outs[id] ? outs[id] : taskOut(id)
  }
  const args = { feature: { dir: FEATURE_DIR, title: '模拟功能', request: '模拟需求' }, run: { id: W4_RUN, root: '/nonexistent/sim-w4' },
    startNode: 'W4', options: { limits: { maxNodeRuns: 1 } } }
  const out = await dispatcher(args, stub, () => {}, () => {}, async () => { throw new Error('不应并行') }, null)
  const w4 = out.results[0]
  return { name, calls: calls.join(' → '), w4Next: w4.nextNode, reason: w4.reason,
    deferred: (w4.data.deferred || []).map((d) => `${d.id}(${d.from}→${d.ownerTaskId}, ${d.resolved === true ? '已处理' : d.resolved === false ? '未处理' : '负责任务未执行'})`).join(' '),
    t2GotDeferred: (prompts['w4-T2'] || '').includes('T1-D1') }
}

const w4Results = [
  await runW4Sim('A. T1 发现 T2 明确负责的问题 → 继续执行 T2，T2 处理后批次成功', {
    T1: taskOut('T1', { issues: [T2_OWNS] }),
    T2: taskOut('T2', { deferredResolution: [{ id: 'T1-D1', resolved: true, evidence: '更正记录第 3 条' }] }),
  }),
  await runW4Sim('B. T2 没有解决该问题 → 最终暂停', {
    T1: taskOut('T1', { issues: [T2_OWNS] }),
    T2: taskOut('T2', { deferredResolution: [{ id: 'T1-D1', resolved: false, evidence: '超出 T2 的更正范围' }] }),
  }),
  await runW4Sim('C. T1 发现范围外问题 → 立即暂停', {
    T1: taskOut('T1', { issues: [issue('越界或安全', '需要修改 app/page.tsx 才能处理焦点问题', '无', '无', true)] }),
  }),
  await runW4Sim('D. 转交给不在本批的任务（T3）→ 暂停', {
    T1: taskOut('T1', { issues: [issue('后续任务负责', '运行时表现', 'T3', 'tasks.md:23 T3 浏览器验收')] }),
  }),
  await runW4Sim('E. 需要改文件的问题转交给只读任务 → 暂停', {
    T1: taskOut('T1', { issues: [issue('后续任务负责', '需要修改样式', 'T2', 'current-batch.md:83', true)] }),
  }),
  await runW4Sim('F. 负责任务没有报告处理结果 → 暂停', {
    T1: taskOut('T1', { issues: [T2_OWNS] }),
  }),
  await runW4Sim('G. 转交缺少任务包依据 → 暂停', {
    T1: taskOut('T1', { issues: [issue('后续任务负责', '应由 T2 处理', 'T2', '无')] }),
  }),
]

console.log('\n======== 真实 runW4：问题分类与 deferred ========')
for (const r of w4Results) {
  console.log(`\n${r.name}\n  agent 桩调用 : ${r.calls}\n  W4 nextNode  : ${r.w4Next}\n  deferred     : ${r.deferred || '无'}\n  T2 收到转交  : ${r.t2GotDeferred}\n  reason       : ${r.reason}`)
}

// ======================================================================
// 第三部分：结果保存、W4 复核与续接（约定 2.6）
// 在临时 git 仓库中执行真实的 tools/wf_snapshot.py（record / resultcheck / importorigin / prefixcheck / diff / fingerprint）；
// 只把 agent() 替换为"原样执行命令块"的桩，内容复核的判断用固定结果；W5 用模拟节点，只记录收到的上游。
// 不调用模型、Codex、浏览器，不读写本项目文件。
// ======================================================================
const SIM_DIR = 'specs/sim-feature'
const SIM_REPORT = `${SIM_DIR}/reports/batch-02/W4-development-orig-run-1.md`
const LEGACY = `${SIM_DIR}/development-report.md`
const base3 = mkdtempSync(join(tmpdir(), 'wf-resume-sim-'))
const repo = join(base3, 'repo')
const sh = (cmd, cwd = repo) => execSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
const put = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text) }
const read = (rel) => readFileSync(join(repo, rel), 'utf8')
const fileSha = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex')

mkdirSync(repo, { recursive: true })
sh('git init -q && git config user.email sim@example.invalid && git config user.name sim')
put(`${SIM_DIR}/requirements.md`, '# 需求\nAC1\n')
put(`${SIM_DIR}/design.md`, '# 设计\n')
put(`${SIM_DIR}/tasks.md`, '- [ ] T7 核对 CSS\n- [ ] T1 更正 T1\n- [ ] T2 更正 T2\n')
put(`${SIM_DIR}/current-batch.md`, '# 当前批次 batch-02\nT7 → T1 → T2\n')
put(LEGACY, ['# 旧报告', ...Array.from({ length: 54 }, (_, i) => `第 ${i + 2} 行`), '- 测试：未运行。本批只读核对，没有修改代码。', ''].join('\n'))
put('app/x.css', '.filter:hover { color: green; }\n.filter.active { color: white; }\n')
put(`${SIM_DIR}/reports/RUNS.md`, '| run.id | 节点 | 次数 | batchId | 报告路径 | nextNode | 被取代 |\n')
cpSync(join(here, '..', 'tools', 'wf_snapshot.py'), join(repo, 'workflow-examples', 'tools', 'wf_snapshot.py'))
put('workflow-examples/note.txt', '示例\n')
sh('git add -A && git commit -qm init')
const HEAD = sh('git rev-parse HEAD').trim()
const TOOL_CMD = 'python3 -I workflow-examples/tools/wf_snapshot.py'

// 原运行：W4 开始时的快照 → 写报告、追加 RUNS.md → 结果为 PAUSE（T2 发现无人负责的问题）。结果没有保存到 run.root。
const origRoot = join(base3, 'runs', 'orig-run')
const snapDirOrig = `${origRoot}/W4-1/snapshot`
const takeOut = JSON.parse(sh(`${TOOL_CMD} take '${snapDirOrig}'`))
put(SIM_REPORT, '# 本批开发报告\n\n## 完成的任务\n- T7：已存在且一致，未重复修改\n- T1：核对完成\n- T2：核对完成\n\n## 未解决问题\n- 旧报告第 56 行无人负责\n')
appendFileSync(join(repo, `${SIM_DIR}/reports/RUNS.md`), `| orig-run | W4 | 1 | batch-02 | ${SIM_REPORT} | PAUSE | |\n`)
const ORIG_REPORT_SHA = fileSha(join(repo, SIM_REPORT))
const ORIG_REPORT_BYTES = readFileSync(join(repo, SIM_REPORT)).length
const ISSUE_T2 = { kind: '其他', basis: `${LEGACY}:56`, text: '旧报告第 56 行“没有修改代码”已过时，无人负责', ownerTaskId: '无', ownerCoverageBasis: '无', needsWrite: false }
const origEnvelope = {
  node: 'W4', iteration: 1, nextNode: 'PAUSE', reason: `T2 发现问题，后续任务未执行：其他：${ISSUE_T2.text}`, stoppedAt: 'W4·Task', batchId: 'batch-02',
  writes: [{ path: `${SIM_DIR}/reports/RUNS.md`, action: '追加' }, { path: SIM_REPORT, action: '新建' }],
  artifacts: [{ kind: 'snapshot', path: snapDirOrig, sha256: takeOut.manifestSha256 }], decisionsNeeded: [],
  data: {
    tasks: [{ id: 'T7', kind: '核对', allowedFiles: [] }, { id: 'T1', kind: '报告更正', allowedFiles: [] }, { id: 'T2', kind: '报告更正', allowedFiles: [] }],
    results: [{ taskId: 'T7', outcome: '已存在且一致，未重复修改', issues: [] }, { taskId: 'T1', outcome: '核对完成', issues: [] }, { taskId: 'T2', outcome: '核对完成', issues: [ISSUE_T2] }],
    pending: [], deferred: [{ id: 'T1-D1', from: 'T1', ownerTaskId: 'T2', text: 'T2 段落', resolved: true }],
    preexistingChanges: [{ path: 'app/x.css', note: '运行前已有' }, { path: LEGACY, note: '旧报告' }, { path: 'workflow-examples/', note: '示例' }],
    reportPath: SIM_REPORT,
  },
}
const wfRecordPath = join(base3, 'wf_orig.json')
writeFileSync(wfRecordPath, JSON.stringify({ runId: 'wf_orig', args: { run: { id: 'orig-run' } }, result: { route: ['W4'], nextNode: 'PAUSE', results: [origEnvelope] } }))
const WF_SHA = fileSha(wfRecordPath)

// 用户决定后，只在报告末尾追加补充更正
const SUPP = '## 补充更正记录（模拟）'
appendFileSync(join(repo, SIM_REPORT), `\n${SUPP}\n\n17. ${LEGACY}:56 原文“没有修改代码”→ 更正后：app/x.css 已由上一轮修改。\n\n原结果仍为 PAUSE，本补充不改记为成功。\n`)
put('workflow-examples/note.txt', '示例（运行后又改过，属于 deliveryExclusions）\n')

const goodJudge = {
  tasks: [{ taskId: 'T7', reportOutcome: '已存在且一致，未重复修改', matchesOriginal: true, evidence: `${SIM_REPORT}:4` },
    { taskId: 'T1', reportOutcome: '核对完成', matchesOriginal: true, evidence: `${SIM_REPORT}:5` },
    { taskId: 'T2', reportOutcome: '核对完成', matchesOriginal: true, evidence: `${SIM_REPORT}:6` }],
  issues: [{ index: 0, covered: true, location: '补充更正第 17 条', evidence: `${LEGACY}:56 原文一致` }],
  withinScope: { ok: true, evidence: '只更正报告表述' }, pauseRecorded: { ok: true, evidence: '写明原结果仍为 PAUSE' }, findings: [],
}

let runNo = 0
async function sim3(name, { startNode, review = {}, resume, judge = goodJudge, prepare, cleanup, expect }) {
  runNo += 1
  const runId = `sim3-${runNo}`
  const root = join(base3, 'runs', runId)
  const calls = []
  let w5Upstream = null
  const stub = async (prompt, opts) => {
    calls.push(opts.label)
    if (opts.label.endsWith('-review')) return judge
    const block = cmdOf(prompt)
    const outs = block.includes("<<'") ? [sh(block).trim()] : block.split('\n').map((c) => sh(c).trim())
    if (opts.label.endsWith('-tools')) return { importRaw: outs[0], diffRaw: outs[1], prefixRaw: outs[2], hashRaw: outs[3] }
    return { raw: outs[0] }
  }
  const mocks = { __partial: true, W5: (up, it) => { w5Upstream = up; return { node: 'W5', iteration: it, nextNode: 'PAUSE', reason: '模拟 W5：只记录收到的上游', stoppedAt: 'W5·sim', batchId: up.batchId, writes: [], artifacts: [], decisionsNeeded: [], data: {} } } }
  const args = {
    feature: { dir: SIM_DIR, title: '模拟功能', request: '模拟需求' }, run: { id: runId, root }, startNode,
    legacyBatches: [{ batchId: 'batch-02', tasks: ['T7', 'T1', 'T2'], currentBatchSha256: fileSha(join(repo, `${SIM_DIR}/current-batch.md`)) }],
    options: { deliveryExclusions: [{ path: 'workflow-examples/', reason: '工作流示例' }], limits: { maxNodeRuns: 3 } },
  }
  if (startNode === 'W4R') {
    args.review = { runId: 'orig-run', batchId: 'batch-02', reportPath: SIM_REPORT, snapshotDir: snapDirOrig, expectedHead: HEAD,
      workflowRecord: { path: wfRecordPath, sha256: WF_SHA, workflowRunId: 'wf_orig' },
      originalReport: { sha256: ORIG_REPORT_SHA, bytes: ORIG_REPORT_BYTES, source: '模拟：原运行快照对比中的报告哈希' },
      supplementHeading: SUPP, decision: '模拟：用户选择补充更正记录', ...review }
  }
  if (resume) args.resume = resume
  const undo = prepare ? prepare() : null
  let out
  try { out = await dispatcher(args, stub, () => {}, () => {}, async () => { throw new Error('不应并行') }, mocks) } finally { if (cleanup) cleanup(undo) }
  const verdict = expect(out, w5Upstream)
  return { name, route: out.route.join(' → ') || '（无）', nextNode: out.nextNode, stoppedAt: out.stoppedAt, reason: out.reason, calls: calls.join(' → '),
    records: out.records.map((r) => `${r.node}-${r.iteration}(${r.nextNode})`).join(' ') || '无', w5: w5Upstream ? `${w5Upstream.node} ${w5Upstream.stoppedAt}${w5Upstream.data.review ? '，带复核来源' : ''}` : '未进入', verdict, root }
}
const mutate = (rel, fn) => () => { const before = read(rel); put(rel, fn(before)); return before }
const restore = (rel) => (before) => put(rel, before)
const has = (s, ...parts) => parts.every((p) => String(s).includes(p))

const r3 = []
// —— W4 复核 ——
r3.push(await sim3('R1. 复核通过 → 产生新的 W4 结果并进入 W5；原 PAUSE 原样导入保存', { startNode: 'W4R', expect: (o, up) =>
  o.route.join() === 'W4·复核,W5' && up && up.data.review && up.data.review.original.nextNode === 'PAUSE'
  && up.data.review.scope.ignoredByDeliveryExclusions.join() === '修改 workflow-examples/note.txt'
  && existsSync(up.data.review.original.importedPath) && JSON.parse(JSON.parse(readFileSync(up.data.review.original.importedPath, 'utf8')).envelopeJson).nextNode === 'PAUSE'
  && fileSha(wfRecordPath) === WF_SHA && o.records.length === 2 }))
const goodRecord = r3[0].verdict ? `${r3[0].root}/results/W4R-1.json` : null
const goodSha = goodRecord ? fileSha(goodRecord) : '0'.repeat(64)
r3.push(await sim3('R2. 复核时报告原内容被改动 → 暂停', { startNode: 'W4R',
  prepare: mutate(SIM_REPORT, (t) => t.replace('T1：核对完成', 'T1：核对完成（已验收）')), cleanup: restore(SIM_REPORT),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '原内容被改动') }))
r3.push(await sim3('R3. 复核时代码在原快照之后有变化 → 暂停', { startNode: 'W4R',
  prepare: mutate('app/x.css', (t) => t.replace('green', 'red')), cleanup: restore('app/x.css'),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '范围外', 'app/x.css') }))
r3.push(await sim3('R4. 内容复核认为补充更正没有覆盖问题 → 暂停，不产生 W4 结果', { startNode: 'W4R',
  judge: { ...goodJudge, issues: [{ index: 0, covered: false, location: '无', evidence: '补充引用的原文与第 56 行不一致' }] },
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '没有被补充更正覆盖') }))
r3.push(await sim3('R5. 原运行记录哈希不符 → 暂停', { startNode: 'W4R', review: { workflowRecord: { path: wfRecordPath, sha256: 'f'.repeat(64), workflowRunId: 'wf_orig' } },
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '运行记录的 sha256') }))
const pauseRecord = `${r3[3].root}/results/W4R-1.json`

const NOTE = { text: '是否据此进入 W5 由用户决定', type: '说明', impact: [], resolved: false, resolvedBy: '无', evidence: `${SIM_REPORT}:12` }
const BASIS_BUG = { text: '第 17 条把 W6 的依据写成 tasks.md', type: '问题', impact: ['证据可信度'], resolved: false, resolvedBy: '无', evidence: `${SIM_DIR}/tasks.md:1` }
r3.push(await sim3('R15. 只有说明 → 不阻塞，复核通过，说明保存在 notes', { startNode: 'W4R', judge: { ...goodJudge, findings: [NOTE] },
  expect: (o, up) => o.route.join() === 'W4·复核,W5' && up && up.data.review.findings.notes.length === 1 && up.data.review.findings.blocking.length === 0 }))
r3.push(await sim3('R16. 证据缺陷已由勘误解决 → 不阻塞，记入 nonBlocking', { startNode: 'W4R',
  judge: { ...goodJudge, findings: [NOTE, { ...BASIS_BUG, resolved: true, resolvedBy: `${SIM_REPORT}:20 勘误` }] },
  expect: (o, up) => !!up && up.data.review.findings.nonBlocking.length === 1 && up.data.review.findings.notes.length === 1 }))
r3.push(await sim3('R17. 证据缺陷未解决 → 阻塞，暂停', { startNode: 'W4R', judge: { ...goodJudge, findings: [NOTE, BASIS_BUG] },
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '证据可信度') && o.results[0].data.findings.notes.length === 1 }))
r3.push(await sim3('R18. agent 把证据缺陷标成"说明"且未解决 → 仍按问题阻塞', { startNode: 'W4R', judge: { ...goodJudge, findings: [{ ...BASIS_BUG, type: '说明' }] },
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '按问题处理') }))
r3.push(await sim3('R19. 声称已解决但没有写出解决位置 → 仍阻塞', { startNode: 'W4R', judge: { ...goodJudge, findings: [{ ...BASIS_BUG, resolved: true, resolvedBy: '无' }] },
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '未解决') }))
r3.push(await sim3('R20. 不影响三项的小问题 → 不阻塞，记入 nonBlocking', { startNode: 'W4R',
  judge: { ...goodJudge, findings: [{ text: '措辞可以更简洁', type: '问题', impact: [], resolved: false, resolvedBy: '无', evidence: `${SIM_REPORT}:3` }] },
  expect: (o, up) => !!up && up.data.review.findings.nonBlocking.length === 1 }))

// —— 续接 ——
const resumeArgs = (path, sha) => ({ resultPath: path, resultSha256: sha || fileSha(path) })
r3.push(await sim3('R6. 用 R1 保存的结果续接（无变化）→ 直接进入 W5', { startNode: 'W5', resume: resumeArgs(goodRecord, goodSha),
  expect: (o, up) => o.route.join() === 'W4(续接),W5' && up && up.data.review && o.resumedFrom[0].path === goodRecord && o.records.length === 1 }))
r3.push(await sim3('R7. 记录后报告变化 → 拒绝复用', { startNode: 'W5', resume: resumeArgs(goodRecord, goodSha),
  prepare: () => { const b = read(SIM_REPORT); appendFileSync(join(repo, SIM_REPORT), '追加一行\n'); return b }, cleanup: restore(SIM_REPORT),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '已变化', SIM_REPORT) }))
r3.push(await sim3('R8. 记录后代码变化 → 拒绝复用', { startNode: 'W5', resume: resumeArgs(goodRecord, goodSha),
  prepare: mutate('app/x.css', (t) => `${t}/* x */\n`), cleanup: restore('app/x.css'),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '已变化', 'app/x.css') }))
r3.push(await sim3('R9. 记录后任务包变化 → 拒绝复用', { startNode: 'W5', resume: resumeArgs(goodRecord, goodSha),
  prepare: mutate(`${SIM_DIR}/current-batch.md`, (t) => `${t}T3\n`), cleanup: restore(`${SIM_DIR}/current-batch.md`),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '已变化', 'current-batch.md') }))
const tampered = `${base3}/tampered-W4R-1.json`
{ const rec = JSON.parse(readFileSync(goodRecord, 'utf8')); rec.envelopeJson = rec.envelopeJson.replace('"reportPath"', '"reportPath2"'); writeFileSync(tampered, JSON.stringify(rec)) }
r3.push(await sim3('R10. 记录内容被改动（同时给出改动后的文件哈希）→ 拒绝复用', { startNode: 'W5', resume: resumeArgs(tampered),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '与其哈希不一致') }))
r3.push(await sim3('R11. 给出的记录哈希不符 → 拒绝复用', { startNode: 'W5', resume: resumeArgs(goodRecord, 'e'.repeat(64)),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '不一致') }))
r3.push(await sim3('R12. 用复核未通过（PAUSE）的记录续接 → 拒绝', { startNode: 'W5', resume: resumeArgs(pauseRecord),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, 'PAUSE 或其他结论不能当成功结果续接') }))
const pauseW4Root = join(base3, 'runs', 'pause-w4')
const pj = JSON.stringify(origEnvelope)
JSON.parse(sh(`${TOOL_CMD} record '${pauseW4Root}' W4 1 ${sha256(pj)} --path '${SIM_DIR}/current-batch.md' --path '${SIM_DIR}/tasks.md' --path '${SIM_REPORT}' --path app/x.css --path '${LEGACY}' <<'EOF_X'\n${pj}\nEOF_X`))
r3.push(await sim3('R13. 用原 W4 的 PAUSE 结果（即使已正常保存）续接 → 拒绝', { startNode: 'W5', resume: resumeArgs(`${pauseW4Root}/results/W4-1.json`),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, 'nextNode 为 PAUSE') }))
const importedPath = goodRecord ? JSON.parse(JSON.parse(readFileSync(goodRecord, 'utf8')).envelopeJson).data.review.original.importedPath : '/none'
r3.push(await sim3('R14. 用导入的原记录续接 → 拒绝（不是节点结果）', { startNode: 'W5', resume: resumeArgs(importedPath),
  expect: (o, up) => o.nextNode === 'PAUSE' && !up && has(o.reason, '不是节点结果记录') }))

console.log('\n======== 结果保存、W4 复核与续接（真实 wf_snapshot.py，临时仓库）========')
let failed = 0
for (const r of r3) {
  if (!r.verdict) failed += 1
  console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  route     : ${r.route}\n  nextNode  : ${r.nextNode}（stoppedAt ${r.stoppedAt}）\n  agent 桩  : ${r.calls}\n  已保存    : ${r.records}\n  W5 上游   : ${r.w5}\n  reason    : ${r.reason}`)
}
console.log(`\n第三部分：${r3.length - failed}/${r3.length} 通过；临时目录 ${base3}`)
if (failed) process.exitCode = 1

// ======================================================================
// 第四部分：用户决定触发的返工（startNode W3 + userRework）
// 临时仓库中用真实 wf_snapshot.py 生成 W5（PAUSE）和 W2 结果记录；真实 runW3，agent 桩原样执行命令块中的工具命令。
// ======================================================================
const base4 = mkdtempSync(join(tmpdir(), 'wf-userrework-sim-'))
const repo4 = join(base4, 'repo')
const sh4 = (cmd) => execSync(cmd, { cwd: repo4, shell: '/bin/bash', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
const put4 = (rel, text) => { mkdirSync(dirname(join(repo4, rel)), { recursive: true }); writeFileSync(join(repo4, rel), text) }
const read4 = (rel) => readFileSync(join(repo4, rel), 'utf8')
const D4 = 'specs/sim-feature'
const BATCH4 = `${D4}/current-batch.md`, TASKS4 = `${D4}/tasks.md`, DESIGN4 = `${D4}/design.md`, REQ4 = `${D4}/requirements.md`, RUNS4 = `${D4}/reports/RUNS.md`
const W5REP = `${D4}/reports/batch-02/W5-code-review-sim-1.md`
mkdirSync(repo4, { recursive: true })
sh4('git init -q && git config user.email sim@example.invalid && git config user.name sim')
put4(REQ4, '# 需求\nAC8\nAC14\n')
put4(DESIGN4, '# 设计\n当前第 69 行：合并规则\n')
put4(TASKS4, '- [ ] T7 核对\n- [ ] T1 更正\n- [ ] T2 更正\n- [ ] T3 浏览器\n')
put4(BATCH4, '# 当前开发批次 batch-02\n\n## 本批任务\n### T7\n### T1\n### T2\n')
put4(W5REP, '# W5\n| S2-1 | 报告:262 | 待确认 |\n')
put4(RUNS4, `| run.id | 节点 | 次数 | batchId | 报告路径 | nextNode | 被取代 |\n| r-w5 | W5 | 1 | batch-02 | ${W5REP} | PAUSE | |\n`)
cpSync(join(here, '..', 'tools', 'wf_snapshot.py'), join(repo4, 'workflow-examples', 'tools', 'wf_snapshot.py'))
sh4('git add -A && git commit -qm init')
const BATCH4_SHA = fileSha(join(repo4, BATCH4))
const recordReal = (root, key, env, paths) => {
  const j = JSON.stringify(env)
  return JSON.parse(sh4(`${TOOL_CMD} record '${root}' ${key} 1 ${sha256(j)} ${paths.map((p) => `--path '${p}'`).join(' ')} <<'EOF_R'\n${j}\nEOF_R`))
}
const FP4 = [BATCH4, TASKS4, REQ4, DESIGN4, W5REP]
const w5env = { node: 'W5', iteration: 1, nextNode: 'PAUSE', reason: '有 1 条意见需要用户决定（S2-1）。', stoppedAt: 'W5·Judge', batchId: 'batch-02',
  writes: [{ path: W5REP, action: '新建' }], artifacts: [], decisionsNeeded: [{ id: 'S2-1', question: '方案 A / B', options: [] }], data: { reportPath: W5REP } }
const w5rec = recordReal(join(base4, 'runs', 'w5'), 'W5', w5env, FP4)
// 模拟 W2：按 S1-1、S1-2 修改 tasks.md、design.md 后保存 W2 结果
put4(TASKS4, '- [ ] T7 核对（依赖指静态核对）\n- [ ] T1 更正\n- [ ] T2 更正\n- [ ] T3 浏览器（依赖 T7 的静态核对）\n')
put4(DESIGN4, '# 设计\n修改前第 69 行：合并规则（当前 69-70）\n')
const w2env = { node: 'W2', iteration: 1, nextNode: 'W3', reason: 'S1-1、S1-2 已修订', stoppedAt: 'W2·Spec', batchId: 'batch-02',
  writes: [{ path: DESIGN4, action: '修改' }, { path: TASKS4, action: '修改' }], artifacts: [], decisionsNeeded: [], data: { applied: [{ id: 'S1-1' }, { id: 'S1-2' }] } }
const w2rec = recordReal(join(base4, 'runs', 'w2'), 'W2', w2env, FP4)
const W5SHA = fileSha(w5rec.resultPath), W2SHA = fileSha(w2rec.resultPath)
const keep4 = Object.fromEntries([BATCH4, TASKS4, DESIGN4, REQ4, W5REP, RUNS4].map((p) => [p, read4(p)]))
const restore4 = () => { for (const [p, t] of Object.entries(keep4)) put4(p, t); sh4(`rm -rf '${D4}/reports/batch-02/batch-'*.md`) }

const DECISION = { id: 'D-S2-1-A', text: '保留 AC8、AC14 既有写法；通过新报告更正原 W4 第 262 行；保留 Codex 意见并说明未采纳依据。' }
const ITEM = { id: 'S2-1', basis: `${W5REP}:2`, request: '按方案 A 在新报告中更正原 W4 报告第 262 行；保留第 72、76 行；保留 Codex 意见并说明未采纳依据' }
const R1 = { id: 'R1', source: W5REP, findingId: 'S2-1', kind: '报告更正', goal: '更正原 W4 报告第 262 行', acceptance: ['AC8', 'AC14'], allowedFiles: [], verification: '新报告逐条对应' }
const toolLine = (prompt, verb) => (prompt.match(new RegExp(`python3 -I workflow-examples/tools/wf_snapshot\\.py ${verb} [^\\n，]*`)) || [null])[0]

let runNo4 = 0
async function sim4(name, { userRework, decisions = [DECISION], reworkTasks = [R1], prepare, expect }) {
  runNo4 += 1
  const runId = `sim4-${runNo4}`
  const root = join(base4, 'runs', runId)
  const calls = []
  const stub = async (prompt, opts) => {
    calls.push(opts.label)
    if (opts.label === 'w3-plan') {
      const snapshotRaw = sh4(toolLine(prompt, 'take')).trim()
      const draft = join(root, 'W3-1', 'draft-current-batch.md')
      writeFileSync(draft, `${read4(BATCH4)}\n## 返工任务\n### R1 更正原 W4 报告第 262 行（来源：用户决定 D-S2-1-A）\n`)
      return { snapshotRaw, noUncheckedTasks: false, currentBatchExists: true, currentBatchSha256: fileSha(join(repo4, BATCH4)), activeBatchId: 'batch-02',
        lastRegisteredSha256: BATCH4_SHA, activeBatchClosed: false, nextBatchId: 'batch-03', revisionTouchesBatch: false, equivalent: false,
        differences: ['追加返工任务 R1'], draftPath: draft, selectedTasks: [], skippedTasks: [], executionMode: '串行', specIssues: [], reworkTasks, reason: '模拟' }
    }
    if (opts.label === 'w3-write') {
      const archive = prompt.match(/原样复制到 (\S+?)（/)[1]
      sh4(`cp '${BATCH4}' '${archive}' && cp '${join(root, 'W3-1', 'draft-current-batch.md')}' '${BATCH4}'`)
      appendFileSync(join(repo4, RUNS4), `| ${runId} | W3 | 1 | batch-02 | ${BATCH4}（sha256:${fileSha(join(repo4, BATCH4))}） | W4 | |\n`)
      return { batchSha256: fileSha(join(repo4, BATCH4)), diffRaw: sh4(toolLine(prompt, 'diff')).trim(), error: '无' }
    }
    const block = cmdOf(prompt)
    const outs = block.includes("<<'") ? [sh4(block).trim()] : block.split('\n').map((c) => sh4(c).trim())
    if (opts.label === 'userrework-check') return { w5Raw: outs[0], w2Raw: outs[1] || '无' }
    return { raw: outs[0] }
  }
  const args = {
    feature: { dir: D4, title: '模拟功能', request: '模拟需求' }, run: { id: runId, root }, startNode: 'W3', decisions,
    legacyBatches: [{ batchId: 'batch-02', tasks: ['T7', 'T1', 'T2'], currentBatchSha256: BATCH4_SHA }],
    options: { limits: { maxNodeRuns: 1 } },
  }
  if (userRework !== undefined) args.userRework = userRework
  mkdirSync(join(root, 'W3-1'), { recursive: true })
  if (prepare) prepare()
  let out
  try { out = await dispatcher(args, stub, () => {}, () => {}, async () => { throw new Error('不应并行') }, null) } finally {
    var after = { batch: read4(BATCH4), tasks: read4(TASKS4) }
    restore4()
  }
  out = { route: [], results: [], records: [], ...out }
  const w3 = out.results.find((h) => h.node === 'W3')
  return { name, route: out.route.join(' → ') || '（无）', nextNode: out.nextNode, stoppedAt: out.stoppedAt, reason: out.reason, calls: calls.join(' → ') || '无',
    w3: w3 ? `${w3.nextNode} action=${w3.data.action || '-'} rework=${(w3.data.reworkTaskIds || []).join(',') || '-'}` : '未运行',
    records: out.records.map((r) => `${r.node}-${r.iteration}(${r.nextNode})`).join(' ') || '无', verdict: expect(out, w3, after) }
}
const UR = (o = {}) => ({ decisionId: 'D-S2-1-A', w5: { resultPath: w5rec.resultPath, resultSha256: W5SHA, reportPath: W5REP }, w2: { resultPath: w2rec.resultPath, resultSha256: W2SHA }, items: [ITEM], ...o })

const r4 = []
r4.push(await sim4('U1. 有效的用户决定 → W3 返工更新，只追加 R1；W5 原 PAUSE 记录不变', { userRework: UR(), expect: (o, w3, after) =>
  o.route.join() === '用户决定(D-S2-1-A),W3' && w3 && w3.nextNode === 'W4' && w3.data.action === '返工更新' && w3.data.reworkTaskIds.join() === 'R1'
  && after.batch.includes('### R1') && after.batch.includes('### T7') && !after.tasks.includes('[x]')
  && fileSha(w5rec.resultPath) === W5SHA && o.records.map((r) => r.node).join() === 'UserRework,W3' && o.nextNode === 'PAUSE' && has(o.reason, 'maxNodeRuns') }))
r4.push(await sim4('U2. 缺少关联的 W5 结果 → 拒绝', { userRework: UR({ w5: undefined }),
  expect: (o, w3) => !w3 && o.stoppedAt === 'context' && has(o.reason, 'userRework.w5') }))
r4.push(await sim4('U3. 决定编号不在 decisions 中 → 拒绝', { userRework: UR(), decisions: [],
  expect: (o, w3) => !w3 && has(o.reason, 'userRework.decisionId') }))
r4.push(await sim4('U4. W5 记录哈希不符 → 拒绝', { userRework: UR({ w5: { resultPath: w5rec.resultPath, resultSha256: 'a'.repeat(64), reportPath: W5REP } }),
  expect: (o, w3) => !w3 && o.stoppedAt === '返工来源核对' && has(o.reason, 'W5 结果记录文件的 sha256') }))
r4.push(await sim4('U5. 意见不在 W5 待决定事项中（S1-1）→ 拒绝', { userRework: UR({ items: [{ ...ITEM, id: 'S1-1' }] }),
  expect: (o, w3) => !w3 && has(o.reason, '不在 W5 结果待用户决定的事项中') }))
r4.push(await sim4('U6. W5 审查报告在记录后被改动 → 拒绝', { userRework: UR(), prepare: () => put4(W5REP, `${keep4[W5REP]}追加\n`),
  expect: (o, w3) => !w3 && has(o.reason, 'W5 审查报告在记录之后被改动') }))
r4.push(await sim4('U7. W5 之后有不是 W2 写入的变化（requirements.md）→ 拒绝', { userRework: UR(), prepare: () => put4(REQ4, `${keep4[REQ4]}AC99\n`),
  expect: (o, w3) => !w3 && has(o.reason, '不是 W2 写入的', 'requirements.md') }))
r4.push(await sim4('U8. 规格已变化但没有给出 W2 结果 → 拒绝（旧指纹不能当作当前依据）', { userRework: UR({ w2: undefined }),
  expect: (o, w3) => !w3 && has(o.reason, '没有给出说明变化来源的 W2 结果') }))
r4.push(await sim4('U9. W2 记录之后又被改动 → 拒绝', { userRework: UR(), prepare: () => put4(TASKS4, `${keep4[TASKS4]}- [ ] T9\n`),
  expect: (o, w3) => !w3 && has(o.reason, 'W2 记录之后又有文件变化') }))
r4.push(await sim4('U10. W3 生成越界任务（修改类、带修改文件）→ W3 暂停', { userRework: UR(),
  reworkTasks: [{ ...R1, kind: '修改', allowedFiles: ['app/page.tsx'] }],
  expect: (o, w3, after) => w3 && w3.nextNode === 'PAUSE' && has(w3.reason, '只允许"报告更正"') && !after.batch.includes('### R1') }))
r4.push(await sim4('U11. W3 生成多于一个任务 → W3 暂停', { userRework: UR(), reworkTasks: [R1, { ...R1, id: 'R2' }],
  expect: (o, w3) => w3 && w3.nextNode === 'PAUSE' && has(w3.reason, '只能为每条意见生成一个任务') }))
r4.push(await sim4('U12. userRework 配合其他 startNode → 拒绝', { userRework: UR(),
  prepare: () => {}, expect: () => true }))
r4.pop()  // U12 需要不同的 startNode，单独验证如下
{
  const out = await dispatcher({ feature: { dir: D4, title: 'x', request: 'x' }, run: { id: 'sim4-x', root: join(base4, 'runs', 'x') }, startNode: 'W4', decisions: [DECISION], userRework: UR() },
    async () => { throw new Error('不应调用') }, () => {}, () => {}, async () => {}, null)
  r4.push({ name: 'U12. userRework 配合 startNode W4 → 拒绝', route: (out.route || []).join() || '（无）', nextNode: out.nextNode, stoppedAt: out.stoppedAt, reason: out.reason, calls: '无', w3: '未运行', records: '无',
    verdict: out.stoppedAt === 'context' && has(out.reason, 'userRework 只能和 startNode W3 一起使用') })
}

console.log('\n======== 用户决定触发的返工（真实 wf_snapshot.py，临时仓库）========')
let failed4 = 0
for (const r of r4) {
  if (!r.verdict) failed4 += 1
  console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  route     : ${r.route}\n  nextNode  : ${r.nextNode}（stoppedAt ${r.stoppedAt}）\n  agent 桩  : ${r.calls}\n  W3        : ${r.w3}\n  已保存    : ${r.records}\n  reason    : ${String(r.reason).slice(0, 220)}`)
}
console.log(`\n第四部分：${r4.length - failed4}/${r4.length} 通过；临时目录 ${base4}`)
if (failed4) process.exitCode = 1

// ======================================================================
// 第五部分：已保存的 W3 返工结果 → W4 续接（startNode W4 + resume）
// 续接核对用真实 wf_snapshot.py（临时仓库 repo4）；真实 runW4，agent 桩返回固定的解析和执行结果（不调用模型）。
// ======================================================================
put4(BATCH4, `${keep4[BATCH4]}\n## 返工任务\n### R1 更正原 W4 报告第 262 行（来源：用户决定 D-S2-1-A）\n`)
const keepBatchR1 = read4(BATCH4)
const FP5 = [BATCH4, TASKS4, REQ4, DESIGN4]
const srcEnv = { node: '用户决定', iteration: 1, nextNode: 'W3', reason: '用户决定', stoppedAt: '返工来源核对', batchId: 'batch-02', writes: [], artifacts: [], decisionsNeeded: [],
  data: { rework: [ITEM], reportPath: W5REP, userDecision: { decisionId: 'D-S2-1-A' } } }
const srcRec = recordReal(join(base4, 'runs', 'w3src'), 'UserRework', srcEnv, [W5REP])
const w3Env = (data, extra = {}) => ({ node: 'W3', iteration: 1, nextNode: 'W4', reason: '返工更新', stoppedAt: 'W3·Write', batchId: 'batch-02',
  writes: [{ path: BATCH4, action: '修改' }], artifacts: [], decisionsNeeded: [], data: { action: '返工更新', reworkTaskIds: ['R1'], plan: { reworkTasks: [R1] }, ...data }, ...extra })
let w3n = 0
const w3Record = (data, extra) => { w3n += 1; const r = recordReal(join(base4, 'runs', `w3rec-${w3n}`), 'W3', w3Env(data, extra), FP5); return { path: r.resultPath, sha: fileSha(r.resultPath) } }
const goodW3 = w3Record({})

const planW4 = (runId) => ({
  snapshotRaw: JSON.stringify({ snapshotDir: `/sim/${runId}/W4-1/snapshot`, manifestPath: '/sim/m', manifestSha256: 'm1', fileCount: 1, head: 'h1', outsideRepo: true, probes: [], error: '无' }),
  batchId: 'batch-02', currentBatchSha256: 'b1', lastRegisteredSha256: 'b1', mode: '串行', preexistingChanges: [], problems: [],
  tasks: [
    { id: 'T7', name: '核对 CSS', kind: '核对', goal: 'g', dependencies: [], allowedFiles: [], acceptance: ['AC6'], verification: 'v', order: 1, sourceLines: '38-56' },
    { id: 'T1', name: '更正 T1', kind: '报告更正', goal: 'g', dependencies: [], allowedFiles: [], acceptance: ['AC1'], verification: 'v', order: 2, sourceLines: '58-73' },
    { id: 'T2', name: '更正 T2', kind: '报告更正', goal: 'g', dependencies: ['T7'], allowedFiles: [], acceptance: ['AC12'], verification: 'v', order: 3, sourceLines: '75-88' },
    { id: 'R1', name: '更正第 262 行', kind: '报告更正', goal: 'g', dependencies: [], allowedFiles: [], acceptance: ['AC8', 'AC14'], verification: 'v', order: 4, sourceLines: '150-170' },
  ],
})
const cb4 = { [TASKS4]: { missingIds: [], stateChanged: [], newIds: [], checkedNow: [] } }
const noDiff = JSON.stringify({ changed: [], headAfter: 'h1', checkbox: cb4, prefix: {}, same: {}, lines: {}, error: '无' })

let runNo5 = 0
async function sim5(name, { resume, prepare, expect }) {
  runNo5 += 1
  const runId = `sim5-${runNo5}`
  const report = `${D4}/reports/batch-02/W4-development-${runId}-1.md`
  const calls = []
  const stub = async (prompt, opts) => {
    if (/-record$/.test(opts.label)) { calls.push(opts.label); return fakeRecord(prompt) }
    calls.push(opts.label)
    if (opts.label === 'resume-check') {
      const outs = cmdOf(prompt).split('\n').map((c) => sh4(c).trim())
      return { w3Raw: outs[0], sourceRaw: outs[1] }
    }
    if (opts.label === 'w4-plan') return planW4(runId)
    if (opts.label === 'w4-report') {
      return { action: '新建', error: '无', diffRaw: JSON.stringify({ changed: [{ path: report, change: '新增', sha256: 'r' }, { path: RUNS4, change: '修改', sha256: 'u' }], headAfter: 'h1',
        checkbox: cb4, prefix: { [RUNS4]: true }, same: Object.fromEntries([BATCH4, REQ4, DESIGN4, TASKS4].map((p) => [p, true])), lines: {} }) }
    }
    const id = opts.label.replace('w4-', '')
    return { taskId: id, outcome: '核对完成', stateCheck: '模拟', acChecks: [], corrections: [{ target: '原报告:262', original: 'o', corrected: 'c', basis: 'b' }], issues: [], deferredResolution: [], diffRaw: noDiff, summary: `模拟 ${id}` }
  }
  const args = { feature: { dir: D4, title: '模拟功能', request: '模拟需求' }, run: { id: runId, root: `/nonexistent/${runId}` }, startNode: 'W4', options: { limits: { maxNodeRuns: 1 } } }
  if (resume !== undefined) args.resume = resume
  if (prepare) prepare()
  let out
  try { out = await dispatcher(args, stub, () => {}, () => {}, async () => { throw new Error('不应并行') }, null) } finally { put4(BATCH4, keepBatchR1) }
  out = { route: [], results: [], records: [], ...out }
  const w4 = out.results.find((h) => h.node === 'W4' && !h.resumed)
  return { name, route: out.route.join(' → ') || '（无）', nextNode: out.nextNode, stoppedAt: out.stoppedAt, reason: out.reason, calls: calls.join(' → '),
    w4: w4 ? `${w4.nextNode}；执行 ${(w4.data.results || []).map((x) => x.taskId).join(',') || '无'}` : '未运行', verdict: expect(out, w4, calls) }
}
const RS = (o = {}) => ({ resultPath: goodW3.path, resultSha256: goodW3.sha, source: { resultPath: srcRec.resultPath, resultSha256: fileSha(srcRec.resultPath) }, ...o })
const ranOnly = (calls, ids) => calls.filter((c) => /^w4-(T|R)\d+$/.test(c)).join() === ids.map((x) => `w4-${x}`).join()

const r5 = []
r5.push(await sim5('V1. 有效续接 → W4 只执行 R1（T7/T1/T2 不执行），之后停在上限', { resume: RS(), expect: (o, w4, c) =>
  o.route.join() === 'W3(续接),W4' && w4 && w4.nextNode === 'W5' && ranOnly(c, ['R1']) && w4.data.tasks.map((t) => t.id).join() === 'R1' && has(o.reason, 'maxNodeRuns') }))
r5.push(await sim5('V2. 缺少返工来源记录 → 拒绝', { resume: RS({ source: undefined }),
  expect: (o, w4, c) => !w4 && o.stoppedAt === 'context' && has(o.reason, 'resume.source') && !c.length }))
r5.push(await sim5('V3. W3 记录哈希不符 → 拒绝', { resume: RS({ resultSha256: 'c'.repeat(64) }),
  expect: (o, w4) => !w4 && o.stoppedAt === '续接核对' && has(o.reason, 'W3 结果记录文件的 sha256') }))
r5.push(await sim5('V4. 返工来源记录哈希不符 → 拒绝', { resume: RS({ source: { resultPath: srcRec.resultPath, resultSha256: 'd'.repeat(64) } }),
  expect: (o, w4) => !w4 && has(o.reason, '返工来源记录文件的 sha256') }))
r5.push(await sim5('V5. W3 记录后任务包变化 → 拒绝', { resume: RS(), prepare: () => put4(BATCH4, `${keepBatchR1}### R2 新增\n`),
  expect: (o, w4) => !w4 && has(o.reason, '已变化', 'current-batch.md') }))
const badId = w3Record({ reworkTaskIds: ['X1'], plan: { reworkTasks: [{ ...R1, id: 'X1' }] } })
r5.push(await sim5('V6. 非法返工任务编号（X1）→ 拒绝', { resume: RS({ resultPath: badId.path, resultSha256: badId.sha }),
  expect: (o, w4) => !w4 && has(o.reason, '返工任务编号无效') }))
const emptyIds = w3Record({ reworkTaskIds: [] })
r5.push(await sim5('V7. 返工任务编号为空 → 拒绝（不退回执行全部任务）', { resume: RS({ resultPath: emptyIds.path, resultSha256: emptyIds.sha }),
  expect: (o, w4) => !w4 && has(o.reason, '没有返工任务编号') }))
const notRework = w3Record({ action: '更新' })
r5.push(await sim5('V8. W3 结果不是"返工更新" → 拒绝', { resume: RS({ resultPath: notRework.path, resultSha256: notRework.sha }),
  expect: (o, w4) => !w4 && has(o.reason, '不是"返工更新"') }))
const paused = w3Record({}, { nextNode: 'PAUSE' })
r5.push(await sim5('V9. W3 结果为 PAUSE → 拒绝', { resume: RS({ resultPath: paused.path, resultSha256: paused.sha }),
  expect: (o, w4) => !w4 && has(o.reason, 'nextNode 为 PAUSE') }))
const notInPkg = w3Record({ reworkTaskIds: ['R2'], plan: { reworkTasks: [{ ...R1, id: 'R2' }] } })
r5.push(await sim5('V10. 返工任务不在任务包中（R2）→ W4 暂停，不执行任何任务', { resume: RS({ resultPath: notInPkg.path, resultSha256: notInPkg.sha }),
  expect: (o, w4, c) => w4 && w4.nextNode === 'PAUSE' && has(w4.reason, '找不到 W3 加入的返工任务') && ranOnly(c, []) }))
const otherFinding = w3Record({ plan: { reworkTasks: [{ ...R1, findingId: 'S1-1' }] } })
r5.push(await sim5('V11. 返工意见没有对应任务 → 拒绝', { resume: RS({ resultPath: otherFinding.path, resultSha256: otherFinding.sha }),
  expect: (o, w4) => !w4 && has(o.reason, '返工意见没有对应的返工任务') }))

console.log('\n======== W3 返工结果 → W4 续接 ========')
let failed5 = 0
for (const r of r5) {
  if (!r.verdict) failed5 += 1
  console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  route     : ${r.route}\n  nextNode  : ${r.nextNode}（stoppedAt ${r.stoppedAt}）\n  agent 桩  : ${r.calls || '无'}\n  W4        : ${r.w4}\n  reason    : ${String(r.reason).slice(0, 200)}`)
}
console.log(`\n第五部分：${r5.length - failed5}/${r5.length} 通过`)
if (failed5) process.exitCode = 1

// ======================================================================
// 第六部分：返工轮次的 W4 复核（W4R + review.w3）
// 临时仓库 repo4 中用真实 wf_snapshot.py（importorigin / diff / prefixcheck / fingerprint / resultcheck）；内容复核用固定结果。
// ======================================================================
put4(BATCH4, keepBatchR1)
const W4R_REPORT = `${D4}/reports/batch-02/W4-development-w4rw-1.md`
const SUPP6 = '## 补充更正记录（模拟）'
let n6 = 0
const ISSUE_OTHER = { kind: '其他', basis: `${BATCH4}:5`, text: '行号偏移', ownerTaskId: '无', ownerCoverageBasis: '无', needsWrite: false }
const ISSUE_SPEC = { kind: '规格问题', basis: `${BATCH4}:3`, text: '历史保留部分中 T3 依赖的旧表述', ownerTaskId: '无', ownerCoverageBasis: '无', needsWrite: false }
// 生成一次"原 W4 返工运行"：快照 → 报告 + RUNS 追加 → 运行记录（args.resume 指向 W3 记录）→ 追加补充更正
function makeOrigW4({ w3, issues = [ISSUE_OTHER, ISSUE_SPEC], resumeOf = w3 }) {
  n6 += 1
  const runId = `w4rw-${n6}`
  const snap = join(base4, 'runs', runId, 'W4-1', 'snapshot')
  sh4(`${TOOL_CMD} take '${snap}'`)
  const report = `${D4}/reports/batch-02/W4-development-${runId}-1.md`
  put4(report, '# 本批开发报告\n\n## 完成的任务\n- R1：核对完成\n')
  const bytes = readFileSync(join(repo4, report)).length, rsha = fileSha(join(repo4, report))
  appendFileSync(join(repo4, RUNS4), `| ${runId} | W4 | 1 | batch-02 | ${report} | PAUSE | |\n`)
  const env4 = { node: 'W4', iteration: 1, nextNode: 'PAUSE', reason: 'R1 发现问题', stoppedAt: 'W4·Task', batchId: 'batch-02',
    writes: [{ path: RUNS4, action: '追加' }, { path: report, action: '新建' }], artifacts: [{ kind: 'snapshot', path: snap, sha256: 's' }], decisionsNeeded: [],
    data: { tasks: [{ id: 'R1', kind: '报告更正', allowedFiles: [] }], results: [{ taskId: 'R1', outcome: '核对完成', issues }], pending: [], deferred: [], preexistingChanges: [], reportPath: report } }
  const wf = join(base4, 'runs', runId, 'wf.json')
  writeFileSync(wf, JSON.stringify({ runId: `wf_${runId}`, args: { run: { id: runId }, resume: { resultPath: resumeOf.path, resultSha256: resumeOf.sha } },
    result: { results: [{ ...w3Env({}), resumed: {} }, env4] } }))
  appendFileSync(join(repo4, report), `\n${SUPP6}\n- 原结果为 PAUSE，本补充不改记为成功。\n`)
  return { runId, snap, report, bytes, rsha, wf, wfSha: fileSha(wf) }
}
const judge6 = (o = {}) => ({
  tasks: [{ taskId: 'R1', reportOutcome: '核对完成', matchesOriginal: true, evidence: 'report:4' }],
  issues: [{ index: 0, covered: true, location: '补充 A', evidence: 'ok', historicalOnly: false, historicalMarker: '无', adoptedByCurrent: false, currentEvidence: '无' },
    { index: 1, covered: true, location: '补充 C', evidence: 'ok', historicalOnly: true, historicalMarker: `${BATCH4}:3 原样保留`, adoptedByCurrent: false, currentEvidence: `${TASKS4}:4`, ...o }],
  withinScope: { ok: true, evidence: 'ok' }, pauseRecorded: { ok: true, evidence: 'ok' }, findings: [] })

let sim6No = 0
async function sim6(name, { orig, review = {}, judge = judge6(), decisions = [DECISION], expect }) {
  sim6No += 1
  const runId = `sim6-${sim6No}`
  const root = join(base4, 'runs', runId)
  const calls = []
  let w5up = null
  const stub = async (prompt, opts) => {
    calls.push(opts.label)
    if (opts.label.endsWith('-review')) return judge
    const block = cmdOf(prompt)
    const outs = block.includes("<<'") ? [sh4(block).trim()] : block.split('\n').map((c) => sh4(c).trim())
    if (opts.label.endsWith('-tools')) return { importRaw: outs[0], diffRaw: outs[1], prefixRaw: outs[2], hashRaw: outs[3], w3Raw: outs[4] || '无' }
    return { raw: outs[0] }
  }
  const mocks = { __partial: true, W5: (up, it) => { w5up = up; return { node: 'W5', iteration: it, nextNode: 'PAUSE', reason: 'sim', stoppedAt: 'W5·sim', batchId: up.batchId, writes: [], artifacts: [], decisionsNeeded: [], data: {} } } }
  const args = { feature: { dir: D4, title: '模拟功能', request: '模拟需求' }, run: { id: runId, root }, startNode: 'W4R', decisions,
    legacyBatches: [{ batchId: 'batch-02', tasks: ['T7', 'T1', 'T2'], currentBatchSha256: BATCH4_SHA }],
    review: { runId: orig.runId, batchId: 'batch-02', reportPath: orig.report, snapshotDir: orig.snap, expectedHead: sh4('git rev-parse HEAD').trim(),
      workflowRecord: { path: orig.wf, sha256: orig.wfSha, workflowRunId: `wf_${orig.runId}` },
      originalReport: { sha256: orig.rsha, bytes: orig.bytes, source: '模拟' }, supplementHeading: SUPP6, decision: '模拟用户决定',
      decisionId: 'D-S2-1-A', w3: { resultPath: goodW3.path, resultSha256: goodW3.sha }, ...review },
    options: { deliveryExclusions: [{ path: 'workflow-examples/', reason: '示例' }], limits: { maxNodeRuns: 3 } } }
  for (const [k, v] of Object.entries(review)) if (v === undefined) delete args.review[k]
  let out = await dispatcher(args, stub, () => {}, () => {}, async () => {}, mocks)
  out = { route: [], results: [], records: [], ...out }
  return { name, route: out.route.join(' → ') || '（无）', nextNode: out.nextNode, stoppedAt: out.stoppedAt, reason: out.reason, calls: calls.join(' → ') || '无',
    w5: w5up ? `W4 ${w5up.stoppedAt}，w3=${w5up.data.review.w3 ? w5up.data.review.w3.reworkTaskIds.join(',') : '无'}` : '未进入', verdict: expect(out, w5up) }
}

const r6 = []
const o1 = makeOrigW4({ w3: goodW3 })
r6.push(await sim6('X1. 有效返工：W3 来源匹配、规格问题仅涉及历史内容且已澄清 → 复核通过', { orig: o1,
  expect: (o, up) => o.route.join() === 'W4·复核,W5' && up && up.data.review.w3.reworkTaskIds.join() === 'R1' && up.data.review.decisionId === 'D-S2-1-A'
    && up.data.review.blockingIssues.find((x) => x.kind === '规格问题').historicalMarker.includes(':3') }))
r6.push(await sim6('X2. 伪造决定编号（不在 decisions 中）→ 拒绝', { orig: o1, review: { decisionId: 'D-FAKE' },
  expect: (o, up) => !up && o.stoppedAt === 'context' && has(o.reason, 'D-FAKE') }))
r6.push(await sim6('X3. 来源错配：给出的 W3 不是原运行续接时用的记录 → 拒绝', { orig: o1, review: { w3: { resultPath: badId.path, resultSha256: badId.sha } },
  expect: (o, up) => !up && has(o.reason, '不是原运行续接时使用的来源') }))
r6.push(await sim6('X4. W3 记录哈希不符 → 拒绝', { orig: o1, review: { w3: { resultPath: goodW3.path, resultSha256: 'b'.repeat(64) } },
  expect: (o, up) => !up && has(o.reason, 'W3 结果记录的 sha256') }))
r6.push(await sim6('X6. 规格问题仍被当前任务采用 → 阻塞', { orig: o1, judge: judge6({ adoptedByCurrent: true }),
  expect: (o, up) => !up && has(o.reason, '仍被当前任务或依赖采用') }))
r6.push(await sim6('X7. 规格问题不在明确标注的历史部分 → 阻塞', { orig: o1, judge: judge6({ historicalOnly: false, historicalMarker: '无' }),
  expect: (o, up) => !up && has(o.reason, '不能确认只涉及明确标注的历史内容') }))
r6.push(await sim6('X8. 不给 W3 来源 → 按登记的批次任务比对，R1 ≠ T7/T1/T2 → 拒绝（不按 R 前缀切换）', { orig: o1, review: { w3: undefined },
  expect: (o, up) => !up && has(o.reason, '与登记的批次任务') }))
const o5 = makeOrigW4({ w3: notInPkg })
r6.push(await sim6('X5. 任务不匹配：原运行续接自 R2 的 W3，但 W4 执行的是 R1 → 拒绝', { orig: o5, review: { w3: { resultPath: notInPkg.path, resultSha256: notInPkg.sha } },
  expect: (o, up) => !up && has(o.reason, '不逐项一致') }))
const o9 = makeOrigW4({ w3: goodW3, issues: [ISSUE_OTHER, { ...ISSUE_SPEC, kind: '依赖或冲突' }] })
r6.push(await sim6('X9. 其他种类（依赖或冲突）→ 仍拒绝', { orig: o9,
  expect: (o, up) => !up && has(o.reason, '不能只靠补充更正处理') }))

console.log('\n======== 返工轮次的 W4 复核 ========')
let failed6 = 0
for (const r of r6) {
  if (!r.verdict) failed6 += 1
  console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  route     : ${r.route}\n  nextNode  : ${r.nextNode}（stoppedAt ${r.stoppedAt}）\n  agent 桩  : ${r.calls}\n  W5 上游   : ${r.w5}\n  reason    : ${String(r.reason).slice(0, 220)}`)
}
console.log(`\n第六部分：${r6.length - failed6}/${r6.length} 通过`)
if (failed6) process.exitCode = 1

// ======================================================================
// 第七部分：RUNS.md 指纹豁免在保存与续接中一致（W4 → W5 续接）
// 临时仓库 repo4 中用真实 wf_snapshot.py record / resultcheck；W5 用模拟节点。
// ======================================================================
const REP7 = `${D4}/reports/batch-02/W4-development-y7-1.md`
put4(REP7, '# 报告 y7\n')
put4('app/y.css', '.a { color: red; }\n')
put4(BATCH4, keepBatchR1)
const env7 = { node: 'W4', iteration: 1, nextNode: 'W5', reason: '复核通过', stoppedAt: 'W4·Review', batchId: 'batch-02', writes: [], artifacts: [], decisionsNeeded: [],
  data: { tasks: [{ id: 'R1', kind: '报告更正', allowedFiles: [] }], results: [{ taskId: 'R1', outcome: '核对完成' }], reportPath: REP7,
    preexistingChanges: [{ path: RUNS4 }, { path: 'app/y.css' }, { path: `${D4}/` }] } }
// 与调度器 relatedPaths 相同的规则：RUNS.md 不记录指纹
const paths7 = [BATCH4, TASKS4, REQ4, DESIGN4, REP7, 'app/y.css']
const rec7 = recordReal(join(base4, 'runs', 'y7'), 'W4R', env7, paths7)
const rec7Sha = fileSha(rec7.resultPath)
const rec7b = recordReal(join(base4, 'runs', 'y7b'), 'W4R', env7, paths7.filter((p) => p !== TASKS4))   // 缺少 tasks.md 指纹
const keep7 = Object.fromEntries([REP7, 'app/y.css', BATCH4, RUNS4].map((p) => [p, read4(p)]))

let n7 = 0
async function sim7(name, { rec = rec7.resultPath, sha = rec7Sha, prepare, expect }) {
  n7 += 1
  let w5up = null
  const stub = async (prompt, opts) => {
    if (/-record$/.test(opts.label)) return fakeRecord(prompt)
    return { raw: sh4(cmdOf(prompt)).trim() }
  }
  const mocks = { __partial: true, W5: (up, it) => { w5up = up; return { node: 'W5', iteration: it, nextNode: 'PAUSE', reason: 'sim', stoppedAt: 'W5·sim', batchId: up.batchId, writes: [], artifacts: [], decisionsNeeded: [], data: {} } } }
  const args = { feature: { dir: D4, title: '模拟功能', request: '模拟需求' }, run: { id: `sim7-${n7}`, root: join(base4, 'runs', `sim7-${n7}`) }, startNode: 'W5',
    resume: { resultPath: rec, resultSha256: sha }, options: { limits: { maxNodeRuns: 1 } } }
  if (prepare) prepare()
  let out
  try { out = await dispatcher(args, stub, () => {}, () => {}, async () => {}, mocks) } finally { for (const [p, t] of Object.entries(keep7)) put4(p, t) }
  out = { route: [], ...out }
  return { name, route: out.route.join(' → ') || '（无）', nextNode: out.nextNode, stoppedAt: out.stoppedAt, reason: out.reason, verdict: expect(out, w5up) }
}
const r7 = []
r7.push(await sim7('Y1. 运行前已有变化包含 RUNS.md，结果有效 → 可以续接 W5', { expect: (o, up) => o.route.join() === 'W4R(续接),W5' || (up && o.route[0].includes('续接')) }))
r7.push(await sim7('Y2. RUNS.md 在记录后追加了一行 → 仍可续接（RUNS.md 不做指纹比对，只追加由节点快照检查）', {
  prepare: () => appendFileSync(join(repo4, RUNS4), '| y7 | W4 | 1 | batch-02 | x | W5 | |\n'), expect: (o, up) => !!up }))
r7.push(await sim7('Y3. 报告变化 → 拒绝', { prepare: () => appendFileSync(join(repo4, REP7), '改动\n'), expect: (o, up) => !up && has(o.reason, '已变化', REP7) }))
r7.push(await sim7('Y4. 源码变化（app/y.css）→ 拒绝', { prepare: () => put4('app/y.css', '.a { color: blue; }\n'), expect: (o, up) => !up && has(o.reason, '已变化', 'app/y.css') }))
r7.push(await sim7('Y5. 任务包变化 → 拒绝', { prepare: () => put4(BATCH4, `${keepBatchR1}### R9\n`), expect: (o, up) => !up && has(o.reason, '已变化', 'current-batch.md') }))
r7.push(await sim7('Y6. 必需文件指纹缺失（tasks.md）→ 拒绝', { rec: rec7b.resultPath, sha: fileSha(rec7b.resultPath), expect: (o, up) => !up && has(o.reason, '没有这些必需文件的有效指纹', 'tasks.md') && !has(o.reason, 'RUNS.md') }))
r7.push(await sim7('Y7. 豁免只针对 RUNS.md：其他运行前已有变化的文件（app/y.css）缺指纹 → 拒绝', {
  rec: recordReal(join(base4, 'runs', 'y7c'), 'W4R', env7, paths7.filter((p) => p !== 'app/y.css')).resultPath,
  sha: fileSha(join(base4, 'runs', 'y7c', 'results', 'W4R-1.json')), expect: (o, up) => !up && has(o.reason, '没有这些必需文件的有效指纹', 'app/y.css') }))

console.log('\n======== RUNS.md 指纹豁免一致性 ========')
let failed7 = 0
for (const r of r7) {
  if (!r.verdict) failed7 += 1
  console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  route     : ${r.route}\n  nextNode  : ${r.nextNode}（stoppedAt ${r.stoppedAt}）\n  reason    : ${String(r.reason).slice(0, 200)}`)
}
console.log(`\n第七部分：${r7.length - failed7}/${r7.length} 通过`)
if (failed7) process.exitCode = 1

// ======================================================================
// 第八部分：已保存的 W5 结果 → W6 续接（startNode W6 + resume）
// 续接核对用真实 wf_snapshot.py；审查过期场景运行真实 runW6 的 Preflight，审查范围指纹由真实 fingerprint / refingerprint 计算。
// ======================================================================
for (const [p, t] of Object.entries(keep7)) put4(p, t)
const W5REP8 = `${D4}/reports/batch-02/W5-code-review-y8-1.md`
put4(W5REP8, '# W5 y8\n')
const scope8 = join(base4, 'runs', 'y8', 'W5-1', 'codex', 'scope.json')
const fp8 = JSON.parse(sh4(`${TOOL_CMD} fingerprint '${scope8}' 'app/y.css' '${BATCH4}'`))
const env8 = (o = {}) => ({ node: 'W5', iteration: 1, nextNode: 'W6', reason: '审查通过', stoppedAt: 'W5·Judge', batchId: 'batch-02', writes: [{ path: W5REP8, action: '新建' }],
  artifacts: [{ kind: 'review-input', path: scope8, sha256: fp8.fingerprint }], decisionsNeeded: [],
  data: { reportPath: W5REP8, codex: { outputPath: '/sim/out.txt', outputSha256: 'a'.repeat(64), metaPath: '/sim/meta.json', fingerprint: fp8.fingerprint, status: '已完成' } }, ...o })
const paths8 = [BATCH4, TASKS4, REQ4, DESIGN4, W5REP8]
let n8 = 0
const rec8 = (env, paths = paths8) => { n8 += 1; const r = recordReal(join(base4, 'runs', `y8-${n8}`), 'W5', env, paths); return { path: r.resultPath, sha: fileSha(r.resultPath) } }
const good8 = rec8(env8())
const keep8 = Object.fromEntries([W5REP8, 'app/y.css', BATCH4, TASKS4].map((p) => [p, read4(p)]))

async function sim8(name, { rec = good8, sha, prepare, realW6 = false, expect }) {
  n8 += 1
  let w6up = null
  const calls = []
  const stub = async (prompt, opts) => {
    calls.push(opts.label)
    if (/-record$/.test(opts.label)) return fakeRecord(prompt)
    if (opts.label === 'w6-preflight') {
      const re = sh4(toolLine(prompt, 'refingerprint')).trim()
      return { snapshotRaw: JSON.stringify({ snapshotDir: '/sim/W6-1/snapshot', manifestSha256: 'm', head: 'h', outsideRepo: true, error: '无' }),
        reviewCheckRaw: re, codexCheckRaw: JSON.stringify({ shaMatches: true, metaOutputShaMatches: true, metaExitCode: 0, metaStatus: '已完成' }),
        w5ReportFound: true, acceptance: [], commands: [], environment: { dependenciesInstalled: true, portFree: true, browserToolsAvailable: true, evidenceDirIgnored: true, detail: '' } }
    }
    return { raw: sh4(cmdOf(prompt)).trim() }
  }
  const mocks = realW6 ? null : { __partial: true, W6: (up, it) => { w6up = up; return { node: 'W6', iteration: it, nextNode: 'PAUSE', reason: 'sim', stoppedAt: 'W6·sim', batchId: up.batchId, writes: [], artifacts: [], decisionsNeeded: [], data: {} } } }
  const args = { feature: { dir: D4, title: '模拟功能', request: '模拟需求' }, run: { id: `sim8-${n8}`, root: join(base4, 'runs', `sim8-${n8}`) }, startNode: 'W6',
    resume: rec === null ? undefined : { resultPath: rec.path, resultSha256: sha || rec.sha }, options: { ports: { w6: 5999 }, npmTest: { mode: 'run' }, limits: { maxNodeRuns: 1 } } }
  if (args.resume === undefined) delete args.resume
  if (prepare) prepare()
  let out
  try { out = await dispatcher(args, stub, () => {}, () => {}, async () => {}, mocks) } finally { for (const [p, t] of Object.entries(keep8)) put4(p, t) }
  out = { route: [], results: [], ...out }
  return { name, route: out.route.join(' → ') || '（无）', nextNode: out.nextNode, stoppedAt: out.stoppedAt, reason: out.reason, calls: calls.join(' → ') || '无', verdict: expect(out, w6up, calls) }
}
const r8 = []
r8.push(await sim8('Z1. 有效的 W5 结果 → 续接进入 W6（上游带审查输入清单）', { expect: (o, up) => o.route.join() === 'W5(续接),W6' && up && up.artifacts.some((a) => a.kind === 'review-input') }))
r8.push(await sim8('Z2. 缺少 resume → 拒绝', { rec: null, expect: (o, up, c) => !up && o.stoppedAt === 'context' && has(o.reason, 'startNode 为 W6 时必须提供 resume') && !c.length }))
r8.push(await sim8('Z3. 记录哈希不符 → 拒绝', { sha: 'f'.repeat(64), expect: (o, up) => !up && has(o.reason, 'sha256') && has(o.reason, '不一致') }))
const paused8 = rec8(env8({ nextNode: 'PAUSE' }))
r8.push(await sim8('Z4. W5 结果为 PAUSE → 拒绝', { rec: paused8, expect: (o, up) => !up && has(o.reason, 'nextNode 为 PAUSE') }))
r8.push(await sim8('Z5. 审查报告在记录后变化 → 拒绝', { prepare: () => appendFileSync(join(repo4, W5REP8), '改\n'), expect: (o, up) => !up && has(o.reason, '已变化', W5REP8) }))
r8.push(await sim8('Z6. 任务包在记录后变化 → 拒绝', { prepare: () => put4(BATCH4, `${keepBatchR1}### R8\n`), expect: (o, up) => !up && has(o.reason, '已变化', 'current-batch.md') }))
const noScope = rec8(env8({ artifacts: [] }))
r8.push(await sim8('Z7. 缺少审查输入清单 → 拒绝', { rec: noScope, expect: (o, up) => !up && has(o.reason, 'review-input') }))
const noFp = rec8(env8(), paths8.filter((p) => p !== W5REP8))
r8.push(await sim8('Z8. 缺少审查报告指纹 → 拒绝', { rec: noFp, expect: (o, up) => !up && has(o.reason, '没有这些必需文件的有效指纹', W5REP8) }))
r8.push(await sim8('Z9. 源码（审查范围内）在审查后变化 → 真实 W6·Preflight 判为审查过期并暂停，不使用过期审查', { realW6: true,
  prepare: () => put4('app/y.css', '.a { color: green; }\n'),
  expect: (o, up, c) => c.includes('w6-preflight') && o.nextNode === 'PAUSE' && o.results.some((h) => h.node === 'W6' && h.data && h.data.reviewStale) && has(o.reason, '审查', 'app/y.css') }))
r8.push(await sim8('Z10. 源码未变 → 真实 W6·Preflight 通过审查复核（之后因模拟中没有验收项目而暂停）', { realW6: true,
  expect: (o) => o.results.some((h) => h.node === 'W6' && !(h.data && h.data.reviewStale)) && has(o.reason, '没有从任务包和规格中读到本批的验收项目') }))

console.log('\n======== W5 结果 → W6 续接 ========')
let failed8 = 0
for (const r of r8) {
  if (!r.verdict) failed8 += 1
  console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  route     : ${r.route}\n  nextNode  : ${r.nextNode}（stoppedAt ${r.stoppedAt}）\n  agent 桩  : ${r.calls}\n  reason    : ${String(r.reason).slice(0, 200)}`)
}
console.log(`\n第八部分：${r8.length - failed8}/${r8.length} 通过`)
if (failed8) process.exitCode = 1

// ======================================================================
// 第九部分：留给用户决定的事项与任务包写成后新增的已登记文件（W4 r20261111-w4r6 规划暂停的回归）
// 真实 runW4；agent 为桩。核对：W4 规划、任务提示包含用户决定原文与统一规则；
// 规划不再要求把 RUNS.md 已登记的后续运行文件当作信息不足；但信息不足、规格问题的路由仍不变（门槛不放宽）。
// W5 判断、W7 判定提示按源码静态核对同一规则。
// ======================================================================
const DEC = [{ id: 'D-X-cite', text: '用户决定：R9 一并更正旧报告第 217、238 行引用 :163 → :166（回应任务包“留待用户决定”）。' }]
const LATER_REPORT = `${FEATURE_DIR}/reports/batch-02/W4-development-prev-pause-1.md`
async function runW4Plan9(name, planPatch, check, taskPatch = {}) {
  const prompts = {}
  const calls = []
  const plan = { ...planOut, ...planPatch,
    tasks: [{ id: 'R9', name: '更正引用', kind: '报告更正', goal: 'g', dependencies: [], allowedFiles: [], acceptance: ['AC13'], verification: 'v', order: 1, sourceLines: '200-220', handoff: false }] }
  const stub = async (prompt, opts) => {
    if (isRecord(opts)) return fakeRecord(prompt)
    calls.push(opts.label); prompts[opts.label] = prompt
    if (opts.label === 'w4-plan') return plan
    if (opts.label === 'w4-report') return { action: '新建', diffRaw: reportDiff, error: '无' }
    return { ...taskOut('R9'), handoffPlan: [], ...taskPatch }
  }
  const args = { feature: { dir: FEATURE_DIR, title: '模拟功能', request: '模拟需求' }, run: { id: W4_RUN, root: '/nonexistent/sim-w4-9' },
    startNode: 'W4', decisions: DEC, options: { limits: { maxNodeRuns: 1 } } }
  const out = await dispatcher(args, stub, () => {}, () => {}, async () => { throw new Error('不应并行') }, null)
  const w4 = out.results[0]
  const problems = check({ w4, prompts, calls })
  return { name, verdict: !problems.length, problems, nextNode: w4.nextNode, stoppedAt: w4.stoppedAt, calls: calls.join(' → '), reason: w4.reason }
}
const has9 = (s, ...parts) => parts.every((p) => String(s || '').includes(p))
const RULE_KEY = '留待用户决定'
const r9 = [
  await runW4Plan9('9A. 规划/任务提示含用户决定原文与统一规则；已登记的后续文件补进 preexistingChanges 后继续执行（→ W5）',
    { preexistingChanges: [{ path: LATER_REPORT, note: 'RUNS.md:25 登记（PAUSE），只读' }] },
    ({ w4, prompts }) => [
      !has9(prompts['w4-plan'], 'D-X-cite', RULE_KEY) && '规划提示缺少用户决定原文或统一规则',
      !has9(prompts['w4-plan'], 'RUNS.md 已登记的运行产生的文件', '无法由 RUNS.md 登记解释的变化，仍写进 problems') && '规划提示缺少已登记文件的处理说明或未保留异常变化的上报',
      !has9(prompts['w4-R9'], 'D-X-cite', RULE_KEY, '核实目标内容') && '任务提示缺少用户决定原文、统一规则或核实要求',
      w4.nextNode !== 'W5' && `应进入 W5，实际 ${w4.nextNode}`,
      !(w4.data.preexistingChanges || []).some((c) => c.path === LATER_REPORT) && '补充的只读项没有传到结果中',
    ].filter(Boolean)),
  await runW4Plan9('9B. 规划仍报告信息不足时照旧暂停（门槛不放宽）',
    { problems: [{ kind: '信息不足', basis: 'current-batch.md:1', text: 'R9 没有写明允许修改的文件' }] },
    ({ w4, calls }) => [
      (w4.nextNode !== 'PAUSE' || w4.stoppedAt !== 'W4·Plan') && `应在 W4·Plan 暂停，实际 ${w4.nextNode}/${w4.stoppedAt}`,
      calls.includes('w4-R9') && '信息不足时不应执行任务',
    ].filter(Boolean)),
  await runW4Plan9('9C. 规划仍报告规格问题时照旧转 W2（门槛不放宽）',
    { problems: [{ kind: '规格问题', basis: 'requirements.md:1', text: '与决定无关的规格矛盾' }] },
    ({ w4 }) => [w4.nextNode !== 'W2' && `应转 W2，实际 ${w4.nextNode}`].filter(Boolean)),
]
// 9F–9I：R2 已按决定处理的事项仍被返回到 issues 时，不被静默忽略、不判为通过；真实未解决问题照常阻塞；只有按规则记录（issues 为空）时才继续
const runW4Task9 = (name, taskPatch, check) => runW4Plan9(name, {}, (ctx9) => check(ctx9), taskPatch)
const HANDLED_AS_ISSUE = { kind: '其他', basis: 'current-batch.md:226', text: '任务包 :226 与 D-X-cite 不一致；已按决定更正，不因此暂停。', ownerTaskId: '无', ownerCoverageBasis: '无', needsWrite: false }
const REAL_ISSUE = { kind: '其他', basis: 'old.md:238', text: '原报告 :238 的 :152 应为 :154，不在授权内，留给用户决定。', ownerTaskId: '无', ownerCoverageBasis: '无', needsWrite: false }
r9.push(
  await runW4Task9('9F. 任务提示写明：已处理事项进 corrections.basis、说明进 summary、未解决问题仍须进 issues',
    {}, ({ prompts }) => [
      !has9(prompts['w4-R9'], 'issues 只记录尚未解决的问题', '写进对应 corrections 的 basis', '写进 summary，不写进 issues', '不得改写成说明或放进 summary')
        && '任务提示缺少 issues / corrections.basis / summary 的分工规则',
    ].filter(Boolean)),
  await runW4Task9('9G. 已处理事项仍被返回到 issues → 照旧暂停，原文出现在 reason 中（不静默忽略、不判为通过）',
    { issues: [HANDLED_AS_ISSUE] }, ({ w4 }) => [
      w4.nextNode !== 'PAUSE' && `应暂停，实际 ${w4.nextNode}`,
      !String(w4.reason).includes(HANDLED_AS_ISSUE.text) && 'reason 中没有该条原文（被静默忽略）',
    ].filter(Boolean)),
  await runW4Task9('9H. 真实未解决问题 → 暂停',
    { issues: [REAL_ISSUE] }, ({ w4 }) => [
      w4.nextNode !== 'PAUSE' && `应暂停，实际 ${w4.nextNode}`,
      !String(w4.reason).includes(':152 应为 :154') && 'reason 中没有真实问题原文',
    ].filter(Boolean)),
  await runW4Task9('9I. 按规则记录（决定写在 corrections.basis、说明写在 summary、issues 为空）→ 进入 W5',
    { issues: [], summary: '旧报告保留不改，以本报告为准。',
      corrections: [{ target: 'old.md:238', original: '（current-batch.md:152）', corrected: '（current-batch.md:154）', basis: 'D-X-cite；current-batch.md:226；已用 sed 核实' }] },
    ({ w4 }) => [w4.nextNode !== 'W5' && `应进入 W5，实际 ${w4.nextNode}`].filter(Boolean)),
)
// W5 判断与 W7 判定：从源码中取出对应 agent 调用的提示模板，核对含用户决定原文与统一规则
const promptBlock = (startPat, label) => {
  const s = source.indexOf(startPat); const e = source.indexOf(label, s)
  return s >= 0 && e > s ? source.slice(s, e) : ''
}
const w5Judge = promptBlock('你正在执行 /bowen:feature W5 的判断步骤', "tag('W5', iter, 'judge')")
const w7Gate = promptBlock('你正在执行 /bowen:feature W7 的判定步骤', "tag('W7', iter, 'gate')")
for (const [name, block] of [['9D. W5 判断提示含用户决定与统一规则', w5Judge], ['9E. W7 判定提示含用户决定与统一规则', w7Gate]]) {
  const problems = [!block && '找不到提示模板', block && !has9(block, '${DECISIONS_TEXT}', '${DEFERRED_DECISION_RULE}') && '缺少用户决定原文或统一规则'].filter(Boolean)
  r9.push({ name, verdict: !problems.length, problems, nextNode: '-', stoppedAt: '-', calls: '静态', reason: '-' })
}
console.log('\n======== 第九部分：留给用户决定的事项 / 已登记的后续文件 ========')
for (const r of r9) console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  nextNode  : ${r.nextNode}（stoppedAt ${r.stoppedAt}）\n  agent 桩  : ${r.calls}${r.problems.length ? `\n  问题      : ${r.problems.join('；')}` : ''}\n  reason    : ${String(r.reason).slice(0, 160)}`)
const failed9 = r9.filter((r) => !r.verdict).length
console.log(`\n第九部分：${r9.length - failed9}/${r9.length} 通过`)
if (failed9) process.exitCode = 1

// ======================================================================
// 第十部分：W6 中复现类项目已复现时的路由（用户 2026-11-11 决定）与必需命令精确匹配
// 真实 runW6（从已记录的 W5 结果续接，续接核对与审查复核用真实 wf_snapshot.py）；四个 W6 agent 用固定结果。
// 只有"已复现问题是唯一未解决项、其他必需项都通过、影响判断明确为不影响、通过项都有证据"时才进入 W7；
// 其他真实失败、必需命令未执行、证据缺失、影响不明都必须暂停（或按原规则转 W4）。
// ======================================================================
const LOG1 = '/sim/W6-1/cmd-1.log', LOG2 = '/sim/W6-1/cmd-2.log'
const sc = (id, o = {}) => ({ id, steps: 's', expected: 'e', actual: 'a', status: '通过', failureType: '无', reproduced: '不适用', evidence: [`e/${id}.png`], ...o })
const gRun = (command, exitCode, logPath, o = {}) => JSON.stringify({ command, exitCode, logPath, restored: [], notRestored: [], outputs: [], error: '无', ...o })
const PRE_CMDS = (build = 'npm run build') => [
  { kind: '浏览器启动', command: 'npx vite --config vite.pages.config.ts --port <PORT>', source: 'AGENTS.md:5', rewritesTrackedFiles: [], outputs: [] },
  { kind: '构建', command: build, source: 'package.json:9；展开为 vinext build', rewritesTrackedFiles: ['next-env.d.ts'], outputs: [] },
  { kind: 'lint', command: 'npx eslint app', source: 'AGENTS.md:6；与 HEAD 基线对比', rewritesTrackedFiles: [], outputs: [] },
]
const IMPACT_NONE = { affectsOtherItems: false, affectedItems: [], basis: '其他项目用鼠标点击执行，不依赖键盘焦点' }
const baseBrowser = (o = {}) => ({ isolatedContext: 'newContext；首次加载 localStorage 为空', serverStopped: true, consoleSummary: '无错误',
  scenarios: [sc('AC1'), sc('T6-REPRO', { reproduced: '已复现', evidence: ['e/T6-REPRO.txt'] })], reproImpact: IMPACT_NONE, ...o })
const baseChecks = (o = {}) => ({
  scenarios: [sc('AC13', { evidence: [LOG1, LOG2] }), sc('build: npm run build', { evidence: [LOG1] }), sc('lint: npx eslint app', { evidence: [LOG2] }),
    sc('project-test', { status: '未执行', evidence: [] })],
  lintFindings: [{ location: 'app/page.tsx:49:32', baselineCommand: 'git show HEAD:app/page.tsx | npx eslint --stdin --stdin-filename app/page.tsx：同一错误', classification: '既有问题（已经 Git 基线确认）', basis: 'HEAD 基线相同' }],
  guardedRuns: [gRun('npm run build', 0, LOG1, { restored: ['next-env.d.ts'] }), gRun('npx eslint app', 1, LOG2)], ...o })
const reportDiff10 = JSON.stringify({ changed: [], headAfter: 'h', checkbox: { [TASKS4]: { missingIds: [], stateChanged: [], newIds: [], checkedNow: [] } },
  prefix: { [RUNS4]: true }, same: Object.fromEntries([BATCH4, W5REP8, REQ4, DESIGN4, TASKS4].map((p) => [p, true])), lines: {}, error: '无' })
let n10 = 0
async function sim10(name, { pre = {}, browser = {}, checks = {}, expect }) {
  n10 += 1
  const prompts = {}
  const stub = async (prompt, opts) => {
    prompts[opts.label] = prompt
    if (/-record$/.test(opts.label)) return fakeRecord(prompt)
    if (opts.label === 'w6-preflight') {
      return { snapshotRaw: JSON.stringify({ snapshotDir: '/sim/W6-1/snapshot', manifestSha256: 'm', head: 'h', outsideRepo: true, error: '无' }),
        reviewCheckRaw: sh4(toolLine(prompt, 'refingerprint')).trim(),
        codexCheckRaw: JSON.stringify({ shaMatches: true, metaOutputShaMatches: true, metaExitCode: 0, metaStatus: '已完成' }), w5ReportFound: true,
        acceptance: [
          { id: 'AC1', text: '按钮组', source: 'requirements.md:39', tasks: ['T3'], kind: '浏览器', note: '' },
          { id: 'AC13', text: '构建与 lint', source: 'requirements.md:51', tasks: ['T5'], kind: '命令', note: '' },
          { id: 'T6-REPRO', text: '键盘焦点复现', source: 'tasks.md:56', tasks: ['T6'], kind: '复现', note: '' },
        ],
        commands: PRE_CMDS(pre.build), environment: { dependenciesInstalled: true, portFree: true, browserToolsAvailable: true, evidenceDirIgnored: true, detail: '' } }
    }
    if (opts.label === 'w6-browser') return baseBrowser(browser)
    if (opts.label === 'w6-checks') return baseChecks(checks)
    if (opts.label === 'w6-report') return { action: '新建', diffRaw: reportDiff10 }
    return { raw: sh4(cmdOf(prompt)).trim() }
  }
  const args = { feature: { dir: D4, title: '模拟功能', request: '模拟需求' }, run: { id: `sim10-${n10}`, root: join(base4, 'runs', `sim10-${n10}`) }, startNode: 'W6',
    resume: { resultPath: good8.path, resultSha256: good8.sha },
    options: { ports: { w6: 5999 }, npmTest: { mode: 'exclude', reason: '模拟排除' }, buildRestore: { files: ['next-env.d.ts'], decisionId: 'D-sim' }, limits: { maxNodeRuns: 1 } } }
  let out
  try { out = await dispatcher(args, stub, () => {}, () => {}, async () => {}, null) } finally { for (const [p, t] of Object.entries(keep8)) put4(p, t) }
  const w6 = (out.results || []).find((h) => h.node === 'W6') || {}
  const problems = expect(w6, prompts).filter(Boolean)
  return { name, verdict: !problems.length, problems, nextNode: w6.nextNode, reason: w6.reason }
}
const r10 = []
r10.push(await sim10('10A. 已复现问题是唯一未解决项、影响判断为不影响、证据齐全 → 进入 W7，带 reproducedOpen，原因写明不是全部通过', {
  expect: (w6, p) => [
    w6.nextNode !== 'W7' && `应进入 W7，实际 ${w6.nextNode}`,
    !(w6.data && (w6.data.reproducedOpen || []).some((r) => r.id === 'T6-REPRO' && r.evidence.length)) && '缺少 reproducedOpen 或复现证据',
    !has9(w6.reason, '唯一未解决项', '不是全部通过') && '原因没有写明唯一未解决项 / 不是全部通过',
    !has9(p['w6-preflight'], 'command 只写可直接执行的命令本身') && '前置检查提示缺少 command 只写命令的要求',
    !has9(p['w6-browser'], 'reproImpact') && '浏览器提示缺少影响判断要求',
  ] }))
r10.push(await sim10('10B. 已复现问题影响其他项目 → 暂停', { browser: { reproImpact: { affectsOtherItems: true, affectedItems: ['AC1'], basis: 'AC1 用键盘操作' } },
  expect: (w6) => [w6.nextNode !== 'PAUSE' && `应暂停，实际 ${w6.nextNode}`, !has9(w6.reason, '不能确认该问题不影响其他验收项目') && '原因缺少影响说明'] }))
r10.push(await sim10('10C. 影响判断不明确（未列出却写影响 / 缺字段）→ 暂停', { browser: { reproImpact: undefined },
  expect: (w6) => [w6.nextNode !== 'PAUSE' && `应暂停，实际 ${w6.nextNode}`] }))
r10.push(await sim10('10D. 必需命令带说明写进 command（r5 的情形）→ 精确匹配不到执行记录，仍判未执行并暂停', { pre: { build: 'npm run build（WRANGLER_LOG_PATH=.wrangler/wrangler.log vinext build）' },
  expect: (w6) => [w6.nextNode !== 'PAUSE' && `应暂停，实际 ${w6.nextNode}`, !has9(w6.reason, '未执行') && '原因缺少未执行'] }))
r10.push(await sim10('10E. 构建实际失败 → 不进入 W7', { checks: { guardedRuns: [gRun('npm run build', 1, LOG1), gRun('npx eslint app', 1, LOG2)] },
  expect: (w6) => [w6.nextNode === 'W7' && '构建失败却进入 W7'] }))
r10.push(await sim10('10F. 另有浏览器项目真实失败（代码问题）→ 按原规则转 W4，不进入 W7', { browser: { scenarios: [sc('AC1', { status: '失败', failureType: '代码问题' }), sc('T6-REPRO', { reproduced: '已复现', evidence: ['e/T6-REPRO.txt'] })] },
  expect: (w6) => [w6.nextNode !== 'W4' && `应转 W4，实际 ${w6.nextNode}`] }))
r10.push(await sim10('10G. 标为通过的项目没有证据 → 暂停', { browser: { scenarios: [sc('AC1', { evidence: [] }), sc('T6-REPRO', { reproduced: '已复现', evidence: ['e/T6-REPRO.txt'] })] },
  expect: (w6) => [w6.nextNode !== 'PAUSE' && `应暂停，实际 ${w6.nextNode}`, !has9(w6.reason, '没有证据') && '原因缺少证据说明'] }))
r10.push(await sim10('10H. 未复现且全部通过 → 照旧进入 W7（全部通过路径不变）', { browser: { scenarios: [sc('AC1'), sc('T6-REPRO', { reproduced: '未复现', evidence: ['e/T6-REPRO.txt'] })] },
  expect: (w6) => [w6.nextNode !== 'W7' && `应进入 W7，实际 ${w6.nextNode}`, (w6.data && w6.data.reproducedOpen) && '未复现时不应有 reproducedOpen', !has9(w6.reason, '全部通过') && '原因不是全部通过'] }))
// W7 记录提示：W6 带 reproducedOpen 时写明未完成与证据，不得写成全部通过（源码静态核对）
{
  const s = source.indexOf('你正在执行 /bowen:feature W7 的记录步骤'); const e = source.indexOf("tag('W7', iter, 'record')", s)
  const block = s >= 0 && e > s ? source.slice(s, e) : ''
  const problems = [!has9(block, 'w6.data.reproducedOpen', '不得把本批或功能写成全部通过') && 'W7 记录提示缺少复现未完成的说明'].filter(Boolean)
  r10.push({ name: '10I. W7 记录提示：复现项保持未完成、保留证据、不得写成全部通过', verdict: !problems.length, problems, nextNode: '-', reason: '静态' })
}
console.log('\n======== 第十部分：复现项已复现时的 W6 路由 / 必需命令精确匹配 ========')
for (const r of r10) console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  nextNode  : ${r.nextNode}${r.problems.length ? `\n  问题      : ${r.problems.join('；')}` : ''}\n  reason    : ${String(r.reason).slice(0, 220)}`)
const failed10 = r10.filter((r) => !r.verdict).length
console.log(`\n第十部分：${r10.length - failed10}/${r10.length} 通过`)
if (failed10) process.exitCode = 1

// ======================================================================
// 第十二部分：W6 非运行验收（用户 2026-11-12 授权，方案 1）
// 真实 runW6；证明核对用真实 wf_snapshot.py citecheck（临时仓库中的存档、任务包、W5 报告）。
// 只有授权清单中的流程要求、证明完整且与文件一致时才单独记录并继续；其余一律阻塞，运行验收门槛不变。
// ======================================================================
const NR_ID = 'current-batch.md:145 的 W4 交接要求'
const NR_QUOTE = '并为 W6 列出 T6-REPRO/AC16 的纯键盘按键序列'
const NR_ARCH = `${D4}/reports/batch-02/nr-archive.md`, NR_SRC = `${D4}/reports/batch-02/nr-batch.md`, NR_W5 = `${D4}/reports/batch-02/nr-w5.md`
put4(NR_ARCH, `a\nb\n2. T6：${NR_QUOTE}及判定规则。\n`)
put4(NR_SRC, `x\n- 对应验收标准：AC16；T6-REPRO；${NR_ID}\n`)
put4(NR_W5, `w\n存档 :145 对应现行 :159\nS2-1 已补齐纯键盘交接（K0–K7）\n`)
const shaOf4 = (rel) => createHash('sha256').update(readFileSync(join(repo4, rel))).digest('hex')
const NR_ENTRY = (o = {}) => ({ id: NR_ID, decisionId: 'D-sim-nr', quote: NR_QUOTE, proofs: [
  { role: 'original', path: NR_ARCH, sha256: shaOf4(NR_ARCH), needles: [NR_QUOTE], lines: [3] },
  { role: 'source', path: NR_SRC, sha256: shaOf4(NR_SRC), needles: [NR_ID], lines: [2] },
  { role: 'w5', path: NR_W5, sha256: shaOf4(NR_W5), needles: ['存档 :145 对应现行 :159'], lines: [2] },
  { role: 'w5', path: NR_W5, sha256: shaOf4(NR_W5), needles: ['S2-1 已补齐纯键盘交接（K0–K7）'], lines: [3] },
], ...o })
const NR_ITEM = (o = {}) => ({ id: NR_ID, text: `2. T6：${NR_QUOTE}及判定规则。`, source: 'current-batch.md:159', tasks: ['R1'], kind: '非运行验收', note: 'D-sim-nr', ...o })
const AC_RUN = [
  { id: 'AC1', text: '按钮组', source: 'requirements.md:39', tasks: ['T3'], kind: '浏览器', note: '' },
  { id: 'AC13', text: '构建与 lint', source: 'requirements.md:51', tasks: ['T5'], kind: '命令', note: '' },
  { id: 'T6-REPRO', text: '键盘焦点复现', source: 'tasks.md:56', tasks: ['T6'], kind: '复现', note: '' },
]
const citeRaws = (prompt) => (prompt.match(/python3 -I workflow-examples\/tools\/wf_snapshot\.py citecheck [^\n]*/g) || []).map((c) => sh4(c).trim())
const passBrowser = { scenarios: [sc('AC1'), sc('T6-REPRO', { reproduced: '未复现', evidence: ['e/T6-REPRO.txt'] })] }
let n12 = 0
async function sim12(name, { entries = [NR_ENTRY()], acceptance = [...AC_RUN, NR_ITEM()], raws = citeRaws, browser = passBrowser, checks = {}, decisions = [{ id: 'D-sim-nr', text: '模拟决定' }], expect }) {
  n12 += 1
  const prompts = {}, calls = []
  const stub = async (prompt, opts) => {
    prompts[opts.label] = prompt; calls.push(opts.label)
    if (/-record$/.test(opts.label)) return fakeRecord(prompt)
    if (opts.label === 'w6-preflight') {
      return { snapshotRaw: JSON.stringify({ snapshotDir: '/sim/W6-1/snapshot', manifestSha256: 'm', head: 'h', outsideRepo: true, error: '无' }),
        reviewCheckRaw: sh4(toolLine(prompt, 'refingerprint')).trim(),
        codexCheckRaw: JSON.stringify({ shaMatches: true, metaOutputShaMatches: true, metaExitCode: 0, metaStatus: '已完成' }), w5ReportFound: true,
        nonRuntimeChecksRaw: raws(prompt), acceptance,
        commands: PRE_CMDS(), environment: { dependenciesInstalled: true, portFree: true, browserToolsAvailable: true, evidenceDirIgnored: true, detail: '' } }
    }
    if (opts.label === 'w6-browser') return baseBrowser(browser)
    if (opts.label === 'w6-checks') return baseChecks(checks)
    if (opts.label === 'w6-report') return { action: '新建', diffRaw: reportDiff10 }
    return { raw: sh4(cmdOf(prompt)).trim() }
  }
  const args = { feature: { dir: D4, title: '模拟功能', request: '模拟需求' }, run: { id: `sim12-${n12}`, root: join(base4, 'runs', `sim12-${n12}`) }, startNode: 'W6',
    resume: { resultPath: good8.path, resultSha256: good8.sha }, decisions,
    options: { ports: { w6: 5999 }, npmTest: { mode: 'exclude', reason: '模拟排除' }, buildRestore: { files: ['next-env.d.ts'], decisionId: 'D-sim' }, limits: { maxNodeRuns: 1 },
      nonRuntimeAcceptance: entries } }
  let out
  try { out = await dispatcher(args, stub, () => {}, () => {}, async () => {}, null) } finally { for (const [p, t] of Object.entries(keep8)) put4(p, t) }
  const w6 = (out.results || []).find((h) => h.node === 'W6') || {}
  const problems = expect(w6, prompts, calls, out).filter(Boolean)
  return { name, verdict: !problems.length, problems, nextNode: w6.nextNode || out.nextNode, reason: w6.reason || out.reason }
}
const blocked12 = (w6, calls, ...words) => [
  (w6.nextNode !== 'PAUSE' || w6.stoppedAt !== 'W6·Preflight') && `应在 W6·Preflight 暂停，实际 ${w6.nextNode}/${w6.stoppedAt}`,
  calls.includes('w6-browser') && '阻塞时不应执行浏览器验收',
  !has9(w6.reason, ...words) && `原因缺少 ${words.join('/')}`,
]
const r12 = []
r12.push(await sim12('12A. 合法流程要求（授权、原文一致、证明齐全）→ 单独记录为非运行验收，不进测试、不计为通过；运行验收照常全部执行后进入 W7', {
  expect: (w6, p, calls) => [
    w6.nextNode !== 'W7' && `应进入 W7，实际 ${w6.nextNode}：${w6.reason}`,
    !(w6.data && w6.data.nonRuntime && w6.data.nonRuntime.items.length === 1 && w6.data.nonRuntime.items[0].proofs.length === 4) && 'data.nonRuntime 缺少该项或证明',
    (w6.data && (w6.data.scenarios || []).some((s) => s.id === NR_ID)) && '非运行验收被当作测试场景（可能被计为通过）',
    (w6.data && (w6.data.acceptance || []).some((a) => a.id === NR_ID)) && '非运行验收混入运行验收清单',
    !(w6.data && w6.data.counts && w6.data.counts['通过'] === (w6.data.scenarios || []).filter((s) => s.status === '通过').length) && '通过计数异常',
    !['w6-browser', 'w6-checks', 'w6-report'].every((l) => calls.includes(l)) && '运行验收没有全部执行',
    has9(p['w6-browser'], NR_ID) && '非运行验收被交给浏览器执行',
    !has9(p['w6-browser'], 'AC1', 'T6-REPRO') && '浏览器提示缺少运行验收项目',
    !has9(p['w6-checks'], 'AC13') && '命令检查缺少 AC13',
    !has9(p['w6-report'], '<non_runtime>', '不计为通过', NR_ID) && '报告提示没有单独列出非运行验收',
    !has9(w6.reason, '非运行验收 1 项', '不计为通过') && '路由原因没有写明非运行验收不计为通过',
  ] }))
r12.push(await sim12('12B. 授权项目被 agent 标为"无法执行" → 按授权清单归为非运行验收，不再硬转 W2', { acceptance: [...AC_RUN, NR_ITEM({ kind: '无法执行', note: '不是运行验收' })],
  expect: (w6) => [w6.nextNode !== 'W7' && `应进入 W7，实际 ${w6.nextNode}：${w6.reason}`] }))
r12.push(await sim12('12C. 缺失证明：没有返回证明核对输出 → 阻塞', { raws: () => [],
  expect: (w6, p, calls) => blocked12(w6, calls, '非运行验收核对未通过', '没有该命令的输出') }))
r12.push(await sim12('12D. 证明文件内容已变（哈希与记录不一致）→ 阻塞', { entries: [NR_ENTRY({ proofs: NR_ENTRY().proofs.map((x) => (x.role === 'w5' ? { ...x, sha256: 'a'.repeat(64) } : x)) })],
  expect: (w6, p, calls) => blocked12(w6, calls, 'w5 证明', '不一致') }))
r12.push(await sim12('12E. 证明行号与原文不符（内容冲突）→ 阻塞', { entries: [NR_ENTRY({ proofs: NR_ENTRY().proofs.map((x) => (x.role === 'original' ? { ...x, lines: [2] } : x)) })],
  expect: (w6, p, calls) => blocked12(w6, calls, 'original 证明', '不含给定原文') }))
r12.push(await sim12('12F. 项目原文与授权记录冲突 → 阻塞', { acceptance: [...AC_RUN, NR_ITEM({ text: '交接要求（被改写）' })],
  expect: (w6, p, calls) => blocked12(w6, calls, '内容冲突') }))
r12.push(await sim12('12G. 真实运行验收被错误分类（AC1 标为非运行验收）→ 阻塞，必须实际执行', {
  acceptance: [{ ...AC_RUN[0], kind: '非运行验收', note: '流程检查' }, AC_RUN[1], AC_RUN[2], NR_ITEM()],
  expect: (w6, p, calls) => blocked12(w6, calls, 'AC1', '必须实际执行') }))
r12.push(await sim12('12H. 复现项被错误分类（T6-REPRO 标为非运行验收）→ 阻塞', {
  acceptance: [AC_RUN[0], AC_RUN[1], { ...AC_RUN[2], kind: '非运行验收' }, NR_ITEM()],
  expect: (w6, p, calls) => blocked12(w6, calls, 'T6-REPRO', '必须实际执行') }))
r12.push(await sim12('12I. 未授权的流程要求标为非运行验收 → 阻塞', { acceptance: [...AC_RUN, NR_ITEM(), NR_ITEM({ id: '其他报告交接要求', text: 'x' })],
  expect: (w6, p, calls) => blocked12(w6, calls, '其他报告交接要求', '不在用户授权') }))
r12.push(await sim12('12J. 没有授权清单时 agent 擅用"非运行验收" → 阻塞', { entries: [], raws: () => [],
  expect: (w6, p, calls) => [...blocked12(w6, calls, '不在用户授权'), !has9(p['w6-preflight'], '不得使用"非运行验收"') && '提示没有禁止'] }))
r12.push(await sim12('12K. 没有授权清单时，无法执行的项目照旧转 W2（原规则不变）', { entries: [], raws: () => [], acceptance: [...AC_RUN, NR_ITEM({ kind: '无法执行', note: '无法转换' })],
  expect: (w6) => [w6.nextNode !== 'W2' && `应转 W2，实际 ${w6.nextNode}`] }))
r12.push(await sim12('12L. 授权清单列入 AC 编号 → 参数校验拒绝，未执行任何节点', { entries: [NR_ENTRY({ id: 'AC16 交接', proofs: NR_ENTRY().proofs.map((x) => (x.role === 'source' ? { ...x, needles: ['AC16 交接'] } : x)) })],
  expect: (w6, p, calls, out) => [out.stoppedAt !== 'context' && `应在参数校验拒绝，实际 ${out.stoppedAt}`, !has9(out.reason, '不能归为非运行验收') && '原因缺失', calls.length && '不应调用 agent'] }))
r12.push(await sim12('12M. 授权清单缺少 W5 证据 / 决定不存在 → 参数校验拒绝', { entries: [NR_ENTRY({ decisionId: 'D-none', proofs: NR_ENTRY().proofs.filter((x) => x.role !== 'w5') })],
  expect: (w6, p, calls, out) => [out.stoppedAt !== 'context' && `应在参数校验拒绝，实际 ${out.stoppedAt}`, !has9(out.reason, '缺少 w5 证明', 'D-none') && '原因缺失'] }))
r12.push(await sim12('12N. 非运行验收合法，但运行验收真实失败（AC1 代码问题）→ 照旧转 W4，门槛不变', {
  browser: { scenarios: [sc('AC1', { status: '失败', failureType: '代码问题' }), sc('T6-REPRO', { reproduced: '未复现', evidence: ['e/T6-REPRO.txt'] })] },
  expect: (w6) => [w6.nextNode !== 'W4' && `应转 W4，实际 ${w6.nextNode}`] }))
r12.push(await sim12('12O. 非运行验收合法，但构建失败 → 不进入 W7', { checks: { guardedRuns: [gRun('npm run build', 1, LOG1), gRun('npx eslint app', 1, LOG2)] },
  expect: (w6) => [w6.nextNode === 'W7' && '构建失败却进入 W7'] }))
r12.push(await sim12('12P. 非运行验收合法，T6-REPRO 仍复现 → 按原规则处理（不因非运行验收改变）', { browser: {},
  expect: (w6) => [w6.nextNode !== 'W7' && `应按 10A 规则进入 W7（复现为唯一未解决项），实际 ${w6.nextNode}`, !(w6.data && (w6.data.reproducedOpen || []).length) && '缺少 reproducedOpen', !has9(w6.reason, '不是全部通过') && '原因缺少不是全部通过'] }))
r12.push(await sim12('12Q. 授权项目未出现在验收清单 → 照常执行，记录 authorizedButNotListed', { acceptance: [...AC_RUN],
  expect: (w6) => [w6.nextNode !== 'W7' && `应进入 W7，实际 ${w6.nextNode}`, !(w6.data && w6.data.nonRuntime && w6.data.nonRuntime.authorizedButNotListed.includes(NR_ID)) && '没有记录未出现的授权项目'] }))
console.log('\n======== 第十二部分：W6 非运行验收 ========')
for (const r of r12) console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  nextNode  : ${r.nextNode}${r.problems.length ? `\n  问题      : ${r.problems.join('；')}` : ''}\n  reason    : ${String(r.reason).slice(0, 260)}`)
const failed12 = r12.filter((r) => !r.verdict).length
console.log(`\n第十二部分：${r12.length - failed12}/${r12.length} 通过`)
if (failed12) process.exitCode = 1

// ======================================================================
// 第十一部分：W7 续接中"W5 已接受意见直接返工"的衔接 {kind: 'reviewRework', reviewW5, w3}
// 临时 git 仓库 + 真实 wf_snapshot.py（record / resultcheck / fingerprint / refingerprint / citecheck）；agent 只原样执行命令块。
// 衔接只能由已有记录中的历史哈希证明：W5 记录登记的报告哈希 = W3 记录登记版本的任务包中来源行写明的哈希。
// ======================================================================
{
const base11 = mkdtempSync(join(tmpdir(), 'wf-w7chain-sim-'))
const repo11 = join(base11, 'repo')
const sh11 = (cmd) => execSync(cmd, { cwd: repo11, shell: '/bin/bash', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
const put11 = (rel, text) => { mkdirSync(dirname(join(repo11, rel)), { recursive: true }); writeFileSync(join(repo11, rel), text) }
const read11 = (rel) => readFileSync(join(repo11, rel), 'utf8')
const D11 = 'specs/sim-feature', B11 = `${D11}/current-batch.md`, T11 = `${D11}/tasks.md`
const W4A = `${D11}/reports/batch-03/W4-a-1.md`, W5OLD = `${D11}/reports/batch-03/W5-old-1.md`, W4B = `${D11}/reports/batch-03/W4-b-1.md`
const W5NEW = `${D11}/reports/batch-03/W5-new-1.md`, W6R = `${D11}/reports/batch-03/W6-1.md`
mkdirSync(repo11, { recursive: true })
sh11('git init -q && git config user.email sim@example.invalid && git config user.name sim')
put11(`${D11}/requirements.md`, '# 需求\nAC1\nAC13\n'); put11(`${D11}/design.md`, '# 设计\n')
put11(T11, '- [x] T1\n- [ ] T3\n- [ ] T5\n- [ ] T6\n'); put11(B11, '# batch-03\n## 本批任务\n### T3\n### T6\n### T5\n'); put11('app/x.css', '.a{}\n')
cpSync(join(here, '..', 'tools', 'wf_snapshot.py'), join(repo11, 'workflow-examples', 'tools', 'wf_snapshot.py'))
sh11('git add -A && git commit -qm init')
const fsha11 = (rel) => fileSha(join(repo11, rel))
let k11 = 0
const rec11 = (key, env, paths) => {
  k11 += 1
  const j = JSON.stringify(env)
  const r = JSON.parse(sh11(`${TOOL_CMD} record '${join(base11, 'runs', `r${k11}`)}' ${key} 1 ${sha256(j)} ${paths.map((p) => `--path '${p}'`).join(' ')} <<'EOF_R'\n${j}\nEOF_R`))
  return { resultPath: r.resultPath, resultSha256: fileSha(r.resultPath) }
}
const scope11 = (name, files) => { const p = join(base11, 'scopes', name, 'scope.json'); const o = JSON.parse(sh11(`${TOOL_CMD} fingerprint '${p}' ${files.map((f) => `'${f}'`).join(' ')}`)); return { path: p, sha256: o.fingerprint } }
const env11 = (node, nextNode, data, artifacts = []) => ({ node, iteration: 1, nextNode, reason: 'sim', stoppedAt: `${node}·sim`, batchId: 'batch-03', writes: [], artifacts, decisionsNeeded: [], data })

// 1) 第一轮 W4（T3、T6、T5 交接）
put11(W4A, '# W4 a\n')
const w4a = rec11('W4', env11('W4', 'W5', { reportPath: W4A, tasks: [{ id: 'T3' }, { id: 'T6' }, { id: 'T5' }] }), [B11, T11, W4A])
// 2) 审查第一轮的 W5：接受 S2-1，路由 W4
put11(W5OLD, '# W5 old\n| S2-1 | 接受 | W4 |\n')
const scOld = scope11('old', ['app/x.css', B11, W4A])
const rvEnv = (o = {}) => env11('W5', 'W4', { reportPath: W5OLD, rework: [{ id: 'S2-1', basis: 'x', request: 'y' }], codex: { fingerprint: scOld.sha256 } }, [{ kind: 'review-input', ...scOld }])
const rv = rec11('W5', { ...rvEnv(), ...(o => o)({}) }, [B11, T11, W5OLD])
const H5 = fsha11(W5OLD)
// 用于 N6：结论不是 W4 的 W5 记录（同一报告）
const rvPause = rec11('W5', { ...rvEnv(), nextNode: 'PAUSE' }, [B11, T11, W5OLD])
// 用于 N5：记录时报告内容不同（之后恢复），所以它登记的报告哈希与任务包来源行写的不同
put11(W5OLD, '# W5 old（记录时的另一版）\n'); const rvOtherHash = rec11('W5', rvEnv(), [B11, T11, W5OLD]); put11(W5OLD, '# W5 old\n| S2-1 | 接受 | W4 |\n')
// 3) W3 返工更新：任务包追加 R2 及来源行（写明 W5 报告路径、哈希和意见编号）
put11(B11, `${read11(B11)}## 返工任务\n### R2\n- 审查报告：\`${W5OLD}\`（sha256 \`${H5}\`），意见编号 S2-1（接受，路线 W4）。\n`)
const w3Env = (task, ids = ['R2']) => env11('W3', 'W4', { action: '返工更新', reworkTaskIds: ids, plan: { reworkTasks: [task] } })
const R2T = { id: 'R2', source: W5OLD, findingId: 'S2-1', kind: '报告更正' }
const w3 = rec11('W3', w3Env(R2T), [B11, T11])
const w3BadSource = rec11('W3', w3Env({ ...R2T, source: `${D11}/reports/batch-03/W5-other.md` }), [B11, T11])
const w3BadFinding = rec11('W3', w3Env({ ...R2T, findingId: 'S9-9' }), [B11, T11])
const w3BadTask = rec11('W3', w3Env({ ...R2T, id: 'R3' }, ['R3']), [B11, T11])
// 4) 第二轮 W4（R2）
put11(W4B, '# W4 b\n')
const w4b = rec11('W4', env11('W4', 'W5', { reportPath: W4B, tasks: [{ id: 'R2' }] }), [B11, T11, W4B])
// 5) 最新 W5 → W6；6) W6 → W7
put11(W5NEW, '# W5 new\n')
const scNew = scope11('new', ['app/x.css', B11, T11, W4A, W4B])
const w5n = rec11('W5', env11('W5', 'W6', { reportPath: W5NEW, codex: { fingerprint: scNew.sha256 } }, [{ kind: 'review-input', ...scNew }]), [B11, T11, W5NEW])
put11(W6R, '# W6\n')
const w6 = rec11('W6', env11('W6', 'W7', { reportPath: W6R, scenarios: [] }, [{ kind: 'review-input', ...scNew }]), [B11, T11, W6R])
const keep11 = Object.fromEntries([B11, T11, W5OLD, W4A, W4B, W5NEW, W6R].map((p) => [p, read11(p)]))

let n11 = 0
async function sim11(name, { links, chain, resume, prepare, rawHook, wfHook, agentHook, startNode = 'W7', options = {}, decisions, expect }) {
  n11 += 1
  const calls = []; const prompts = {}
  const stub = async (prompt, opts) => {
    calls.push(opts.label); prompts[opts.label] = prompt
    // 续接核对：每条记录一个 agent（resume-check-<n>），只执行一条 resultcheck；rawHook 模拟 agent 转交出错
    // 续接核对：resume-check-<n>（每条记录一次 resultcheck --meta）、resume-export（export-records 导出正文数据脚本）
    if (/^resume-(check-\d+|export)$/.test(opts.label)) {
      const cmd = cmdOf(prompt)
      const raw = sh11(cmd).trim()
      return rawHook ? rawHook(opts.label, raw, cmd) : { raw }
    }
    if (['resume-scope', 'resume-cite'].includes(opts.label)) return { raws: cmdOf(prompt).split('\n').map((c) => sh11(c).trim()) }
    if (agentHook) { const v = agentHook(opts.label, prompt); if (v !== undefined) return v }
    return null   // W7·Gate / W8·Inventory 起的 agent 不在本测试范围（除非 agentHook 提供）：返回 null，节点在该处停止
  }
  const root = join(base11, 'runs', `sim11-${n11}`); mkdirSync(root, { recursive: true })
  const args = startNode === 'W8'
    ? { feature: { dir: D11, title: '模拟功能', request: '模拟需求' }, run: { id: `sim11-${n11}`, root }, startNode, resume, decisions, options: { limits: { maxNodeRuns: 1 }, ...options } }
    : { feature: { dir: D11, title: '模拟功能', request: '模拟需求' }, run: { id: `sim11-${n11}`, root }, startNode,
      resume: resume || w6, chain: chain || { w5: w5n, w4: [w4a, w4b], links: links || [{ kind: 'reviewRework', reviewW5: rv, w3 }] }, options: { limits: { maxNodeRuns: 1 }, ...options } }
  if (prepare) prepare()
  let out
  try {
    const cwd = process.cwd(); process.chdir(repo11)
    const wf = wfHook ? async (ref) => wfHook(await simWorkflow(ref), ref) : simWorkflow
    try { out = await dispatcher(args, stub, () => {}, () => {}, async () => {}, null, wf) } finally { process.chdir(cwd) }
  } finally { for (const [p, t] of Object.entries(keep11)) put11(p, t) }
  const problems = expect(out, calls, prompts).filter(Boolean)
  return { name, verdict: !problems.length, problems, nextNode: out.nextNode, stoppedAt: out.stoppedAt, calls: calls.join(' → '), reason: out.reason }
}
const rejected = (o, c, ...parts) => [o.stoppedAt !== '续接核对' && o.stoppedAt !== 'context' && `应在续接核对处拒绝，实际停在 ${o.stoppedAt}`,
  c.includes('w7-gate') && '拒绝后不应进入 W7·Gate', !has9(o.reason, ...parts) && `原因缺少：${parts.join(' / ')}`]
const r11 = []
r11.push(await sim11('11A. 有效衔接（历史哈希一致、来源与意见一致、任务一致）→ 通过续接核对，进入 W7·Gate', {
  expect: (o, c, p) => [!c.includes('resume-cite') && '没有执行任务包来源引用核对', !c.includes('w7-gate') && `没有进入 W7·Gate（${o.reason}）`,
    !has9(p['w7-gate'], '其接受的意见') && 'W7·Gate 提示没有按 W5 接受意见描述较早审查'] }))
r11.push(await sim11('11B. 任务包在 W3 记录后被改动 → 拒绝（各记录登记的任务包指纹先行失效）', { prepare: () => put11(B11, `${keep11[B11]}改动\n`),
  expect: (o, c) => rejected(o, c, '已变化', 'current-batch.md') }))
{ // 11B2：citecheck 本身——当前内容不是记录的版本时不搜索、不给出行号（不能用现在的内容冒充历史证明）
  const ok = JSON.parse(sh11(`${TOOL_CMD} citecheck '${B11}' '${fsha11(B11)}' '${W5OLD}' '${H5}' 'S2-1'`))
  const bad = JSON.parse(sh11(`${TOOL_CMD} citecheck '${B11}' '${'0'.repeat(64)}' '${W5OLD}' '${H5}' 'S2-1'`))
  const problems = [!(ok.shaMatches && ok.lines.length === 1) && `哈希一致时应找到 1 行（实际 ${JSON.stringify(ok.lines)}）`,
    (bad.shaMatches || bad.lines.length) && '哈希不一致时仍给出了行号'].filter(Boolean)
  r11.push({ name: '11B2. citecheck：哈希一致才搜索来源行；不一致时不给行号', verdict: !problems.length, problems, stoppedAt: '-', calls: '工具', reason: JSON.stringify({ ok: ok.lines, bad: bad.lines }) })
}
r11.push(await sim11('11C. W5 审查报告在记录后被改动 → 拒绝', { prepare: () => put11(W5OLD, `${keep11[W5OLD]}改动\n`),
  expect: (o, c) => rejected(o, c, '自身报告') }))
r11.push(await sim11('11D. 返工来源不是该 W5 的报告 → 拒绝', { links: [{ kind: 'reviewRework', reviewW5: rv, w3: w3BadSource }],
  expect: (o, c) => rejected(o, c, '不是 reviewW5 的审查报告') }))
r11.push(await sim11('11E. 返工意见编号不在该 W5 接受的意见中 → 拒绝', { links: [{ kind: 'reviewRework', reviewW5: rv, w3: w3BadFinding }],
  expect: (o, c) => rejected(o, c, '不在 reviewW5 接受的意见') }))
r11.push(await sim11('11F. W3 返工任务与后续 W4 执行的任务不一致 → 拒绝', { links: [{ kind: 'reviewRework', reviewW5: rv, w3: w3BadTask }],
  expect: (o, c) => rejected(o, c, '不一致') }))
r11.push(await sim11('11G. reviewW5 的结论不是 W4 → 拒绝', { links: [{ kind: 'reviewRework', reviewW5: rvPause, w3 }],
  expect: (o, c) => rejected(o, c, '不是 W4') }))
r11.push(await sim11('11H. W5 登记的报告哈希与任务包来源行写的不同 → 拒绝（不退回路径匹配）', { links: [{ kind: 'reviewRework', reviewW5: rvOtherHash, w3 }],
  expect: (o, c) => rejected(o, c, '没有同时写明') }))
r11.push(await sim11('11I. 记录文件哈希与调用方给出的不一致 → 拒绝', { links: [{ kind: 'reviewRework', reviewW5: { ...rv, resultSha256: 'f'.repeat(64) }, w3 }],
  expect: (o, c) => rejected(o, c, 'sha256') }))
r11.push(await sim11('11J. 省略 kind 也不给 userRework → 参数校验拒绝（不能靠省略切换为较弱校验）', { links: [{ reviewW5: rv, w3 }],
  expect: (o, c) => rejected(o, c, 'reviewRework') }))
r11.push(await sim11('11K. kind 为 reviewRework 却带 userRework → 参数校验拒绝', { links: [{ kind: 'reviewRework', reviewW5: rv, userRework: rv, w3 }],
  expect: (o, c) => rejected(o, c, '不得带 userRework') }))
r11.push(await sim11('11L. 只给最新一轮 W4、不给衔接 → W7 只把 R2 当作本批任务，不能借此勾选 T3/T5', { chain: { w5: w5n, w4: [w4b], links: [] },
  expect: (o, c, p) => [c.includes('w7-gate') && has9(p['w7-gate'], 'T3') && '跳过衔接后 W7 仍把 T3 当作本批任务'] }))
// 11M–11Y：续接核对记录正文不经 agent 转交（用户 2026-11-12 授权）：工具导出数据脚本，调度脚本用 workflow() 直接加载并核对。
// 校验门槛不变，任一失败都阻塞
{
  // 大记录：含多字节字符，约 140KB UTF-8
  const w6Big = rec11('W6', env11('W6', 'W7', { reportPath: W6R, scenarios: [], padding: 'x'.repeat(30000) + '中文验收证据'.repeat(6000) }, [{ kind: 'review-input', ...scNew }]), [B11, T11, W6R])
  // 被篡改的记录：改动 envelopeJson 内容但保留原 envelopeSha256，文件 sha256 按篡改后的内容给出（内容自相矛盾）
  const tampered = (() => {
    const d = JSON.parse(readFileSync(w5n.resultPath, 'utf8'))
    d.envelopeJson = d.envelopeJson.replace('"W6"', '"W7"')
    const p = join(base11, 'runs', 'tampered', 'results', 'W5-1.json'); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(d))
    return { resultPath: p, resultSha256: fileSha(p) }
  })()
  const checkCalls = (c) => c.filter((x) => /^resume-check-\d+$/.test(x))
  const edit = (raw, f) => ({ raw: JSON.stringify(f(JSON.parse(raw))) })
  const mapRec = (data, i, f) => ({ ...data, records: data.records.map((r, j) => (j === i ? f(r) : r)) })
  const BIG = { resume: w6Big }
  let exportRaw = ''
  r11.push(await sim11('11M. 大记录（约 140KB，含多字节字符）→ 工具导出、脚本直接加载，正文与 envelopeSha256 一致，进入 W7·Gate；agent 只传短元数据', { ...BIG,
    rawHook: (l, raw) => { if (l === 'resume-export') exportRaw = raw; return { raw } },
    expect: (o, c, p) => [!c.includes('w7-gate') && `没有进入 W7·Gate（${o.reason}）`, checkCalls(c).length !== 6 && `应有 6 次单条核对，实际 ${checkCalls(c).length}`,
      !c.includes('resume-export') && '没有导出记录正文', c.some((l) => /chunk/.test(l)) && '仍在分段转交',
      exportRaw.length > 4000 && `导出步骤 agent 返回内容过长（${exportRaw.length} 字符），正文可能经 agent 转交`,
      !has9(p['resume-check-1'], '--meta') && '核对没有使用 --meta'] }))
  r11.push(await sim11('11N. 记录文件被篡改（内容与其 envelopeSha256 自相矛盾）→ 工具拒绝导出，阻塞', { chain: { w5: tampered, w4: [w4a, w4b], links: [{ kind: 'reviewRework', reviewW5: rv, w3 }] },
    expect: (o, c) => rejected(o, c, '导出记录正文失败', '记录内容与其 envelopeSha256 不一致') }))
  r11.push(await sim11('11O. 给出的哈希与记录文件不符 → 阻塞', { chain: { w5: w5n, w4: [w4a, { ...w4b, resultSha256: 'b'.repeat(64) }], links: [{ kind: 'reviewRework', reviewW5: rv, w3 }] },
    expect: (o, c) => rejected(o, c, 'sha256 与给出的不一致') }))
  r11.push(await sim11('11P. 记录文件缺失 → 阻塞（不导出）', { chain: { w5: w5n, w4: [w4a, w4b], links: [{ kind: 'reviewRework', reviewW5: { resultPath: join(base11, 'runs', 'none', 'W5-1.json'), resultSha256: 'c'.repeat(64) }, w3 }] },
    expect: (o, c) => [...rejected(o, c, 'link1.reviewW5', '结果记录不存在'), c.includes('resume-export') && '记录缺失时不应导出'] }))
  r11.push(await sim11('11Q. 其中一条核对 agent 没有返回 → 阻塞', { rawHook: (l, raw) => (l === 'resume-check-4' ? null : { raw }),
    expect: (o, c) => rejected(o, c, '没有返回结果', 'W4#2') }))
  r11.push(await sim11('11R. 来源不匹配（加载的第 2 条是另一条记录）→ 阻塞', { wfHook: (data) => mapRec(data, 1, () => data.records[2]),
    expect: (o, c) => rejected(o, c, 'W5：导出的第 2 条不是该记录', '来源不匹配') }))
  r11.push(await sim11('11S. 加载的正文被改动（保留原 envelopeSha256）→ 阻塞', { ...BIG, wfHook: (data) => mapRec(data, 0, (r) => ({ ...r, envelopeJson: r.envelopeJson.replace('中文', '英文') })),
    expect: (o, c) => rejected(o, c, 'W6：加载的正文 sha256', '不一致') }))
  r11.push(await sim11('11T. 加载的正文被改动并重算 envelopeSha256 → 仍阻塞（以 resultcheck 读到的原记录哈希为准，不接受重新生成的哈希）', {
    wfHook: (data) => mapRec(data, 0, (r) => { const envelopeJson = r.envelopeJson.replace('"W7"', '"W8"'); return { ...r, envelopeJson, envelopeSha256: sha256(envelopeJson) } }),
    expect: (o, c) => rejected(o, c, 'W6：加载的正文 sha256', '不一致') }))
  r11.push(await sim11('11U. 读取导出的数据脚本失败 → 阻塞', { wfHook: () => { throw new Error('模拟读取失败') },
    expect: (o, c) => rejected(o, c, '读取导出的记录正文失败', '模拟读取失败') }))
  r11.push(await sim11('11V. 加载的条数不符（少一条）→ 阻塞', { wfHook: (data) => ({ ...data, records: data.records.slice(1) }),
    expect: (o, c) => rejected(o, c, '条数不符') }))
  r11.push(await sim11('11W. 导出 agent 没有返回 / 返回的输出路径不是指定路径 → 阻塞', { rawHook: (l, raw) => (l === 'resume-export' ? edit(raw, (x) => ({ ...x, outPath: '/tmp/other.js' })) : { raw }),
    expect: (o, c) => rejected(o, c, '导出文件不是指定路径') }))
  r11.push(await sim11('11X. 导出 agent 没有返回 → 阻塞', { rawHook: (l, raw) => (l === 'resume-export' ? null : { raw }),
    expect: (o, c) => rejected(o, c, '导出记录正文的 agent 没有返回结果') }))
  { // 11Y：工具层——不覆盖已有文件；仓库内路径拒绝；任一记录不通过时不写文件；导出内容与原记录一致
    const out = join(base11, 'export-y', 'records.js')
    const ok = JSON.parse(sh11(`${TOOL_CMD} export-records '${out}' '${w6Big.resultPath}' '${w6Big.resultSha256}' '${w5n.resultPath}' '${w5n.resultSha256}'`))
    const again = JSON.parse(sh11(`${TOOL_CMD} export-records '${out}' '${w6Big.resultPath}' '${w6Big.resultSha256}'`))
    const inRepo = JSON.parse(sh11(`${TOOL_CMD} export-records '${join(repo11, 'x.js')}' '${w6Big.resultPath}' '${w6Big.resultSha256}'`))
    const badOut = join(base11, 'export-y', 'bad.js')
    const bad = JSON.parse(sh11(`${TOOL_CMD} export-records '${badOut}' '${w6Big.resultPath}' '${w6Big.resultSha256}' '${w5n.resultPath}' '${'e'.repeat(64)}'`))
    const loaded = await simWorkflow({ scriptPath: out })
    const orig = JSON.parse(readFileSync(w6Big.resultPath, 'utf8'))
    const problems = [ok.error !== '无' && `正常导出失败：${ok.error}`, again.error === '无' && '已存在的文件被覆盖', inRepo.error === '无' && '仓库内路径没有被拒绝',
      (bad.error === '无' || existsSync(badOut)) && '有记录哈希不符时仍写了文件', loaded.records[0].envelopeJson !== orig.envelopeJson && '导出的正文与原记录不一致'].filter(Boolean)
    r11.push({ name: '11Y. 工具：不覆盖、拒绝仓库内路径、任一记录不通过即不写文件；导出正文与原记录逐字一致', verdict: !problems.length, problems, stoppedAt: '-', calls: '工具', reason: `正文 ${orig.envelopeJson.length} 字符` })
  }
}
// 11Z1–11Z14：W8 独立续接（已保存的 W7 → W8 结果）与 W8 lint 排除（用户 2026-11-12 授权）
{
  const IDX11 = 'specs/INDEX.md', W7R = `${D11}/reports/batch-03/W7-1.md`
  put11(IDX11, '| 模拟功能 | specs/sim-feature/ | 已完成 |\n'); put11(W7R, '# W7\n')
  const keepW8 = { [IDX11]: read11(IDX11), [W7R]: read11(W7R) }
  const W8_FP = [B11, T11, IDX11, `${D11}/requirements.md`, `${D11}/design.md`, W7R]
  const w7ok = rec11('W7', env11('W7', 'W8', { reportPath: W7R, decisions: [] }), W8_FP)
  const w7pause = rec11('W7', env11('W7', 'PAUSE', { reportPath: W7R }), W8_FP)
  const w7noIdx = rec11('W7', env11('W7', 'W8', { reportPath: W7R }), [B11, T11, W7R])
  const w7tampered = (() => {
    const d = JSON.parse(readFileSync(w7ok.resultPath, 'utf8')); d.envelopeJson = d.envelopeJson.replace('"W8"', '"DONE"')
    const p = join(base11, 'runs', 'w7tampered', 'results', 'W7-1.json'); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(d))
    return { resultPath: p, resultSha256: fileSha(p) }
  })()
  const w8 = (name, o) => sim11(name, { startNode: 'W8', options: { ports: { w8: 5998 } }, ...o })
  const reached = (o, c) => [!c.includes('w8-inventory') && `没有进入 W8（${o.reason}）`, o.route && o.route[0] !== 'W7(续接)' && `路由应以 W7(续接) 开头，实际 ${o.route}`,
    c.some((l) => /^w7-/.test(l)) && '重跑了 W7']
  r11.push(await w8('11Z1. 有效的 W7 → W8 记录 → 续接进入 W8（W7 不重跑，正文由工具导出、脚本加载）', { resume: w7ok,
    expect: (o, c) => [...reached(o, c), !c.includes('resume-export') && '没有导出记录正文'] }))
  r11.push(await w8('11Z2. W8 缺少 resume → 参数校验拒绝', { resume: undefined, expect: (o, c) => [o.stoppedAt !== 'context' && `应在参数校验拒绝，实际 ${o.stoppedAt}`, c.length && '不应调用 agent'] }))
  r11.push(await w8('11Z3. 记录被篡改（正文与 envelopeSha256 不符）→ 阻塞', { resume: w7tampered, expect: (o, c) => [...rejected(o, c, '不一致'), c.includes('w8-inventory') && '阻塞后仍进入 W8'] }))
  r11.push(await w8('11Z4. 给出的哈希不符 → 阻塞', { resume: { ...w7ok, resultSha256: 'f'.repeat(64) }, expect: (o, c) => [...rejected(o, c, 'sha256'), c.includes('w8-inventory') && '阻塞后仍进入 W8'] }))
  r11.push(await w8('11Z5. 记录文件缺失 → 阻塞', { resume: { resultPath: join(base11, 'runs', 'none', 'W7-1.json'), resultSha256: 'a'.repeat(64) },
    expect: (o, c) => [...rejected(o, c, '结果记录不存在'), c.includes('w8-inventory') && '阻塞后仍进入 W8'] }))
  r11.push(await w8('11Z6. 记录的路由不是 W7 → W8（PAUSE）→ 阻塞', { resume: w7pause, expect: (o, c) => [...rejected(o, c, '不是 W7 → W8'), c.includes('w8-inventory') && '阻塞后仍进入 W8'] }))
  r11.push(await w8('11Z7. 记录之后 tasks.md 已变化（源码/任务指纹不符）→ 阻塞', { resume: w7ok, prepare: () => put11(T11, `${keep11[T11]}- [x] T9\n`),
    expect: (o, c) => [...rejected(o, c, '已变化', 'tasks.md'), c.includes('w8-inventory') && '阻塞后仍进入 W8'] }))
  r11.push(await w8('11Z8. 记录没有登记规格等必需文件的指纹 → 阻塞', { resume: w7noIdx, expect: (o, c) => rejected(o, c, '必需文件的有效指纹') }))
  r11.push(await w8('11Z9. 读取导出的记录正文失败 → 阻塞', { resume: w7ok, wfHook: () => { throw new Error('模拟读取失败') }, expect: (o, c) => rejected(o, c, '读取导出的记录正文失败') }))
  r11.push(await w8('11Z10. 加载的正文被改动并重算哈希 → 阻塞（以 resultcheck 读到的原哈希为准）', { resume: w7ok,
    wfHook: (data) => ({ ...data, records: data.records.map((r) => { const envelopeJson = r.envelopeJson.replace('"W8"', '"DONE"'); return { ...r, envelopeJson, envelopeSha256: sha256(envelopeJson) } }) }),
    expect: (o, c) => rejected(o, c, '加载的正文 sha256') }))

  // W8 lint 排除：真实 runW8，W8 各 agent 用固定结果
  const RUNS11 = `${D11}/reports/RUNS.md`
  const SNAP = JSON.stringify({ snapshotDir: '/sim/W8-1/snapshot', manifestSha256: 'm', head: 'h', outsideRepo: true, error: '无' })
  const W8_CMDS = [{ kind: 'lint', command: 'npx eslint app', source: 'AGENTS.md:6', rewritesTrackedFiles: [], outputs: [] },
    { kind: '构建', command: 'npm run build', source: 'package.json', rewritesTrackedFiles: ['next-env.d.ts'], outputs: [] }]
  const inv = { snapshotRaw: SNAP, uncheckedTasks: [], indexComplete: true, documents: [], checkedTaskEvidence: [], acceptance: [], recordedCodeState: [],
    codeStateRaw: JSON.stringify({ files: [], missing: [], error: '无' }), evidenceRaw: JSON.stringify({ files: [], missing: [], error: '无' }), specIssues: [], commands: W8_CMDS,
    environment: { dependenciesInstalled: true, portFree: true, browserToolsAvailable: true, evidenceDirIgnored: true, detail: '' } }
  const ci = (kind, o = {}) => ({ kind, command: kind, status: '通过', failureType: '无', note: '', ...o })
  const diffW8 = JSON.stringify({ changed: [], headAfter: 'h', checkbox: { [T11]: { missingIds: [], stateChanged: [], newIds: [], checkedNow: [] } },
    prefix: { [RUNS11]: true }, same: Object.fromEntries([B11, IDX11, `${D11}/requirements.md`, `${D11}/design.md`, T11].map((p) => [p, true])), lines: {}, error: '无' })
  const lf = (location, classification, basis = 'b') => ({ location, baselineCommand: '未执行', classification, basis })
  const w8run = (name, { lintItem = {}, typeItem = {}, findings = [], expect }) => w8(name, { resume: w7ok,
    options: { ports: { w8: 5998 }, npmTest: { mode: 'exclude', reason: 'D-npm-test-exclude 模拟' }, typecheck: { command: 'node_modules/.bin/tsc --noEmit' },
      lintExclusions: [{ path: 'pages-dist/', reason: '构建产物' }, { path: 'workflow-examples/', reason: '交付范围外' }] },
    agentHook: (l, prompt) => (l === 'w8-inventory' ? inv
      : l === 'w8-checks' ? { items: [ci('lint', lintItem), ci('类型检查', typeItem), ci('测试', { status: '未执行', note: '排除' }), ci('构建')], lintFindings: findings, guardedRuns: [] }
        : l === 'w8-report' ? { action: '新建', branchIssues: [], verified: [], unverified: [], externalNotExecuted: ['commit'], diffRaw: diffW8 } : undefined),
    expect: (o, c, p) => { const r = (o.results || []).find((h) => h.node === 'W8') || {}; return expect(r, p, o) } })
  const lintOf = (r) => ((r.data && r.data.checks) || []).find((x) => x.kind === 'lint') || {}
  r11.push(await w8run('11Z11. 只有 pages-dist/、workflow-examples/ 下的错误（agent 标为来源未确认）→ 代码按批准的排除逐条记录，lint 通过，W8 DONE', {
    findings: [lf('pages-dist/assets/a.js:1:1', '来源未确认'), lf('workflow-examples/x.js:2:3', '来源未确认')],
    expect: (r, p) => [r.nextNode !== 'DONE' && `应为 DONE，实际 ${r.nextNode}：${r.reason}`, lintOf(r).status !== '通过' && 'lint 不应失败',
      !(r.data && r.data.lint && r.data.lint.exclusions.every((x) => x.findings.length === 1)) && '排除没有逐路径记录',
      !has9(p['w8-report'], '排除、未运行') && '报告提示没有要求 npm test 写"排除、未运行"'] }))
  r11.push(await w8run('11Z12. app/ 下新增错误、agent 却把 lint 写成通过 → 代码改判失败，W8 不能 DONE', {
    findings: [lf('app/page.tsx:3:1', '新增错误'), lf('pages-dist/a.js:1:1', '已排除（用户确认）')],
    expect: (r) => [r.nextNode === 'DONE' && '有新增错误却 DONE', lintOf(r).status !== '失败' && 'lint 没有被改判为失败'] }))
  r11.push(await w8run('11Z13. agent 把排除范围外的错误标为"已排除" → 改回来源未确认，W8 暂停', {
    findings: [lf('db/index.ts:1:1', '已排除（用户确认）')],
    expect: (r) => [r.nextNode !== 'PAUSE' && `应暂停，实际 ${r.nextNode}`, !(r.data && r.data.lint && r.data.lint.open.includes('db/index.ts:1:1')) && '未改回来源未确认'] }))
  r11.push(await w8run('11Z14. 类型检查失败 → W8 不能 DONE（不放宽门槛）', {
    typeItem: { status: '失败', failureType: '来源未确认', note: 'tsc 退出码 2' },
    expect: (r) => [r.nextNode === 'DONE' && '类型检查失败却 DONE'] }))

  // 11Z25–11Z30：W8 规格事项按用户决定逐条处置（options.specIssueDispositions）
  const DEC = [{ id: 'D-spec-notes', text: '模拟：SI-X 只是过时行号，写进交付报告文档限制' }]
  const DISP = [{ id: 'SI-X', decisionId: 'D-spec-notes', anchors: [`${D11}/design.md:14`], issue: 'design.md:14 行号过时', handling: '交付报告文档限制中注明' }]
  const si = (id, basis, dispositionId) => ({ id, basis, request: 'r', dispositionId })
  const w8spec = (name, { specIssues, disp = DISP, decisions = DEC, codeState, recorded = [], typeItem = {}, expect }) => w8(name, { resume: w7ok, decisions,
    options: { ports: { w8: 5998 }, npmTest: { mode: 'exclude', reason: 'D-npm-test-exclude 模拟' }, typecheck: { command: 'node_modules/.bin/tsc --noEmit' }, specIssueDispositions: disp },
    agentHook: (l) => (l === 'w8-inventory' ? { ...inv, specIssues, recordedCodeState: recorded, ...(codeState ? { codeStateRaw: JSON.stringify({ files: codeState, missing: [], error: '无' }) } : {}) }
      : l === 'w8-checks' ? { items: [ci('lint'), ci('类型检查', typeItem), ci('测试', { status: '未执行', note: '排除' }), ci('构建')], lintFindings: [], guardedRuns: [] }
        : l === 'w8-report' ? { action: '新建', branchIssues: [], verified: [], unverified: [], externalNotExecuted: ['commit'], diffRaw: diffW8 } : undefined),
    expect: (o, c, p) => { const r = (o.results || []).find((h) => h.node === 'W8') || {}; return expect(r, p, o, c) } })
  r11.push(await w8spec('11Z25. 事项绑定处置（dispositionId + basis 引用 anchors）→ 不返回 W2，继续全量检查；报告提示要求列出文档限制', {
    specIssues: [si('SI-X', 'specs/x/design.md:14 第 200–213 行已过时', 'SI-X')],
    expect: (r, p, o, c) => [r.nextNode === 'W2' && `不应返回 W2：${r.reason}`, !c.includes('w8-checks') && '没有进入全量检查',
      !has9(p['w8-report'], '文档限制') && '报告提示没有要求列出文档限制', !(r.data && r.data.specDisposed && r.data.specDisposed.length === 1) && 'data.specDisposed 缺失'] }))
  r11.push(await w8spec('11Z26. 写了 dispositionId 但 basis 没有引用 anchors → 仍返回 W2', {
    specIssues: [si('SI-X', 'requirements.md:40 验收标准缺失', 'SI-X')],
    expect: (r, p, o, c) => [r.nextNode !== 'W2' && `应返回 W2，实际 ${r.nextNode}`, c.includes('w8-checks') && '不应进入全量检查'] }))
  r11.push(await w8spec('11Z27. 一条已处置 + 一条新需求冲突 → 返回 W2，修订依据只含未处置事项', {
    specIssues: [si('SI-X', 'design.md:14 行号过时', 'SI-X'), si('NEW-1', 'requirements.md:41 与 app/page.tsx 实际行为矛盾', '无')],
    expect: (r) => { const items = (r.data && r.data.revision && r.data.revision.items) || []
      return [r.nextNode !== 'W2' && `应返回 W2，实际 ${r.nextNode}`, !(items.length === 1 && items[0].id === 'NEW-1') && `修订依据应只有 NEW-1，实际 ${items.map((x) => x.id)}`,
        items.some((x) => 'dispositionId' in x) && '修订依据不应带 dispositionId'] } }))
  r11.push(await w8spec('11Z28. 处置引用了不存在的决定 → 参数校验拒绝', {
    specIssues: [], disp: [{ ...DISP[0], decisionId: 'D-none' }],
    expect: (r, p, o, c) => [o.stoppedAt !== 'context' && `应在参数校验拒绝，实际 ${o.stoppedAt}`, !has9(o.reason, 'specIssueDispositions') && '原因缺失', c.length && '不应调用 agent'] }))
  r11.push(await w8spec('11Z29. 事项已处置，但测试报告记录的规格哈希已变 → 证据过期规则不变，仍路由 W6 重新验证', {
    specIssues: [si('SI-X', 'design.md:14 行号过时', 'SI-X')],
    recorded: [{ report: W7R, files: [{ path: `${D11}/design.md`, sha256: 'a'.repeat(64) }] }], codeState: [{ path: `${D11}/design.md`, sha256: 'b'.repeat(64) }],
    expect: (r) => [r.nextNode !== 'W6' && `应路由 W6，实际 ${r.nextNode}：${r.reason}`, !(r.data && r.data.reverify && r.data.reverify.length === 1) && '没有列出需重新验证的报告'] }))
  r11.push(await w8spec('11Z30. 事项已处置，类型检查失败 → 仍不能 DONE（门槛不变）', {
    specIssues: [si('SI-X', 'design.md:14 行号过时', 'SI-X')], typeItem: { status: '失败', failureType: '既有问题（已经 Git 基线确认）', note: 'tsc 退出码 2' },
    expect: (r) => [r.nextNode === 'DONE' && '类型检查失败却 DONE', r.nextNode === 'W2' && '不应返回 W2'] }))

  // 11Z15–11Z24：recordMode 'deferred'——结果原文由脚本放进返回值，运行后由 record-from-output 从工作流输出文件保存（不经 agent 转写）
  const w3done = rec11('W3', env11('W3', 'FEATURE_TASKS_COMPLETE', { plan: {} }), [B11, T11, `${D11}/requirements.md`, `${D11}/design.md`])
  const w3pause = rec11('W3', env11('W3', 'PAUSE', { plan: {} }), [B11, T11, `${D11}/requirements.md`, `${D11}/design.md`])
  r11.push(await w8('11Z15. W3 → FEATURE_TASKS_COMPLETE 的记录 → 续接进入 W8（与 runW8 的合法上游一致）', { resume: w3done,
    expect: (o, c) => [!c.includes('w8-inventory') && `没有进入 W8（${o.reason}）`, o.route && o.route[0] !== 'W3(续接)' && `路由应以 W3(续接) 开头，实际 ${o.route}`] }))
  r11.push(await w8('11Z16. W3 → PAUSE 的记录 → 阻塞', { resume: w3pause, expect: (o, c) => [...rejected(o, c, '不是 W7 → W8 或 W3 → FEATURE_TASKS_COMPLETE'), c.includes('w8-inventory') && '阻塞后仍进入 W8'] }))
  r11.push(await w8('11Z17. recordMode deferred 但 maxNodeRuns 不为 1 → 参数校验拒绝', { resume: w7ok, options: { ports: { w8: 5998 }, recordMode: 'deferred', limits: { maxNodeRuns: 2 } },
    expect: (o, c) => [o.stoppedAt !== 'context' && `应在参数校验拒绝，实际 ${o.stoppedAt}`, !has9(o.reason, 'deferred') && '原因缺失', c.length && '不应调用 agent'] }))
  let deferredOut = null
  r11.push(await w8('11Z18. recordMode deferred → 不调用保存 agent，结果原文与 sha256 放进 pendingRecords', { resume: w7ok, options: { ports: { w8: 5998 }, recordMode: 'deferred' },
    expect: (o, c) => { deferredOut = o; const pr = (o.pendingRecords || [])[0]
      return [c.some((l) => /-record$/.test(l)) && '仍调用了保存 agent', !pr && '没有 pendingRecords',
        pr && sha256(pr.envelopeJson) !== pr.envelopeSha256 && 'pendingRecords 原文与哈希不符', pr && pr.node !== 'W8' && `节点应为 W8，实际 ${pr && pr.node}`,
        o.stoppedAt === '结果保存' && '不应在结果保存处失败'] } }))
  // record-from-output 工具：用真实工具保存；输出文件按 harness 的格式 { result }
  const outFile = (name, result) => { const f = join(base11, 'outputs', `${name}.json`); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify({ summary: 's', result })); return f }
  const save = (f, root, id) => JSON.parse(sh11(`${TOOL_CMD} record-from-output '${f}' '${root}' '${id}'`))
  const toolCase = (name, fn) => { const problems = fn().filter(Boolean); r11.push({ name, verdict: !problems.length, problems, stoppedAt: '-', calls: '工具', reason: '-' }) }
  // 大结果：约 300KB、含多字节字符
  const bigEnv = env11('W8', 'PAUSE', { padding: 'y'.repeat(100000) + '交付核对结果'.repeat(12000) })
  const bigJson = JSON.stringify(bigEnv)
  const mkPending = (o = {}) => ({ node: 'W8', iteration: 1, envelopeSha256: sha256(bigJson), envelopeJson: bigJson, paths: [T11], ...o })
  const runCtx = (root, id) => ({ context: { run: { root, id } } })
  toolCase('11Z19. 大结果（约 300KB，含多字节字符）→ 从输出文件正常保存，记录可通过 resultcheck 复核', () => {
    const root = join(base11, 'runs', 'deferred-big'); const f = outFile('big', { ...runCtx(root, 'dbig'), pendingRecords: [mkPending()] })
    const r = save(f, root, 'dbig'); const rc = r.records[0] && JSON.parse(sh11(`${TOOL_CMD} resultcheck '${r.records[0].resultPath}' '${r.records[0].resultSha256}'`))
    return [r.error !== '无' && `保存失败：${r.error}`, !(rc && rc.shaMatches && rc.envelopeIntact && rc.envelopeJson === bigJson) && '保存后的记录与原文不一致'] })
  toolCase('11Z20. 结果原文被篡改（与 envelopeSha256 不符）→ 拒绝，一条都不保存', () => {
    const root = join(base11, 'runs', 'deferred-tamper'); const f = outFile('tamper', { ...runCtx(root, 'dt'), pendingRecords: [mkPending({ envelopeJson: bigJson.replace('交付', '篡改') })] })
    const r = save(f, root, 'dt'); return [r.error === '无' && '篡改内容被保存', !has9(r.error, '不一致') && `原因不对：${r.error}`, existsSync(join(root, 'results')) && '仍写入了 results'] })
  toolCase('11Z21. 哈希不符（给出的 envelopeSha256 错误）→ 拒绝', () => {
    const root = join(base11, 'runs', 'deferred-sha'); const f = outFile('sha', { ...runCtx(root, 'ds'), pendingRecords: [mkPending({ envelopeSha256: 'a'.repeat(64) })] })
    const r = save(f, root, 'ds'); return [r.error === '无' && '哈希不符仍被保存'] })
  toolCase('11Z22. 来源错误（输出属于另一次运行 / node 与原文不符）→ 拒绝', () => {
    const root = join(base11, 'runs', 'deferred-src'); const f = outFile('src', { ...runCtx(join(base11, 'runs', 'other'), 'other'), pendingRecords: [mkPending()] })
    const f2 = outFile('src2', { ...runCtx(root, 'dsrc'), pendingRecords: [mkPending({ node: 'W7' })] })
    const a = save(f, root, 'dsrc'); const b = save(f2, root, 'dsrc')
    return [!has9(a.error, '来源不符') && `另一次运行的输出未被拒绝：${a.error}`, !has9(b.error, '不一致') && `node 不符未被拒绝：${b.error}`] })
  toolCase('11Z23. 写入失败（记录已存在不覆盖 / run.root 在仓库内 / 输出文件缺失）→ 拒绝', () => {
    const root = join(base11, 'runs', 'deferred-exist'); const f = outFile('exist', { ...runCtx(root, 'de'), pendingRecords: [mkPending()] })
    const first = save(f, root, 'de'); const second = save(f, root, 'de')
    const inRepo = join(repo11, 'runs-in-repo'); const f3 = outFile('inrepo', { ...runCtx(inRepo, 'dr'), pendingRecords: [mkPending()] })
    const third = save(f3, inRepo, 'dr'); const missing = save(join(base11, 'outputs', 'none.json'), root, 'de')
    return [first.error !== '无' && `首次保存失败：${first.error}`, !has9(second.error, '已存在') && `已存在的记录被覆盖：${second.error}`,
      third.error === '无' && '仓库内 run.root 被接受', !has9(missing.error, '无法读取') && `缺失的输出文件未被拒绝：${missing.error}`] })
  toolCase('11Z24. 端到端：deferred 运行的真实输出 → record-from-output 保存成功', () => {
    if (!deferredOut) return ['11Z18 没有产出']
    const root = deferredOut.context.run.root, id = deferredOut.context.run.id
    const r = save(outFile('e2e', deferredOut), root, id)
    return [r.error !== '无' && `保存失败：${r.error}`, !(r.records[0] && existsSync(r.records[0].resultPath)) && '记录文件不存在'] })
  for (const [k, v] of Object.entries(keepW8)) put11(k, v)
}
console.log('\n======== 第十一部分：W7 续接中 W5 已接受意见直接返工的衔接 ========')
for (const r of r11) console.log(`\n${r.verdict ? 'PASS' : 'FAIL'} ${r.name}\n  stoppedAt : ${r.stoppedAt}\n  agent 桩  : ${r.calls}${r.problems.length ? `\n  问题      : ${r.problems.join('；')}` : ''}\n  reason    : ${String(r.reason).slice(0, 240)}`)
const failed11 = r11.filter((r) => !r.verdict).length
console.log(`\n第十一部分：${r11.length - failed11}/${r11.length} 通过；临时目录 ${base11}`)
if (failed11) process.exitCode = 1
}
