# /bowen:feature 工作流接口约定（W1～W8）

本文件约定 W1～W8 工作流节点之间的统一接口。现在 W1～W8 都已经按本约定整合进总调度 `workflow-examples/bowen-feature.js`。如果本文件与脚本代码不一致，以脚本代码为准。运行方法见 `workflow-examples/README.md`。

适用范围：`workflow-examples/bowen-feature.js`。节点规则仍以 `yd-ai-nodes/w*.md` 为准；本约定与节点文件冲突时，在脚本中注明差异，并以用户明确的决定为准。

---

## 1. 输入上下文与返回格式

### 1.1 输入上下文 `ctx`

总调度把 Workflow 的 `args` 整理成 `ctx`，以 `runWn(ctx, upstream)` 的形式传给每个节点函数。单独运行某个节点脚本时，`args` 直接就是 `ctx`。

```js
ctx = {
  feature: {
    dir: 'specs/todo-status-filter',   // 必填，功能规格目录
    title: '按完成状态筛选',            // 必填，INDEX 中的名称
    request: '…',                       // W1/W2 新建时必填：用户需求原文
  },
  run: {
    id: 'r20261109-a1b2',               // 必填，由调用方生成并保证唯一（脚本内不能用 Date/random）
    root: '<仓库外绝对路径>/bowen-runs/<run.id>',  // 必填，本次运行的产物根目录，调用方创建
    iteration: 1,                        // 调度器维护：同一节点在本次运行中的第几次执行
  },
  decisions: [                           // 用户已做的决定，原文传递，节点不得改写
    { id: 'D-next-env', text: '…' },
    { id: 'D-lint-no-stash', text: '…' },
  ],
  options: {
    ports: { w6: 5179, w8: 5180 },     // 由调用方提供，模板不设默认值；W6/W8 需要时缺失则 PAUSE
    npmTest: null,                       // null=待确认 | { mode: 'run' } | { mode: 'exclude', reason }
    typecheck: null,                     // null=未确认 | { command, confirmedBy: '用户', note }
    buildRestore: { files: [], decisionId: null },  // 允许在检查命令改写后恢复的文件，必须由用户决定明确列出；默认不恢复任何文件
    deliveryExclusions: [],              // [{ path, reason }]：W8 分支检查中已知不属于本功能交付的路径，只记录不阻断（敏感信息除外）
    codex: {
      allowed: false,                    // 是否允许把源码和规格发给 Codex（外部服务）。通用模板默认 false，不替任何项目授权
      reuse: null,                       // 见 2.3；仅在指纹一致时可用
      authorizationNote: null,           // 项目已有授权时，由调用方传 allowed: true 并写明授权来源
    },
    limits: { maxNodeRuns: 20, maxBatches: 5, maxReworkPerBatch: 2, maxSpecRevisions: 2 },
  },
}
```

`upstream` 是上一节点（或回路来源节点）的返回值，只作为待核实的背景数据；节点必须以磁盘上的文件为准。

Codex 授权：本项目（TodoList）沿用用户此前对 Codex 审查的授权，由调用参数显式传入 `codex: { allowed: true, authorizationNote: '沿用用户此前对本项目 Codex 审查的授权' }`；其他项目使用模板时默认不授权，W5 需要调用 Codex 时按"缺少权限"暂停。

### 1.2 统一返回格式

每个节点函数和单节点脚本都返回同一外层结构，节点特有的数据放进 `data`：

```js
{
  node: 'W6',
  iteration: 1,
  nextNode: 'W7',              // 见第 5 节路由表的允许值
  reason: '…',                 // 统一字段名（取代 pauseReason / routeReason）
  stoppedAt: 'W6·Browser',     // 实际停止的阶段；正常结束时为最后一个阶段
  batchId: 'batch-02',         // 与批次无关的节点（W1、W2、W8）可为 null
  writes: [                    // 本次实际写入的文件
    { path, action: '新建' | '修改' | '追加' | '已存在且内容相同未改动' | '已存在且内容不同未覆盖' },
  ],
  artifacts: [ { kind: 'snapshot' | 'codex-output' | 'evidence', path, sha256 } ],
  decisionsNeeded: [ { id, question, options } ],   // PAUSE 时必须说明要用户决定什么；否则为空数组
  data: { … },                 // 节点特有结果（例如 W6 的 scenarios、W7 的 decisions）
}
```

规则：

- 任何 `agent()` 返回 `null`：该节点返回 `nextNode: 'PAUSE'`，`reason` 写明哪个阶段没有结果、哪些文件可能已被部分写入。
- `writes` 必须与快照对比得出（见 2.2），不能只依据 agent 自报。
- 不允许用 `suggestedNextNode` 之类的旁路字段表达路由；路由只看 `nextNode`。

---

