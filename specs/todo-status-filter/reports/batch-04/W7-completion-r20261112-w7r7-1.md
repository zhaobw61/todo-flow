# W7 完成记录：按完成状态筛选（batch-04）

- run.id：r20261112-w7r7
- 节点：W7（第 1 次）
- batchId：batch-04
- 日期：2026-11-12
- nextNode：W8（tasks.md 已无 `- [ ]` 任务）

## 1. 本批勾选的任务

逐任务判定由脚本得出，原样照写：

| 任务 | 静态判定 | 运行判定 | 问题 | 完成标准来源 | 结果 |
|---|---|---|---|---|---|
| T6 修复筛选视图中切换完成状态后的键盘焦点丢失 | 已完成 | 已完成 | 无 | tasks.md:10 | 已勾选 |
| T4 移动端与控制台验收（AC12） | 不要求 | 已完成 | 无 | tasks.md:8 | 已勾选 |

返工项（不是 tasks.md 中的任务行，不勾选，仅记录判定）：

| 返工项 | 静态判定 | 运行判定 | 问题 | 完成标准来源 |
|---|---|---|---|---|
| R1 | 已完成 | 已完成 | 无 | current-batch.md:185 |
| R2 | 已完成 | 不要求 | 无 | current-batch.md:198 |

运行依据（W6 r20261112-w6r9）：
- T6：T6-REPRO 只用键盘重新执行，结论**未复现**（两次按 Space 后焦点分别落在下一项复选框和当前选中的筛选按钮，未落到 body）；AC16 的 S1–S4 共 12 次切换全部满足预期；回归 AC1–AC11、AC14、AC15 通过；AC13（`npm run build` 退出码 0，`npx eslint app` 相对 HEAD 基线无新增错误，唯一错误为既有问题）通过。
- T4：AC12 在 390x844 视口实际检查，筛选按钮可见可点击、无横向滚动、控制台无阻断性错误，通过（首次加载的 favicon 404 判定为非阻断性）。

## 2. 未勾选的本批任务

无。本批 T6、T4 均已勾选。

## 3. 剩余未完成任务

无。本功能 tasks.md 中的任务（T1–T7）已全部勾选。其他批次的必需验收仍按各自批次记录执行，未因本批勾选而免除；交付核对在 W8 进行。

历史失败事实保留：T6-REPRO 曾在 W6 r20261111-w6r5、r20261111-w6r6 中复现（焦点落到 body）；batch-04 的 W6 r7、r8 在 Preflight 停止，未生成报告。这些记录均未修改。

## 4. INDEX 更新结果

`specs/INDEX.md` 只修改了"按完成状态筛选"一行：状态由"进行中"改为"已完成"（tasks.md 已无剩余任务）；说明列补充 batch-04 勾选 T6、T4（W7 r20261112-w7r7，依据 W6 r20261112-w6r9），注明 npm test 排除（未运行），剩余任务：无，交付核对在 W8。其他行未动。

## 5. 用到的证据

- 开发：specs/todo-status-filter/reports/batch-04/W4-development-r20261111-w4r10-1.md、specs/todo-status-filter/reports/batch-04/W4-development-r20261111-w4r12-1.md
- 审查：specs/todo-status-filter/reports/batch-04/W5-code-review-r20261111-w5r8-1.md
- 测试：specs/todo-status-filter/reports/batch-04/W6-test-r20261112-w6r9-1.md（nextNode W7）

## 6. 测试报告中的排除项与非运行项

| 项目 | 状态 | 说明 |
|---|---|---|
| project-test（`npm test`） | 排除（未运行） | 用户决定 D-npm-test-exclude；HEAD 基线复跑同样 2/2 失败。排除不等于通过，也不是已修复 |
| lint 路径 pages-dist/ | 排除（未运行），错误数 0 | 用户决定 D-lint-exclusions |
| lint 路径 workflow-examples/ | 排除（未运行），错误数 0 | 用户决定 D-lint-exclusions |
| current-batch.md:145 的 W4 交接要求 | 非运行验收，不计为通过 | 用户决定 D-W6-nonruntime |

lint 的既有问题 `app/page.tsx:56:32 react-hooks/set-state-in-effect` 已经 Git 基线确认（HEAD 为 49:32），未修复，不属于本功能新增问题。

## 7. 建议提交的文件

只含本功能相关文件，不含 `workflow-examples/`、`.playwright-mcp/`，不含 `next-env.d.ts`：

- app/page.tsx
- app/globals.css
- specs/INDEX.md
- specs/todo-status-filter/requirements.md
- specs/todo-status-filter/design.md
- specs/todo-status-filter/tasks.md
- specs/todo-status-filter/current-batch.md
- specs/todo-status-filter/development-report.md
- specs/todo-status-filter/code-review-report.md
- specs/todo-status-filter/reports/

建议 commit message：

```
feat(todo): 按完成状态筛选并修复切换后的键盘焦点丢失

- 筛选按钮悬停与选中样式区分（T7）
- 筛选视图中切换完成状态后焦点移到下一项/上一项/筛选按钮/搜索框（T6，AC16）
- 完成 T1–T7 核对与验收记录（npm test 按用户决定排除，未运行）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## 8. 提交状态

提交状态：未执行（本版不执行 commit、push）

当前 git status（写本报告前）：

```
 M app/globals.css
 M app/page.tsx
 M specs/INDEX.md
?? specs/todo-status-filter/
?? workflow-examples/
```

## 9. 候选经验（只写在报告里，未写入 AGENTS.md）

1. 键盘焦点类修复的验收要只用键盘操作，并用 `document.activeElement` 记录每次操作后的焦点及 Tab/Shift+Tab 走向，避免 click 掩盖焦点丢失。
2. 从页面最后一个可聚焦元素按 Tab 落到 body 属于正常离开页面，判定焦点丢失时要与切换导致的丢失区分。
3. 用户决定排除的检查（如 `npm test`）在各节点报告中始终写"排除（未运行）"，不得转写为通过。
