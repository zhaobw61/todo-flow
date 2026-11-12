# W8 交付报告（更正版）：按完成状态筛选（todo-status-filter）

- 对应运行：r20261112-w8r3（W8 第 1 次），HEAD `42b4b2c9109f0b99ca0431847505d6a90ee71b22`，分支 `main`
- 更正日期：2026-11-12
- 原报告（保留不改）：`specs/todo-status-filter/reports/delivery/W8-delivery-r20261112-w8r3-1.md`，sha256 `3aa937bb78152be9bc991492db9237321725fc2d41b858ccfd3849c5279f39f1`
- 原结果记录（保留不改，仓库外）：`/private/tmp/claude-501/-Users-zhaobowen-course-yideng-5-TodoList/025d94c2-aedc-4cca-b2b7-71d6298e7bbe/scratchpad/bowen-runs/r20261112-w8r3/results/W8-1.json`，sha256 `6263895e9878730c9adf9259ee52ddc9e50858761e8fab958201c571318b1597`（envelopeSha256 `61abdfd71a3a02a9b47af5b273cbcd26602ed40016cfc5a29fc156f553da7e05`）
- 更正范围：只更正原报告第 10 节对 PAUSE 原因的说法，并重新整理检查结论和提交状态。没有重跑任何检查，所用事实全部来自上述原报告和结果记录。没有修改业务代码、规格、工作流或旧结果记录，没有执行 Git 写入、推送或部署，也没有进入其他节点。

## 0. 关于本地证据路径（阅读说明）

本报告和原报告里引用的下列路径，**都是作者本机的本地记录，不在 Git 仓库中**。阅读时请把它们当作「本地留存的证据位置和哈希」，而不是仓库里的文件：

- `/private/tmp/...` 开头的路径：命令日志（cmd-1.log～cmd-5.log）、结果记录 `results/W8-1.json`、npm test 基线日志等。这些是临时目录，可能已被系统清理；
- `.playwright-mcp/r20261112-w8r3/W8-1/`：浏览器截图和 results.json，被 `.gitignore` 忽略，不会提交；
- `pages-dist/`：构建产物，被 `.gitignore` 忽略；
- `specs/todo-status-filter/reports/RUNS.md`、`reports/_runs/`、`reports/batch-02/`、`reports/batch-03/`，以及 `reports/batch-04/` 下的 W4 r9–r12、W5 r7 和 `batch-r20261111-w3r6.md`、`current-batch.md`：工作流过程记录，本次没有提交。

仓库里能直接查看的验收依据有三部分：已提交的 `reports/batch-04/` W5 r8、W6 r9、W7 r7 报告，本报告，以及原 W8 报告。文中给出的 SHA256 用来核对本地记录是否与报告一致，并不说明仓库里包含这些文件。

## 1. 更正：PAUSE 的直接原因与其他阻塞

原报告第 10 节说 PAUSE 是因为「全量检查失败（tsc）和需要用户授权」。**这个说法不准确。** 调度器（`runW8` 的 Report 之后的路由）按固定顺序判断，遇到第一个满足的条件就返回。本次的实际情况如下：

| 顺序 | 判断条件 | 本次结果 |
|---|---|---|
| 1 | 修改范围核对（scopeErr），交付报告是否为新建 | 通过 |
| 2 | **分支检查中有未列入 deliveryExclusions 的问题** | **命中，直接返回 PAUSE** |
| 3 及以后 | 服务停止、环境阻塞、规格问题、证据过期、类型检查等 | 没有执行（已在第 2 步返回） |

**直接原因：分支检查发现 5 项问题，它们都不在 deliveryExclusions 内**（结果记录 reason 原文：「分支检查发现问题：范围外修改 specs/todo-status-filter/作业说明.md；其他 specs/todo-status-filter/requirements.md；其他 specs/todo-status-filter/design.md；其他 specs/todo-status-filter/reports/；其他 main」）：

1. `specs/todo-status-filter/作业说明.md`：范围外修改。它随 HEAD 提交，但不在 design.md:50 的计划清单里。在 Inventory 阶段，这一项已经按 SI-D 处置为文档限制；但这条处置只作用于 Inventory，不覆盖分支检查。
2. `specs/todo-status-filter/requirements.md`：工作区有未提交改动（W2 r5 的文字同步）。
3. `specs/todo-status-filter/design.md`：同上。
4. `specs/todo-status-filter/reports/`：历史工作流记录还没有被跟踪，而同一目录下已经提交了一部分报告，提交范围前后不一致。
5. `main`：当前在默认分支上，后续如果要提交，应先建功能分支。

（`workflow-examples/` 也被列为范围外，但它在 deliveryExclusions 内，只做记录，不阻塞。）

**其他阻塞：** 下面几项因为第 2 步已经返回而没有被判断到。按记录的数据推算，它们本来也会让结果无法 DONE。

| 按代码顺序 | 阻塞 | 依据 | 本来会产生的路由 |
|---|---|---|---|
| A | W6 r9 测试报告被判为「已过期」：它记录的 design.md、requirements.md、tasks.md 哈希与当前不同 | 结果记录 `reportCodeState` | 返回 W6 重新验证（这个条件排在类型检查之前） |
| B | 按现有规则，验收证据只认登记过的 W6 报告；AC1–AC16 的判定都是「证据已过期」。本次 W8 浏览器复验取得的新证据，不会改写这项判定 | 结果记录 `acceptance` | PAUSE（证据不足） |
| C | 类型检查失败（tsc 退出码 2） | cmd-5.log | PAUSE（全量检查有失败） |
| D | commit、push、部署需要用户授权 | — | 不是路由条件，属于外部操作 |

## 2. 检查结论（分开列出，互不替代）