## 2. 快照、审查原始输出与报告

### 2.1 目录布局

```
<run.root>/                                  # 仓库外，调用方创建
  <Wn>-<iteration>/
    snapshot/
      files/                                 # 节点开始前的文件副本（保持仓库相对路径）
      manifest.sha256                        # 全部已跟踪 + 未跟踪文件的哈希
    draft-current-batch.md                   # 仅 W3：任务包草稿
    codex/                                   # 仅 W5
      output.txt  output.sha256  meta.json

<repo>/specs/<feature>/
  requirements.md  design.md  tasks.md       # 规格（W2 维护）
  current-batch.md                           # 当前任务包（W3 维护）
  reports/
    RUNS.md                                  # 追加式运行登记表（见 2.4）
    _runs/<run.id>/                          # 运行级记录：尚无批次时使用（例如 W2 新建规格）
      W2-spec-<iter>.md  W2-revision-<iter>.md
    <batchId>/
      batch-<run.id>.md                      # W3 覆盖 current-batch.md 前的存档
      W2-revision-<run.id>-<iter>.md
      W4-development-<run.id>-<iter>.md
      W5-code-review-<run.id>-<iter>.md
      W6-test-<run.id>-<iter>.md
      W7-completion-<run.id>-<iter>.md
    delivery/
      W8-delivery-<run.id>-<iter>.md

<repo>/.playwright-mcp/<run.id>/<Wn>-<iteration>/   # 浏览器证据（AGENTS.md 要求留在仓库内，已被 .gitignore 忽略）
```

- 报告按"批次 + 运行 + 次数"命名，新报告总是新文件，不覆盖旧报告。
- 旧报告（功能目录根下的 `development-report.md`、`code-review-report.md` 等）视为历史记录，只读，不移动、不修改；在 `RUNS.md` 中登记为 `legacy`。
- `batchId` 由 W3 分配：`batch-NN`，NN 为 `RUNS.md` 中已登记的最大批次号 + 1（两位数字），不按目录数计算。
- `RUNS.md` 不存在时，由第一个需要写报告的节点创建，并先登记旧批次：`batch-01`（T1、T2，legacy）、`batch-02`（T7、T1、T2，legacy，进行中）。之后 `batch-02` 的新报告写入 `reports/batch-02/`。

### 2.2 快照规则

- 会写文件的节点（W2、W3、W4、W6、W7、W8）开始时，由该节点第一个阶段的 agent 原样执行
  `python3 -I workflow-examples/tools/wf_snapshot.py take <快照目录> [探测路径…]`，建立 `<run.root>/<Wn>-<iteration>/snapshot/`；
  结束时由写入步骤的 agent 执行 `wf_snapshot.py diff <快照目录> [--checkbox|--prefix|--same|--lines 路径…]`。
  两条命令的输出（一行 JSON）原样放进 schema 的 `snapshotRaw` / `diffRaw`，由脚本代码解析和判断。
- 复制、哈希、范围比较、勾选状态比较、只追加检查都由工具和脚本代码完成，不为这些机械操作单独新增 agent。
- 每个节点用自己的快照，不跨节点共用（上一节点的写入会改变下一节点的基线）。
- 本节点产生的变化 = 快照 → 结束时的哈希对比；不以 `git status` / `git diff`（相对 HEAD）判断，因为运行前可能已有未提交修改。
- 节点结束时，在 `writes` 中列出所有变化的文件；出现允许范围外的变化时，`nextNode` 为 PAUSE。
- 快照只用于对比和人工恢复，脚本不得自动用快照还原文件。唯一例外是检查命令的构建恢复规则（2.5）。

### 2.5 构建恢复规则

构建、lint、测试等检查命令一律通过 `wf_snapshot.py guarded-run <快照目录> <日志> [--allow 文件]… [--output-dir 目录]… -- <命令>` 执行。
工具在命令执行前后各计算一次全部文件哈希，并按以下规则处理执行期间发生变化的文件：

| 条件 | 处理 |
| --- | --- |
| 位于命令声明的输出目录（未被 .gitignore 忽略的构建产物目录） | 记为产物，不恢复 |
| 不在 `options.buildRestore.files` 中 | 不恢复，记入 `notRestored`，节点 PAUSE |
| 执行前的内容已与快照不同（可能有其他并发或先前修改） | 不恢复，记入 `notRestored`，节点 PAUSE |
| 快照中没有该文件，或执行后被删除 | 不恢复，记入 `notRestored`，节点 PAUSE |
| 在允许列表中、执行前与快照一致、执行期间发生变化 | 用快照副本恢复运行前内容，并核对恢复后的哈希与快照一致 |

