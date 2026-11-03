# 交付报告：按任务名称搜索

## Feature 与范围

- 名称：按任务名称搜索（`specs/todo-search/`）
- 范围：搜索框按任务名称实时过滤（去掉首尾空格、不区分大小写），与状态筛选取交集；支持清除按钮和 Esc 清除；有无结果空状态和结果数播报；搜索词不持久化；桌面和手机端适配
- 不包含：拼音 / 模糊搜索、匹配高亮、搜索词持久化

## 任务

| 任务 | 状态 | Commit |
|---|---|---|
| T1 搜索逻辑、搜索框与交互 | [x] | 7643436 |
| T2 搜索框样式与移动端适配 | [x] | 6742e69 |

## 验收标准

| AC | 结果 | 证据 |
|---|---|---|
| AC1 搜索框带标签 | 通过 | T1 测试报告（无障碍快照：`searchbox "搜索任务"`） |
| AC2 `Claude` | 通过 | T1 测试报告 |
| AC3 不区分大小写 | 通过 | T1、T2 回归 |
| AC4 去掉首尾空格 | 通过 | T1 测试报告 |
| AC5 与筛选取交集 | 通过 | T1 测试报告（第二轮）、W8 回归 |
| AC6 无结果空状态 | 通过 | T1 测试报告、W8 回归 |
| AC7 清除按钮 / Esc | 通过 | T1、T2、W8 回归 |
| AC8 统计不变 | 通过 | T1 测试报告、W8 回归 |
| AC9 刷新后任务保留、搜索为空 | 通过 | T1 测试报告、W8 回归 |
| AC10 390px 无横向滚动、无阻断错误 | 通过 | T2 测试报告（截图 390 / 1280）、W8 回归 |
| AC11 build 通过、无新增错误 | 通过 | 见下方全量检查 |

## 全量检查（W8 实际执行）

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run lint` | 804 个错误 | 803 个在 `pages-dist/` 构建产物，1 个在 `app/page.tsx:49`（原有的 localStorage Effect）。都是既有问题，本 Feature 没有新增 |
| `npx tsc --noEmit` | 3 个错误 | 在 `db/index.ts`、`worker/index.ts`，缺少 Cloudflare 类型，都是既有问题 |
| `npm test` | build 通过；测试 0 通过 / 2 失败 | 已确认的既有问题：测试引用的 `app/_sites-preview/SkeletonPreview.tsx` 在 HEAD 基线中就不存在。按用户决定不修改该测试 |
| `npm run build` | 通过 | 构建改写的 `next-env.d.ts` 已还原 |

## 浏览器关键流程（W8，Playwright MCP，390px）

1. 清空 localStorage → 新增「学习 React 搜索」→ 搜索 `react` → 勾选完成 → 筛选「已完成」：只显示该任务，统计为「25% / 3 项待完成」「4 项任务 / 1 项已完成」，`scrollWidth=390` —— 通过
2. 切到「待完成」：显示「没有找到匹配的任务」 —— 通过
3. 焦点在搜索框时按 Esc：搜索清空，显示待完成的 3 项，焦点留在搜索框 —— 通过
   - 第一次按 Esc 时焦点在「待完成」按钮上，搜索没有清空。这符合 AC7 的设计（Esc 只在搜索框内生效），是测试步骤问题，不是缺陷
4. 刷新：搜索为空，4 项任务都在，「学习 React 搜索」仍为已完成；控制台 0 错误 —— 通过

## 分支整体检查（4ec3f3b..6742e69）

- 修改文件：`app/page.tsx`、`app/globals.css`、`AGENTS.md`（新建）、`specs/INDEX.md`、`specs/todo-search/*`
- 敏感信息 / 调试代码（console、debugger）：未发现
- 无关修改：无
- 未跟踪文件：`.playwright-mcp/`（测试产物，未提交，未加入 .gitignore）

## 已知限制与剩余风险

- 本地 `npm run dev`（vinext）因为 `pages/main.tsx` 会返回 500，是既有问题。本次验收使用 `vite.pages.config.ts` 入口，已写入 AGENTS.md
- lint、tsc、`npm test` 的基线错误仍存在，建议另开任务处理
- 控制台出现的 `favicon.ico` 404 是既有问题

## Git 状态

- 分支：main，领先 origin/main 3 个提交（4ec3f3b、7643436、6742e69）
- 本报告 `delivery-report.md` 未提交
- 没有执行 push、PR 或部署

## 建议的下一步

1. 确认后提交本交付报告，并 push 到 origin
2. 可选：把 `.playwright-mcp/` 加入 .gitignore；另开任务修复既有的 lint、tsc 问题和过时的 starter 测试