| 类别 | 结论 | 依据 |
|---|---|---|
| **功能验收（浏览器）** | AC1–AC12、AC14–AC16 共 15 条：**本次实际通过**，都有本次新取得的证据 | `.playwright-mcp/r20261112-w8r3/W8-1/`（results.json sha256 `ee667fb2f24b85351917eaf960b498dd7c2681bae039edf6ba5dff27a0d575d0`）；用 `npx vite --config vite.pages.config.ts --port 5180` 启动，测试结束后已停止 |
| **功能验收（命令，AC13）** | **通过**：`npm run build` 退出码 0；`npx eslint app` 没有新增错误 | cmd-3.log、cmd-1.log |
| **构建** | `npm run build` 退出码 **0**，通过，`next-env.d.ts` 已逐字节恢复；`npm run build:pages` 退出码 **0**，通过（这是补充命令） | cmd-3.log、cmd-4.log |
| **lint（实际结果）** | `npx eslint app` 退出码 **1**：1 个错误 `app/page.tsx:56:32 react-hooks/set-state-in-effect`，按 HEAD 基线确认是既有问题，没有新增。`npm run lint` 退出码 **1**：共 941 个错误，其中 `pages-dist/` 808 个、`workflow-examples/` 132 个（这两个路径经用户决定排除，排除不算通过），另 1 个就是上面的既有问题。命令本身的退出码都不是 0，所以只能说「无新增错误」，**不能说 lint 零错误** | cmd-1.log、cmd-2.log |
| **类型检查** | `node_modules/.bin/tsc --noEmit …` 退出码 **2**，**失败**。3 个既有错误：`db/index.ts(1,21)` TS2307、`worker/index.ts(6,11)` TS2304、`worker/index.ts(7,7)` TS2552。都不在本功能代码中，没有修复 | cmd-5.log |
| **npm test** | **排除、未运行**（D-npm-test-exclude，HEAD 基线同样 2/2 失败）。排除不等于通过 | 基线日志 sha256 `1e537dff…d31` |
| **未验证的运行路径** | `npm run dev` / `npm run start`（vinext）没有做浏览器验证，只通过 `npm run build` 验证了能构建；`npm run dev` 访问 `GET /` 会返回 500，是已知问题（AGENTS.md:5）；没有部署，也没有验证 Cloudflare Pages 线上环境 | — |
| **其他遗留** | 浏览器第 1 次调用失败后，可能留下一个停在 about:blank 的空上下文没有关闭；控制台有 1 条 favicon.ico 404，不影响使用 | 原报告第 4 节 |

## 3. 文档限制（与原报告 7.2 一致，不改变）

SI-A 到 SI-E 按用户决定 D-W8-spec-notes 逐条处置：它们不阻塞流程，但问题本身没有解决。具体是：design.md:12–16 和 :52 的文字已过时；作业说明.md:39–46 的复核说法没有证据，不作为验收证据；AC 的行号以当前的 requirements.md:40–55 为准；AGENTS.md:6–7 与 D-SI-2、D-SI-3 冲突，本次按决定执行。逐条明细见原报告 7.2。

## 4. 未提交的文件（`git status --short --untracked-files=all`，更正版写入前）

已修改、未提交：

- `specs/todo-status-filter/requirements.md`（W2 r5 文字同步）
- `specs/todo-status-filter/design.md`（W2 r5 文字同步）

未跟踪（`.playwright-mcp/`、`pages-dist/` 已被 .gitignore 忽略，不在此列）：

- `specs/todo-status-filter/reports/delivery/W8-delivery-r20261112-w8r3-1.md`（W8 原报告）
- `specs/todo-status-filter/reports/delivery/W8-delivery-r20261112-w8r3-1-corrected.md`（本更正版）
- `specs/todo-status-filter/reports/RUNS.md`
- `specs/todo-status-filter/current-batch.md`、`code-review-report.md`、`development-report.md`
- `specs/todo-status-filter/reports/_runs/`（3 个 W2 修订记录）
- `specs/todo-status-filter/reports/batch-02/`（13 个）、`batch-03/`（14 个）、`batch-04/`（6 个：W4 r9–r12、W5 r7、batch-r20261111-w3r6）
- `workflow-examples/`（按用户要求不纳入 Feature 提交）

## 5. 课程作业所需的最小提交清单（建议，需用户授权后执行）

功能代码（`app/page.tsx`、`app/globals.css`）、需求、任务、作业说明，以及 W5 r8、W6 r9、W7 r7 报告，都已经在 HEAD 42b4b2c 中，并且此前已推送。剩下的最小补充是：

1. `specs/todo-status-filter/requirements.md`：让规格文字与已提交的 T6 实现一致
2. `specs/todo-status-filter/design.md`：同上
3. `specs/todo-status-filter/reports/delivery/W8-delivery-r20261112-w8r3-1.md`：W8 实际检查的原报告
4. `specs/todo-status-filter/reports/delivery/W8-delivery-r20261112-w8r3-1-corrected.md`：本更正版

不建议放进最小提交的：`RUNS.md`，因为它引用了大量未提交的历史报告，单独提交会留下指向不存在文件的引用；`batch-02/03/04` 历史记录、`_runs/`、`current-batch.md` 等过程文件，如需完整审计记录，可以和 RUNS.md 一起整体提交；`workflow-examples/`、`.playwright-mcp/`、`pages-dist/` 则不提交。按项目规则，提交前应先从 `main` 建功能分支。

## 6. 对课程作业演示的影响

不影响。筛选功能的 15 条浏览器验收和 AC13 都有本次实际证据，构建也成功。类型错误出在页面入口不引用的 Cloudflare 后端示例文件中；npm test 已排除，与本功能无关。演示时请用 `npx vite --config vite.pages.config.ts --port <端口>` 启动，不要用 `npm run dev`。