- `options.buildRestore.files` 必须对应一项用户决定（`decisionId`），例如本项目的 `D-next-env` 对应 `next-env.d.ts`；模板默认不允许恢复任何文件。
- 不按"已跟踪文件"一概恢复，不用 `git checkout`，agent 不得自行编辑或还原这些文件。
- 命令输出写在仓库外的日志文件中，节点只回传 `guarded-run` 的一行摘要。

### 2.3 审查原始输出（W5）

- 审查范围和输入指纹由 `wf_snapshot.py fingerprint <run.root>/W5-<iter>/codex/scope.json <路径…>` 计算并保存。
- Codex 完整输出写到 `<run.root>/W5-<iter>/codex/output.txt`（同目录还有 `instructions.md`、`command.txt`、`exit_code.txt`），
  执行结束后由 `wf_snapshot.py seal <codex 目录> <codex 路径>` 写 `output.sha256` 和 `meta.json`：
  `{ codexPath, version, command, exitCode, sessionId, status, reviewedFiles: [{path, sha256}], codeFingerprint, head, outputPath, outputSha256, outputLines }`。
- `codeFingerprint` = 审查范围内各文件"哈希  路径"清单（按路径排序）的哈希。
- 复用前由 `wf_snapshot.py reusecheck <输出> <期望哈希> <meta.json> <当前指纹>` 核对；输出哈希、meta 中的输出哈希、审查输入指纹都一致，
  且原执行退出码为 0、状态为"已完成"时才可复用。不满足时：已授权则重新调用 Codex，未授权则 PAUSE。
  不带 `meta.json` 的旧输出（本约定之前保存的）无法核对指纹，不能复用。
- 复用：`ctx.options.codex.reuse = { outputPath, sha256, metaPath }`。只有输出文件的哈希与 `sha256` 一致、且 `meta.codeFingerprint` 与当前审查范围的指纹一致时才可复用；否则视为过期，不复用，按完整运行处理（需要 `codex.allowed`）。
- 原始输出不放进 schema 结果，只传路径和哈希；Claude 的判断写进 `W5-code-review-*.md`，与原始输出分开。

### 2.4 报告的传递

- 节点之间不传报告正文，只传路径。下游节点从 `reports/RUNS.md` 和 `upstream.writes` 找到"本批次最新的有效报告"。
- `RUNS.md` 只追加，每行一条：`| run.id | 节点 | 次数 | batchId | 报告路径 | nextNode | 被取代 |`。
  同一批次同一节点有多份报告时，以最后一行未标"被取代"的为准；节点不得删除或改写已有行，只能追加新行。
- 报告必须记录它对应的代码状态：HEAD、本批相关文件的哈希。W7、W8 用它判断报告是否"对应当前代码"。

### 2.6 结果保存、W4 复核与续接

**保存。** 每个节点返回后，调度器把它的实际结果（信封 JSON）连同相关文件指纹，保存到 `<run.root>/results/<节点>-<次数>.json`（`wf_snapshot.py record`）。

- 结果 JSON 的 sha256 由调度器计算，工具核对一致才写入；记录文件已存在时拒绝覆盖。
- 指纹覆盖：`current-batch.md`、`tasks.md`、`requirements.md`、`design.md`、报告、本节点写入的文件、运行前已有修改的文件、任务允许修改的文件。
- `RUNS.md`（每次运行都会追加）、目录和通配路径不记录指纹。
- 保存失败时，本次运行暂停。没有保存的结果不能续接。
- 本机制之前的运行没有保存结果，不补造它们的记录。

**W4 复核（`startNode: 'W4R'`，参数 `review`）。** 只读，不重跑任务，只处理"任务执行中因无人负责的问题而暂停"的 W4。步骤：

1. 用 `importorigin` 从原运行记录中，原样导入原 W4 结果（保留原 nextNode PAUSE），写成 `imported-W4-<原 run.id>-<次数>.json`。导入记录不能续接。
2. 代码核对以下各项：
   - 原结果确实是 PAUSE（W4·Task）；没有未执行的任务；没有未处理的转交问题；导致暂停的问题都是"其他"类。越界或安全、规格、依赖类问题不能靠补充更正处理。
   - 与原 W4 快照相比，只新增了原报告、追加了 `RUNS.md`；任务包、规格、勾选状态和 HEAD 都没有变化。`deliveryExclusions` 中的目录不参与判断，但逐条列出。
   - 报告开头的字节与原报告的哈希一致，只在末尾追加了指定标题的补充更正（`prefixcheck`）。
   - `current-batch.md` 的哈希与登记值一致。
3. 由 agent 做内容复核：每个任务的证据仍在，且与原结果一致；每个阻断问题都被补充更正覆盖；补充没有越界；补充如实写明原结果为 PAUSE；没有新问题。
4. 以上全部通过，才产生一份新的 W4 结果（`stoppedAt: 'W4·Review'`，`data.review` 记录原结果、原报告、用户决定和核对证据），作为 W5 的上游；否则暂停，不产生 W4 结果。原 `RUNS.md` 行和原报告都不改动。

