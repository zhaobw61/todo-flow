# W5 代码审查报告：按完成状态筛选（batch-04）

- run.id：r20261111-w5r8
- 节点：W5（第 1 次）
- 批次：batch-04（T6 → T4；本轮审查 W4 r20261111-w4r12 报告。该报告是返工 R1、R2 的结果，来源为 W5 r20261111-w5r7 的 S2-1、S2-2。另审查磁盘上由 W4 r20261111-w4r9 写入、本轮未改动的 T6 修复）
- 日期：2026-11-11
- 结论：nextNode = W6（建议）。Codex 两节都写"未发现问题"，本报告没有需要逐条判断的意见。Claude 另做了静态复核，结果与 Codex 一致，没有发现新的问题。本节点只记录判断，不改代码，也不改其他报告，不进入 W6。

## 审查运行信息

| 项目 | 值 |
| --- | --- |
| Codex 原始输出 | `/private/tmp/claude-501/-Users-zhaobowen-course-yideng-5-TodoList/1ead512f-3a5c-4f63-bf2b-9c5965620f7d/scratchpad/bowen-runs/r20261111-w5r8/W5-1/codex/output.txt` |
| 原始输出 sha256 | `d2f7797ea0228619cd77b2e24195d27010d6f4163a4e1bbad164627a32e6bff4`（判断时重新计算，与 meta.json 一致；共 1859 行） |
| meta 路径 | `/private/tmp/claude-501/-Users-zhaobowen-course-yideng-5-TodoList/1ead512f-3a5c-4f63-bf2b-9c5965620f7d/scratchpad/bowen-runs/r20261111-w5r8/W5-1/codex/meta.json` |
| 审查输入指纹 | `a50797ea8f449d8b18236ecf71469b18b4a68a88c0e9fcc2f62eceeabc5b433e`（清单为同目录的 `scope.json`，missing 为空，error 为"无"。判断时重新计算了 4 个源码文件、4 个规格文件和 W4 r12 报告的 sha256，都与清单一致） |
| 是否复用 | 否，本次运行产生 |
| Codex | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`，codex-cli 0.166.0-alpha.5.1，`exec --sandbox read-only --ephemeral`，reasoning effort low |
| 退出码 | 0（`exit_code.txt` 与 meta.json 一致） |
| 会话 | `01a1cdb5-085f-7142-8af1-848e509abb37` |
| HEAD | `e86e8a8399793c73a93d482900b1e408e5aac50a` |

## 审查范围

- 源码：`app/globals.css`、`app/page.tsx`、`next-env.d.ts`、`package.json`
- 规格：`specs/todo-status-filter/requirements.md`、`design.md`、`tasks.md`、`current-batch.md`
- 开发报告：`specs/todo-status-filter/reports/batch-04/W4-development-r20261111-w4r12-1.md`

## 输出校验

- 结果：有效。
- 依据：原始输出中，Codex 先用 `nl -ba` 逐个完整读取范围内的 4 个源码文件和 4 个规格文件，之后又复读了 next-env.d.ts、package.json、requirements.md、design.md、tasks.md、page.tsx 第 235–310 行、current-batch.md 第 1–115 行。读开发报告之前，它先写了一句阶段性说明："独立静态审查已完成，未发现本批焦点实现与 AC16 的明确偏差。"然后才读取 W4 r12 报告全文，并复读了第 116–126 行（K2–K7）。它没有读取范围以外的文件，也没有读取 workflow-examples/。最终输出按要求分为两节，两节都明确写"未发现问题"，并附有简短理由。
- 过程中的报错：开始时 Responses WebSocket 连接失败，重连 5 次后输出"Falling back from WebSockets to HTTPS transport"，改用 HTTPS 后正常完成。这是传输层报错，不影响审查内容，退出码为 0。
- 局限：本次 reasoning effort 为 low。Codex 也说明，它没有读取 W4 r12 报告引用的历史报告、任务包存档和运行记录，所以没有独立核实其中的历史哈希和行号映射。这些内容由 Claude 在下文「补充核对」中做了静态复核。

## 逐条判断

Codex 没有提出 S1-n 或 S2-n 意见，所以没有需要接受、拒绝或待确认的条目。

| 编号 | Codex 位置 | 严重程度（Codex） | 意见摘要 | 判断 | 依据 | 路线 |
| --- | --- | --- | --- | --- | --- | --- |
| 第一节 | — | — | 独立审查"未发现问题"。焦点目标选择、提交后由 Effect 聚焦、筛选按钮 ref 都与 AC16 和设计一致，只是静态结论 | 不适用（不是意见） | 与 Claude 的核对一致。app/page.tsx:109-117 在切换前根据 `visibleTodos`、`filter` 判断该项是否离开视图，目标优先级依次为下一项、上一项、搜索框、当前筛选按钮。:84-91 的 Effect 依赖 `[visibleTodos]`，它取出待处理目标、清空 ref 后再聚焦。:233-236 是筛选按钮的 ref 回调。代码中没有 setTimeout，deleteTodo（:123-136）、clearCompleted（:143-147）未改动。以上与 design.md:72-76 第 5 条、requirements.md:54 一致。sha256 仍为 `8df2714c…dd6d` | 无 |
| 第二节 | — | — | 与开发报告比较"未发现问题"。K1–K7 与 DOM 顺序、disabled 条件一致，风险引用已改为 design.md:89，运行检查留给 W6 | 不适用（不是意见） | 与 Claude 的核对一致，见下文「补充核对」。W4 r12 报告第 278 行引用 design.md:89，design.md:89 原文包含"焦点 Effect 若在 `visibleTodos` 之外的渲染中消费 ref 或目标元素尚未挂载，可能聚焦失败"。报告第 3、15、248、252、272 行都写明运行时项目由 W6 承接，不是通过 | 无 |

### 补充核对（Claude 静态复核，不是 Codex 意见）

按 current-batch.md:187 规定的 W5 验证方法（逐场景检查按键序列可执行，预期目标与 AC16、design.md:72–76 一致；逐条核对引用行号；确认第 161 行同类结论已更正），做了以下只读核对：

1. K1–K7 按键序列：按 app/page.tsx 的 DOM 顺序逐步推演，依次为 brand :154 → #new-todo :169 → 添加按钮 :178（输入为空时 disabled）→ #todo-search :202 → 清除搜索 :218-222（有搜索词时才渲染）→ 三个筛选按钮 :227-241 → 清除已完成 :243-250（completedCount 为 0 时 disabled）→ 每项的复选框和删除按钮 :259-280。Tab 次数、跳过的 disabled 元素、Space 后的焦点目标（由 :113-116 决定）和随后的 Tab/Shift+Tab 去向都与报告第 106–113、120–125 行一致。空状态文案由 :291-293 决定（无搜索词为"这里没有任务"，有搜索词为"没有找到匹配的任务"），与 K1、K3、K5 一致。覆盖范围包括下一项（K1、K4）、上一项（K2）、视图变空且无搜索词（K1、K3、K4）、视图变空且有搜索词（K5）、连续切换（K1、K3、K4），以及焦点不应移动的情况（K6 为「全部」视图，K7 为「全部」视图带搜索词、切换后仍留在视图），满足 current-batch.md:177-178 的要求。K1 的起止步骤与 reports/batch-03/W6-test-r20261111-w6r6-1.md:85-90 的历史 op1、op2 一致（第 84 行是上下文说明，与 W4 r12 报告的引用行号一致）。
2. 存档与现行版的行号映射：存档 `reports/batch-04/batch-r20261111-w3r6.md` 的 sha256 为 `6af4eafcc8761d2a1cfc06b1f2cdfa68b0c8724824f509e8a2b06a7d0e7eb3e3`（152 行），现行 current-batch.md 为 205 行。分 4 个区段逐段比较原文，存档 1–5 对应现行 1–5，6–71 对应 8–73，72–132 对应 84–144，133–152 对应 147–166，各段都完全相同。所以存档 :89/:91/:145/:147 分别对应现行 :101/:103/:159/:161，与报告第 11 行一致。现行 :101 是 T6 的 W4 验证方法，:103 是 W6 验证方法，:159 是 W4 交接要求，:161 是交接给 W6 的执行顺序，用法与报告更正记录一致。
3. 第 161、162 行同类结论：报告「更正记录」R1 部分第 19、20 条已改写"无……缺失交接"和"是否阻塞 W5：否"。新报告第 272 行只写静态结论，并说明交接是否完整由 W5 复核，没有写成运行时通过。
4. 状态表述：T6 仍为"实现完成（未验收）"，T4 仍为"交接完成（未执行，非验收通过）"（报告第 15 行），npm test 写"排除（未运行）"（第 248、257 行），符合 D-handoff、D-W4-pending-verify、D-npm-test-exclude。

以上都是静态结论，不代表 T6-REPRO、AC16、AC1–AC15 或 AC12 的运行验收通过。

## 路由建议

- nextNode：W6（建议）。
- 原因：Codex 两节都没有发现问题，Claude 的补充核对也没有发现需要更正的地方。W5 r7 的 S2-1 已由 W4 r12 补齐纯键盘交接（K0–K7），S2-2 已改为 design.md:89。没有需要返回 W2 的规格问题，没有需要 W4 修改代码或更正报告的事项，也没有需要用户在方案间选择的事项。本节点没有接受任何意见，不需要修复，所以也没有修复后的基础检查要执行。
- 返工次数：batch-04 实际返工 1 次（W5 r20261111-w5r7 → W4，RUNS.md:36），上限 2 次。本次不再要求返工，不重置，也不提高上限。
- W6 应执行的内容（按 current-batch.md:103、:161 和 W4 r12 报告第 253–257 行的交接）：在新建的独立上下文中，只用键盘执行 T6-REPRO 和 AC16 的 K1–K7。之后回归 AC1–AC11、AC15，AC14 最后执行。T6 全部通过后，再执行 T4 AC12（390px 视口，启用触控）。最后执行 AC13：按 D-SI-2 保存 `next-env.d.ts` 快照，执行构建，逐字节恢复；`npx eslint app` 的结果按 D-SI-3、D-lint-exclusions 与 HEAD 基线逐条对比。npm test 按 D-npm-test-exclude 写"排除（未运行）"，排除不等于通过。如果 W6 实测的 Tab 次数与 K 序列不同，按报告 K0(d)(f) 的规则记录并判定。
- 限制：本轮只做静态审查，没有运行测试、构建、lint 或浏览器。W4 的"实现完成（未验收）"和"交接完成"都不是验收通过（D-handoff）。W7 只能依据 W6 的实际证据勾选。
- 不进入 W6，不提交，不进入 W8。
