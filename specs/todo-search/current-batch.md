# 当前开发批次

## Feature

- 名称：按任务名称搜索
- 规格目录：`specs/todo-search/`

## 执行模式

- 模式：串行
- 选择原因：本批仅 1 个任务（T2），它依赖已完成的 T1

## 需要保护的现有修改

- 文件：无（T1 已提交为 7643436，工作区只有未跟踪的 `.playwright-mcp/` 测试产物）
- 保护要求：不修改既有选择器的视觉表现

## 本批任务

### T2 搜索框样式与移动端适配

- 目标：给 `.search-box` / `#todo-search` / `.search-clear` 加上与现有设计一致的样式；隐藏原生搜索清除图标；清除按钮触控尺寸 ≥ 40px；390px 下无横向滚动
- 前置依赖：T1（已完成）
- 预计修改文件：`app/globals.css`
- 对应验收标准：AC10、AC11
- 验证方法：`npm run build`；Playwright 在 390px 和桌面宽度下截图、检查 scrollWidth 和控件尺寸；回归 AC1–AC9 的核心路径
- 执行者：Claude

## 项目约束

- 必须遵守的 AGENTS.md 规则：浏览器验收用 `vite.pages.config.ts` 启动；lint 与基线对比；build 后还原 `next-env.d.ts`
- 禁止修改的文件：`app/page.tsx`（除非发现阻断问题）、`tests/`、`package.json`
- 不在本批范围内的功能：任何新增交互

## W4 交接说明

- 开发顺序：搜索框容器 → 输入框 → 清除按钮 → 移动端媒体查询
- 并行任务的整合顺序：无
- 开发完成后需要执行的最小检查：`npm run build`，并在浏览器中查看