**续接（`startNode: 'W5'`，参数 `resume: { resultPath, resultSha256 }`）。** `resultcheck` 核对以下各项，全部满足才把记录中的结果作为 W5 的上游。route 中显示为 `W4(续接)`，不计入 `maxNodeRuns`。

- 记录文件的哈希与调用方给出的一致；记录中的结果与其哈希一致。
- 记录的是 W4 的结果，且 nextNode 为 W5。PAUSE 和其他结论一律拒绝。
- 任务包、`tasks.md`、报告、运行前已有修改的文件都有指纹，且与记录时相同；HEAD 不变。

任何一项不满足都拒绝复用，并在 reason 中列出变化。

---

## 3. W2 规格与 W3 任务包

### 3.1 W2：新建 / 修订规格

| 模式 | 触发条件 | 需要的输入 |
| --- | --- | --- |
| 新建 | `requirements.md`、`design.md`、`tasks.md` 都不存在 | `ctx.feature.request`、W1 的实际结果 |
| 修订 | 规格已存在，且上游返回 W2，或用户提出修订 | `revision = { source, items: [{ id, basis: '文件:行号或证据路径', request }] }`，来源见下 |

修订依据的来源（按优先级）：用户传入的 `ctx.revision`；W1 的 `data.specGaps`；W3 的 `data.revision`（来自 `specIssues`）；W4、W5、W6、W8 的 `data.revision`。每一条都必须带可核实的 `basis`。

两种模式都要留下运行结果：

- 新建：写运行级记录 `reports/_runs/<run.id>/W2-spec-<iter>.md`，并在 `RUNS.md` 追加一行（batchId 为 `-`）。
- 修订：有当前批次时写 `reports/<batchId>/W2-revision-<run.id>-<iter>.md`，尚无批次时写 `reports/_runs/<run.id>/W2-revision-<iter>.md`；同样在 `RUNS.md` 追加一行。

规则：

- 修订必须有明确依据（用户原文，或审查意见编号 / 测试场景编号加证据路径）；没有依据的改动不做，`decisionsNeeded` 说明缺什么，返回 PAUSE。
- 只用精确替换修改已有文件，不整体重写；只改依据涉及的段落。
- 不删除、不重新编号已有任务；新任务使用下一个未用的编号；不勾选或取消勾选任何任务。
- 不修改审查报告、测试报告等历史报告；修订说明写进 `reports/<batchId>/W2-revision-*.md`（列出每条依据和对应改动）。
- 文件存在、但与快照相比有本节点之外的变化（例如用户刚改过）时，先读取再改，保留这些变化；同一段落有冲突时返回 PAUSE。
- 新建模式下目标文件已存在且内容不同：不覆盖，返回 PAUSE。

### 3.2 W3：创建 / 更新任务包

| 情况 | 处理 |
| --- | --- |
| `current-batch.md` 不存在 | 新建，分配新的 `batchId` |
| 当前批次已由 W7 结束（`RUNS.md` 中该批次有 W7 记录且 nextNode 为 W3） | 存档旧文件到 `reports/<旧batchId>/batch-<run.id>.md`，再写新批次 |
| W2 修订改动了当前批次任务的内容或依赖（`upstream` 为 W2，且修订涉及本批任务） | 存档后更新，沿用原 `batchId`，在文件中注明更新依据 |
| 重新计算的批次与现有文件实质相同 | 复用，不改动 |
| 现有文件被手工修改过（哈希与 `RUNS.md` 中 W3 最后登记的不一致），或以上条件都不满足但内容不同 | 不覆盖，返回 PAUSE，列出差异 |

- 选择任务只看 `tasks.md`：跳过 `[x]`，找出依赖已满足的未完成任务；串行或并行按 `w3-task.md` 的六条规则判断，无法确定时选串行。
- `tasks.md` 中已没有 `[ ]` 任务时返回 `FEATURE_TASKS_COMPLETE`，由调度器映射到 W8。
- 任务包必须写明运行前已有的变化（与 HEAD 不同、但不是本批将要产生的文件），以及每个任务是"修改"还是"核对已有修改"。
- 用户决定（`ctx.decisions`）原文写入"项目约束"。

---

## 4. W4：从任务包动态读取任务

- W4 不写死任务。第一个阶段 `W4·Plan` 建立快照并读取 `current-batch.md`，按 schema 返回：

```js
{ batchId, currentBatchSha256, lastRegisteredSha256, mode: '串行' | '并行', preexistingChanges: [{ path, note }],
  tasks: [{ id, name, kind: '修改' | '核对' | '报告更正', goal, dependencies, allowedFiles: [path], acceptance: [ac], verification, order, sourceLines }],
  problems: [{ kind: '规格问题' | '依赖或冲突' | '信息不足', basis, text }] }
```

