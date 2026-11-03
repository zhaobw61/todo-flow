# 当前开发批次

## Feature

- 名称：按任务名称搜索
- 规格目录：`specs/todo-search/`

## 执行模式

- 模式：串行
- 选择原因：本批仅 1 个任务；T2 依赖 T1 的 DOM 结构与类名

## 需要保护的现有修改

- 文件：无（W1 时工作区干净）
- 保护要求：不改动 add/toggle/delete/clear/持久化既有行为

## 本批任务

### T1 搜索逻辑、搜索框与交互

- 目标：实现按名称实时搜索，与状态筛选取交集
- 前置依赖：无
- 预计修改文件：`app/page.tsx`
- 对应验收标准：AC1–AC9
- 验证方法：`npm run lint`；浏览器按 AC1–AC9 操作
- 执行者：Claude

## 项目约束

- 必须遵守的 AGENTS.md 规则：项目无 AGENTS.md；遵守 yd-ai-nodes 共同规则
- 禁止修改的文件：`tests/`、`app/layout.tsx`、`package.json`、持久化格式
- 不在本批范围内的功能：样式美化（T2）、拼音/模糊搜索、高亮

## W4 交接说明

- 开发顺序：状态与派生 → 搜索框与清除 → 空状态与播报 → 删除焦点
- 并行任务的整合顺序：无
- 开发完成后需要执行的最小检查：`npm run lint`、`npx tsc --noEmit`
