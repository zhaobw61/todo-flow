# 测试报告（T1）

## 测试环境

- macOS，Node v26.3.0，Playwright MCP（Chromium）
- 页面地址：http://localhost:5179/
- 启动方式：`npx vite --config vite.pages.config.ts --port 5179`（项目自带的 TodoFlow SPA 入口，渲染同一个 `app/page.tsx`）
- 未使用 `npm run dev` 的原因：vinext dev 把 `pages/main.tsx` 当作 Pages Router 页面做 SSR，抛出 `ReferenceError: document is not defined`，`GET /` 返回 500。`pages/` 在 HEAD 中已存在，属于既有环境问题，与本次改动无关
- 测试前清除了 `localStorage['todo-flow-items']`，从默认 3 项任务开始

## 命令

| 命令 | 结果 |
|---|---|
| `npm run build` | 通过（构建改写的 `next-env.d.ts` 已还原） |
| `node --test tests/rendered-html.test.mjs` | 0 通过 / 2 失败 —— **已确认的既有问题**：测试引用的 `app/_sites-preview/SkeletonPreview.tsx` 在 HEAD 中就不存在，本 Feature 未修改该测试（用户已确认不修改、不扩大范围） |
| `npx eslint app` / `npx tsc --noEmit` | 无新增错误（基线错误见 development-report.md） |

## 验收场景（Playwright 真实操作）

| AC | 操作 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| AC1 | 读取无障碍快照 | 有「搜索任务」搜索框 | `search` 区域内有 `searchbox "搜索任务"` | 通过 |
| AC2 | 输入 `Claude` | 只显示 Claude 任务 | `["让 Claude 审查 TodoList 代码"]`，播报「找到 1 项匹配任务」 | 通过 |
| AC3 | 输入 `claude` | 同 AC2 | `["让 Claude 审查 TodoList 代码"]` | 通过 |
| AC4 | 输入 `"  部署  "` | 只显示部署任务 | `["部署到 Cloudflare Pages"]` | 通过 |
| AC5 | 勾选「使用 Antigravity 测试页面」→ 已完成 + `测试`；→ 待完成 + `测试` | 前者只显示该任务；后者为无结果空状态 | 已完成：`["使用 Antigravity 测试页面"]`；待完成：`[]`，空状态「没有找到匹配的任务 / 换个关键词或清除搜索试试。」 | 通过 |
| AC6 | 全部 + `不存在的任务xyz` | 「没有找到匹配的任务」 | 列表为空，标题为「没有找到匹配的任务」，播报「找到 0 项匹配任务」 | 通过 |
| AC7a | 点击「清除搜索」 | 清空并恢复 3 项 | 值为 `""`，3 项，焦点在 `#todo-search`，清除按钮隐藏 | 通过 |
| AC7b | 输入 `部署` 后按 Esc | 清空并恢复 3 项 | 值为 `""`，3 项，焦点在 `#todo-search` | 通过 |
| AC8 | AC5 过程中观察统计 | 统计不随搜索变化 | 始终是「33% / 2 项待完成」「3 项任务 / 1 项已完成」 | 通过 |
| AC9 | 输入 `Claude` 后重新导航 | 任务保留，搜索为空 | 搜索为 `""`，3 项且 Antigravity 仍为已完成；localStorage 中只有 `todo-flow-items` | 通过 |
| 风险项 | 搜索 `部署` 后删除该任务 | 焦点回到搜索框 | 焦点在 `todo-search`，显示无结果空状态，底部「2 项任务」 | 通过 |
| AC10（部分） | 390×844 下检查 | 无横向滚动、无阻断性错误 | `scrollWidth=390`，无横向滚动；控制台只有 `favicon.ico` 404（既有问题，非阻断） | 通过（T1 部分） |

## 测试中失败的步骤

- 第一次做 AC5 时，点击复选框报错 “Ref f1e44 not found”（快照引用过期），任务并未被勾选。那一轮结果作废，刷新快照后从头重做 AC5，结果见上表

## 证据

- 390px 全页截图：`.playwright-mcp/t1-390.png`
- 快照和控制台日志：`.playwright-mcp/`

## 留给 T2 的观察

- 搜索框尚无专属样式；浏览器原生的 ✕ 和自定义「清除」按钮同时出现；清除按钮 32×24px，小于 40px 触控目标

## 结论

- T1 范围内的验收场景（AC1–AC9，以及 AC10 中的横向滚动 / 控制台检查）全部通过
- 允许进入 W7

---

# 测试报告（T2）

- 环境：同 T1（Vite pages 入口，http://localhost:5179/，Playwright MCP）
- 命令：`npm run build` 通过（`next-env.d.ts` 已还原）；`npx eslint app` 1 个错误、`tsc` 3 个错误，与基线一致，没有新增

| AC | 操作 | 实际 | 结果 |
|---|---|---|---|
| AC10 | 390×844 下输入超长关键词 | `scrollWidth=390`；输入框 328×48、字号 16px；清除按钮 46×44；原生 ✕ 不显示；长文本不与清除按钮重叠（截图 `.playwright-mcp/t2-390.png`） | 通过 |
| AC10 | 1280×900 下搜索 `Claude` | `scrollWidth=1280`，布局正常（截图 `.playwright-mcp/t2-1280.png`） | 通过 |
| AC10 | 控制台 | 只有 `favicon.ico` 404（既有问题，非阻断） | 通过 |
| AC11 | build / lint / tsc | build 通过，没有新增错误 | 通过 |
| 回归 AC3 | 390px 下输入 `claude` | 只显示 Claude 任务 | 通过 |
| 回归 AC7 | 390px 下点击「清除搜索」/ 按 Esc | 搜索清空、焦点回到搜索框、列表恢复 | 通过 |

注：此时列表为 2 项，是因为 T1 测试中删除了「部署到 Cloudflare Pages」（测试浏览器的 localStorage，不是真实用户数据）。

- 结论：通过，允许进入 W7