- 脚本代码先校验：批次编号可确定；`current-batch.md` 的哈希与 W3 最后登记（或 `legacyBatches.currentBatchSha256`）一致；
  任务编号不重复；依赖顺序正确；核对 / 报告更正任务没有可修改文件；修改任务写明了允许范围，且不包含规格、任务包、`reports/`、INDEX、AGENTS.md、节点文件、工作流示例等受保护路径。
  任务包把功能目录根下的历史报告列为可修改时，代码把它从 `allowedFiles` 移除，改为在本批新报告中写更正记录。
- 问题路由：规格问题 → W2（带 `data.revision`）；依赖或冲突 → W3；信息不足 → PAUSE。任务包没写清类型或允许范围时不自行补全。
- 执行（`W4·Task`，label `w4-<taskId>`）：按 `order` 串行；只有任务包写明"并行"且各任务 `allowedFiles` 不相交时才并发（同一工作区，不用 worktree，因为规格等未跟踪文件不在 worktree 中）。
- 每个任务先核对现状：要求的结果已存在且一致 → "已存在且一致，未重复修改"；部分存在或不一致 → "发现不一致"，PAUSE，不修复。
- 每个任务结束时执行快照对比；代码按文件哈希找出本任务新改动的文件，必须都在该任务的 `allowedFiles` 内，否则停止后续任务并 PAUSE。
- 任务的 `issues` 中"本批变化导致的过时表述"不阻塞，转为更正记录；规格问题 → W2；依赖或冲突 → W3；其他 → PAUSE。
- `W4·Report` 无论是否中途停止都新建 `reports/<batchId>/W4-development-<run.id>-<iter>.md`，如实列出已执行和未执行的任务、更正记录（引用原报告位置，原文件不改），并在 `RUNS.md` 追加一行；最后的快照对比由代码检查：写入范围、`tasks.md` 勾选状态未变、`RUNS.md` 只追加、规格和任务包未变、HEAD 未变。

### 4.1 W5：Codex 审查与 Claude 判断

- 前提：上游是成功的 W4（有 `batchId` 和 `data.reportPath`），否则 PAUSE。
- `W5·Scope`：建立快照；源码范围由代码从 W4 结果计算（任务允许修改的文件、任务包写明的运行前已有变化、W4 实际写入的非规格文件），
  agent 只能补充核对任务明确涉及的只读源码（带任务包依据），不得包含 `workflow-examples/`、其他功能目录和其他报告；
  规格范围为 requirements、design、tasks、current-batch；再加本批 W4 报告。计算指纹，检查敏感信息，按 2.3 做复用核对。
- `W5·Codex`：未复用时调用真实 Codex（`exec --sandbox read-only --ephemeral`），审查说明由实际范围生成，不写死功能路径；
  执行一次，不换参数重试；完整输出只留在 `run.root`，结果只回传 `seal` 的一行摘要。
- `W5·Judge`：读取原始输出逐条核实，写 `reports/<batchId>/W5-code-review-<run.id>-<iter>.md`（只引用原始输出的路径和哈希，必要时摘录单条原句），追加 `RUNS.md`。
- 路由：待确认 → PAUSE；已接受的规格意见 → W2（`data.revision`，source 'W5'）；已接受的代码或报告意见 → W4（`data.rework`）；其余 → W6。
- 节点之间只传 `data.codex = { outputPath, outputSha256, metaPath, reused, fingerprint, status }`、报告路径和计数，不传日志正文；
  审查输入清单 `scope.json` 以 `artifacts` 中 `kind: 'review-input'` 的条目传给 W6。

### 4.2 W6：自动化测试

- 前提：上游是 nextNode 为 W6 的 W5，带审查报告路径、`data.codex` 和审查输入清单；`options.ports.w6` 已提供。否则 PAUSE。
- `W6·Preflight`：建立快照；用 `wf_snapshot.py refingerprint <scope.json> <输出>` 按审查清单重算指纹，必须与审查时一致；
  用 `reusecheck` 确认 Codex 原始输出和 meta 未被改动、原执行成功；审查报告必须存在。任一不满足 → PAUSE（需要重新经过 W5），不能只凭旧报告存在放行。
  验收项目从任务包中本批任务引用的验收标准读取，再到 requirements.md 取原文和行号，按原文分为浏览器 / 命令 / 复现；无法转换成可执行操作 → W2。
  命令只从 package.json scripts 和 AGENTS.md 读取，并注明会被命令改写的已跟踪文件、写入的未忽略目录。
