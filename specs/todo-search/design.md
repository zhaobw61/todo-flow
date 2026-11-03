# 设计：按任务名称搜索

## 当前相关代码

- `app/page.tsx`：单文件客户端组件 `Home`，状态 `todos`、`filter`、`input`、`ready`、`announcement`；`visibleTodos` 由 `useMemo` 根据 `filter` 派生；空状态根据 `todos.length` 区分两种文案。
- `app/globals.css`：`.toolbar`、`.filters`、`.empty-state` 等样式（含移动端媒体查询）。

## 准备修改的文件

- `app/page.tsx`
- `app/globals.css`

## 数据结构和状态变化

- 新增 `const [query, setQuery] = useState("")`，仅存在于内存；
- `normalizedQuery = query.trim().toLocaleLowerCase()`；
- `visibleTodos` 依赖 `[filter, todos, normalizedQuery]`：先按状态筛选，再在 `normalizedQuery` 非空时保留 `title.toLocaleLowerCase().includes(normalizedQuery)` 的任务；
- `todos` 数据结构、`STORAGE_KEY` 和持久化逻辑不变；进度与统计仍使用 `todos`。

## 实现方案

1. 在 `.toolbar` 上方新增 `.search-box`：`<label className="sr-only" htmlFor="todo-search">搜索任务</label>` + `<input type="search" id="todo-search">`，`placeholder="搜索任务名称"`；
2. `query` 非空时渲染「清除搜索」按钮（`type="button"`，`aria-label="清除搜索"`），点击后 `setQuery("")` 并把焦点还给搜索框；
3. 搜索框 `onKeyDown` 中按 `Escape` 清空；
4. 空状态分三种：清单为空 → 原文案；有搜索词且无结果 → 「没有找到匹配的任务」+「换个关键词或清除搜索试试。」；其余 → 原「这里没有任务」；
5. 新增一个只播报搜索结果的 `role="status"` 区域（或复用 announcement），内容如「找到 N 项匹配任务」，仅在搜索词非空时显示；
6. 样式：搜索框沿用 `.add-form input` 的视觉语言，宽度 100%、`min-width: 0`，清除按钮触控尺寸 ≥ 40px；移动端无横向溢出。

## 风险

- 浏览器原生 `type="search"` 自带清除图标，与自定义按钮重复 → CSS 隐藏 `::-webkit-search-cancel-button`；
- 删除任务后焦点移动逻辑基于全部 `todos` 的下一项，可能指向当前不可见的任务 → 本次在删除焦点逻辑中改为基于 `visibleTodos` 选择下一项，找不到时回到搜索框/新增输入框；
- 现有 `tests/rendered-html.test.mjs` 断言 starter 骨架页，与当前项目不符（W1 发现，属于既有问题，不在本 Feature 范围内修复，W6 以浏览器验收为准）。

## 测试方案

- 静态检查：`npm run lint`；构建：`npm run build`；
- 浏览器自动化：启动 `npm run dev`，按 requirements 中 AC1–AC10 逐条操作验证，并检查 390px 宽度与控制台。