- `W6·Browser`：只在有浏览器或复现项目时执行；用项目配置的启动命令和 `options.ports.w6`，Playwright MCP 新建独立上下文，不清空任何已有浏览器数据；
  证据写 `.playwright-mcp/<run.id>/W6-<iter>/`；结束时只停止自己启动的进程。
- `W6·Checks`：只运行配置中的命令，且一律经 `guarded-run` 执行，按 2.5 处理被改写的文件；有 `notRestored` 时 PAUSE；
  lint 错误只有经实际基线检查才算既有问题，否则"来源未确认"；项目测试命令按 `options.npmTest` 处理，null 时记为"未执行（待确认）"。
- 必需项目 = 本批每条验收标准 + 项目测试命令（除非用户排除）；没有执行记录的按"未执行"补齐。
- `W6·Report`：写 `reports/<batchId>/W6-test-<run.id>-<iter>.md`，追加 `RUNS.md`；快照对比只允许报告、RUNS.md 和命令写入的未忽略目录。
- 路由（本版不修复）：服务未停止或环境阻塞 → PAUSE；规格问题 → W2（`data.revision`）；代码问题 → W4（`data.rework`）；
  来源未确认、项目测试命令未通过且未排除、其他未执行或未通过、复现类项目已复现 → PAUSE；全部通过 → W7。

### 4.3 W7：按证据标记任务

- 前提：上游是 nextNode 为 W7 的 W6；本次运行中同一批次有 nextNode 为 W5 的 W4 结果和 nextNode 为 W6 的 W5 结果（节点函数签名为 `runWn(upstream, iter, history)`，W7 从 `history` 取）。否则 PAUSE。
- `W7·Gate`：建立快照；`refingerprint` 确认审查和测试之后代码没有变化；`fingerprint` 确认本批开发、审查、测试报告和测试证据文件都存在；
  agent 逐任务引用 tasks.md 的完成标准原文和行号，判断是否要求静态部分、是否要求运行验收，并只依据报告原文给出静态结论。
- 代码判定：静态部分 = W4 该任务结果为"已修改 / 已存在且一致，未重复修改 / 核对完成"且报告结论为已完成并有证据；
  运行部分 = 该任务对应的每条验收标准在 W6 结果中都是"通过"、未复现问题、有证据。完成标准要求的部分都完成才可勾选；部分完成不勾选。
  只能勾选本批任务；其他批次的任务及其必需验收保持原状。
- 证据不足（代码已变、证据文件缺失、W4 结果缺失、测试结果缺项、完成标准没有依据等）：不勾选任何任务，PAUSE。
- `W7·Record`：只勾选判定可勾选的任务；INDEX 只改本功能行，仍有未完成任务时保持"进行中"；写 `reports/<batchId>/W7-completion-<run.id>-<iter>.md`
  （含建议提交的文件和 commit message，提交状态为"未执行"；候选经验只写在报告中，不写 AGENTS.md）；追加 `RUNS.md`。
  代码核对 tasks.md 的勾选变化必须与判定完全一致。不执行 commit、push。
- 路由：仍有 `[ ]` 任务 → W3；没有 → W8。

### 4.4 W8：最终交付核对

- 前提：上游是 nextNode 为 W8 的 W7，或 nextNode 为 FEATURE_TASKS_COMPLETE 的 W3；`options.ports.w8` 已提供。否则 PAUSE。
- `W8·Inventory`：建立快照；只把 `RUNS.md` 中未被取代的 W6 测试报告、W7 完成报告作为证据（根目录旧报告只作参考）。
  逐条读取 requirements.md 的**全部**验收标准及其最新有效测试结果；读取测试报告附录"代码状态"中的文件哈希，用 `fingerprint` 计算当前哈希，由代码比较：
  一致 → 对应；不一致 → 已过期；没有附录 → 无法判断。证据文件用 `fingerprint` 确认存在。每个 `[x]` 任务必须能在某份 W7 完成报告中找到依据，勾选框本身不算证据。
  有 `[ ]` 任务 → W3；规格问题 → W2；缺文档或环境阻塞 → PAUSE（这三种情况不跑检查、不写交付报告）。
- `W8·Checks`：lint、类型检查、测试、构建各一项，全部经 `guarded-run`（2.5）执行；类型检查只用项目配置或 `options.typecheck` 确认的命令，否则"项目未配置"；测试按 `options.npmTest`。
- `W8·Browser`：用 `options.ports.w8` 和项目启动命令，在独立上下文中复验全部浏览器 / 复现类验收标准；证据写 `.playwright-mcp/<run.id>/W8-<iter>/`。
- `W8·Report`：分支整体检查（敏感信息、调试代码、范围外修改、遗漏文件；`deliveryExclusions` 中的路径只记录，敏感信息不豁免）；
  新建 `reports/delivery/W8-delivery-<run.id>-<iter>.md`，分 verified / unverified / externalNotExecuted 三类；追加 `RUNS.md`（batchId 为 `-`）。
- 路由：报告未生成、分支问题、检查或复验无结果、服务未停止、`notRestored`、环境阻塞 → PAUSE；复验发现规格问题 → W2；
  代码问题或测试报告已过期 → W6；已勾选任务无 W7 依据、INDEX 未标完成、任一验收标准证据不足或无法判断、检查失败或来源未确认、
  类型检查未通过、测试未通过且未排除、其他检查或复验未通过 → PAUSE；全部满足 → DONE。不提交、不推送、不部署。

---

## 5. 路由、暂停与循环上限

### 5.1 路由表

| 节点 | 允许的 nextNode | 说明 |
| --- | --- | --- |
| W1 | W2、W3、PAUSE | 缺规格或验收标准不可验证 → W2 |
| W2 | W3、PAUSE | |
| W3 | W4、W2、FEATURE_TASKS_COMPLETE、PAUSE | FEATURE_TASKS_COMPLETE 由调度器映射到 W8 |
| W4 | W5、W3、W2、PAUSE | 依赖或冲突 → W3；规格不明 → W2 |
| W5 | W6、W4、W2、PAUSE | 已接受的代码意见 → W4（调度器先经 W3 规划返工）；规格意见 → W2 |
| W6 | W7、W4、W2、PAUSE | 代码问题不在 W6 修复，返回 W4（调度器先经 W3 规划返工）；审查已过期时调度器重新进入 W5 |
| W7 | W3、W8、PAUSE | 还有 `[ ]` 任务 → W3 选下一批；全部完成 → W8 |
| W8 | DONE、W3、W2、W6、PAUSE | 需要修复或重新验证 → W6；调度器按 5.4 决定实际走向（返工经 W3，复验用真实 W5 结果） |

调度器只按此表跳转；节点返回表外的值时，按 PAUSE 处理并记录。`DONE` 和 `PAUSE` 是终止值。

分阶段接入期间：总调度遇到尚未接入的节点时返回 `{ nextNode: <该节点>, notConnected: <该节点> }` 并停止；
当前版本：W1～W8 全部接入。正向路线自动推进（W1→W2/W3→W4→W5→W6→W7→W8，以及 W3 的 FEATURE_TASKS_COMPLETE→W8）；
W7→W3 的下一批任务循环已接通：调度器保存本批结果（`batches`），W7 本批没有勾选任何任务或 tasks.md 未变化时 PAUSE（无进展），
已处理批次数达到 `maxBatches` 时 PAUSE；W7 之后的 W3 必须创建新批次，且不得选中本次运行已完成的任务，否则 PAUSE。
返工回路已全部接通，规则见 5.4；所有回路受 5.3 上限约束。调度逻辑的模拟验证见 `workflow-examples/tests/dispatch-sim.mjs`（执行真实总调度代码，节点为模拟）。

### 5.4 返工回路

| 路线 | 调度器实际走向 | 必须携带 | 缺失时 |
| --- | --- | --- | --- |
| W5 / W6 / W8 → W2 | W2（修订模式）→ W3 按修订更新任务包 | `data.revision.items`，每条有 id、basis、request | PAUSE |
| W5 / W6 → W4 | **先到 W3**：返工模式把意见转成返工任务（R*，含来源、验收标准、修改范围），存档后追加到当前批次 → W4 只执行这些返工任务 | `data.rework`，每条有 id、basis、request | PAUSE |
| W8 → W3 | W3（上一批已结束 → 新批次） | — | — |
| W8 → W6（有 `data.rework`） | 同 W5/W6 → W4：经 W3 返工；已结束的批次重新打开 | `data.rework` | — |
| W8 → W6（只有 `data.reverify`） | 以本次运行中最近一次通过的**真实 W5 结果**为上游重新进入 W6 | 本次运行中有 nextNode 为 W6 的 W5 | PAUSE（需要先重新经过 W4、W5，不构造审查产物） |
| W6 发现审查已过期（`data.reviewStale`） | 以本次运行中该批次最近一次真实 W4 结果为上游重新进入 W5 | 本次运行中该批次有 nextNode 为 W5 的 W4 | PAUSE |

- 返工计数按批次累计：W5/W6 → W4、W8 代码问题、W8 复验、审查过期重审各计一次，超过 `maxReworkPerBatch` 时 PAUSE。
- W3 收到返工意见时必须返回 `action: '返工更新'` 和非空 `reworkTaskIds`；代码校验每个返工任务都有来源、对应意见、验收标准，修改类有修改范围且不含受保护路径。
- W4 在返工轮次只执行 `reworkTaskIds` 中的任务。W7 合并同一批次各轮 W4 的结果：tasks.md 中的任务按证据勾选，返工任务（只在任务包中）通过验证后记为 `reworkVerified`，不写进 tasks.md。
  同一批次再次结束时，只有带新的返工结果才算有进展，不重复计入批次数。

### 5.2 暂停条件

只在以下情况暂停，不为每个节点增加人工确认：

1. 缺少必要决定：例如 `options.npmTest` 为 null 且 W6/W8 需要判断能否通过；`options.typecheck` 未确认而 W8 要求类型检查；审查意见需要用户在方案之间选择。
2. 缺少权限：W5 需要调用 Codex 而 `options.codex.allowed` 为 false；任何 commit、push、PR、部署（本版一律不执行，只记录）。
3. 冲突：文件已存在且内容不同；写入超出允许范围；手工修改与本节点改动冲突；HEAD 在运行期间变化。
4. 环境阻塞：依赖未安装、端口被占用、浏览器工具不可用；记为环境阻塞，不记成代码失败。
5. 证据不足：报告缺失、过期或无法确认对应当前代码；lint 错误来源未经实际基线验证。
6. 发现敏感信息或范围外修改。
7. 任何 `agent()` 返回 null，或节点返回表外的 nextNode。
8. 达到循环上限（5.3）。

暂停时 `decisionsNeeded` 必须写出具体问题和可选项；用户补充决定后从 PAUSE 处重新调用调度器，传入更新后的 `ctx`。

### 5.3 循环上限（默认值，可通过 `ctx.options.limits` 调整）

| 限制 | 默认 | 超出后 |
| --- | --- | --- |
| 单次运行执行的节点总数 `maxNodeRuns` | 20 | PAUSE |
| 单次运行处理的批次数 `maxBatches`（W7 → W3 的次数） | 5 | PAUSE |
| 同一批次的返工次数 `maxReworkPerBatch`（W5/W6/W8 → W4 或 W6） | 2 | PAUSE |
| 单次运行的规格修订次数 `maxSpecRevisions`（任意节点 → W2） | 2 | PAUSE |
| 无进展检测：同一节点连续两次返回相同 nextNode，且快照指纹相同 | — | PAUSE |

---

## 6. 阶段与标签命名

- `meta.phases` 和 `phase()` 的标题统一用 `Wn·阶段名`，例如 `W2·Spec`、`W3·Plan`、`W4·Plan`、`W4·Task`、`W6·Browser`、`W8·Browser`、`W7·Report`、`W8·Report`；同名阶段靠前缀区分。快照和对比在各阶段内由工具完成，不单设 `Snapshot` / `Verify` 阶段。
- 总调度只有一个顶层 `meta`，`phases` 列出全部可能用到的 `Wn·阶段名`；单节点脚本保留自己的 `meta`，使用相同的阶段名，便于对照。
- `agent()` 的 `label` 用 `wn-<阶段或任务>`；同一节点重复执行时加次数：`w6#2-browser`、`w4#2-T7`。
- `opts.phase` 必须显式传入 `Wn·阶段名`，不依赖全局 `phase()` 状态。

---

## 7. 早期单节点脚本与本约定的对应（已完成整合，仅作历史记录）

下表左列是早期单节点脚本（`bowen-feature-w1.js`～`w8.js`、`w4-batch2.js`，没有随作业提交）的写法，右列是总调度 `bowen-feature.js` 现在采用的写法。这些改造已经完成，表格只用来对照历史。

| 早期写法 | 现行写法 |
| --- | --- |
| `args.snapshotDir`（W4-batch2、W6、W7、W8，内容各不相同） | `ctx.run.root` + 节点用 `tools/wf_snapshot.py` 自建 `<Wn>-<iter>/snapshot/` |
| `args.reuseCodexOutput` / `args.codexOutputPath`（W5） | `ctx.options.codex.{allowed, reuse}`，输出路径由 `run.root` 推出 |
| `args.npmTestExclusion`（W6）/ `args.npmTest`（W8） | `ctx.options.npmTest` |
| `args.typecheck`（W8） | `ctx.options.typecheck` |
| `args.port`（W6、W8） | `ctx.options.ports.w6` / `w8` |
| `pauseReason` / `routeReason` / `reason` | `reason` |
| `suggestedNextNode`（W4-batch2） | 取消，只用 `nextNode` |
| 固定报告文件名（功能目录根下） | `reports/<batchId>/<Wn>-<类型>-<run.id>-<iter>.md` |
| W4 写死任务（`bowen-feature-w4.js`、`w4-batch2`） | `W4·Plan` 从 `current-batch.md` 读取 |
| W2 只能新建 | 新建 / 修订两种模式 |
| W3 内容不同即 PAUSE | 按 3.2 表格判断创建、更新、复用或 PAUSE |
| 阶段名 `Checks`、`Browser`、`Report` 等重名 | `Wn·阶段名` |
