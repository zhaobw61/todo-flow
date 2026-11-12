# 设计：按完成状态筛选

## 当前相关代码

以下能力均为代码中已有实现（未验收）：

- `app/page.tsx`
  - 第 5 行：`type Filter = "all" | "active" | "completed";`
  - 第 6 行：`type Todo = { id: string; title: string; completed: boolean };`，筛选依据为 `completed` 字段；
  - 第 29–33 行：`filterLabels`，`all → 全部`、`active → 待完成`、`completed → 已完成`；
  - 第 38 行：`const [filter, setFilter] = useState<Filter>("all");`，默认「全部」，仅存在于内存；
  - 第 67–75 行：`visibleTodos`（`useMemo`），第 69 行按 `!todo.completed` 筛选「待完成」，第 70 行按 `todo.completed` 筛选「已完成」，第 71–73 行再叠加名称搜索；依赖 `[filter, todos, normalizedQuery]`；
  - 第 77–79 行：`completedCount`、`remainingCount`、`progress` 基于全部 `todos` 计算，不受筛选影响；
  - 第 200–213 行：`.toolbar` 内的筛选按钮组，第 201 行 `role="group" aria-label="筛选任务"`，第 202 行按 `filterLabels` 的键顺序渲染，第 206 行选中时 `className="filter active"`，第 207 行 `aria-pressed`，第 208 行 `onClick={() => setFilter(value)}`；
  - 第 98–111 行：`deleteTodo` 基于 `visibleTodos` 选择删除后的焦点目标；
  - 第 258–272 行：空状态，按以下优先级显示：全部任务为空时显示「清单还是空的」/「在上方输入一件想完成的事吧。」（第 262–263、267–268 行，对应 AC14）；否则有搜索词时显示「没有找到匹配的任务」/「换个关键词或清除搜索试试。」；否则显示「这里没有任务」/「换个筛选条件看看。」（第 264、269 行，对应 AC8）；
  - 第 90–96 行：`toggleTodo` 只更新 `todos` 和播报文案，没有焦点处理；对比第 105–110 行，`deleteTodo` 会用 `requestAnimationFrame` 转移焦点。`toggleTodo` 没有焦点处理导致的焦点丢失已在 T6-REPRO 中两次复现（W6 r20261111-w6r5、r20261111-w6r6：焦点落到 `body`），由 T6 按 AC16 修复（见「准备修改的文件」）；
  - 第 44 行：`todoRefs`（`Map<id, HTMLInputElement>`），已有的复选框引用；第 201–212 行的筛选按钮目前没有 ref；
  - 第 36、46–63 行：`todos` 的读取和保存只涉及任务数组，不涉及 `filter`。
- `app/globals.css`
  - 第 66 行：`.toolbar` 布局；
  - 第 67 行：`.filters`（`flex-wrap: wrap`）；
  - 第 68 行：`.filter` 基础样式（与 `.clear-button` 共用）；
  - 修改前第 69 行（T7 修改前的基准，见 HEAD 版本）：`.filter:hover, .filter.active` 选中/悬停高亮为同一套样式；当前工作区已拆分为两条：第 69 行 `.filter:hover`、第 70 行 `.filter.active`（`app/globals.css:69-70`，见「准备修改的文件」）；
  - 修改前第 97–109 行（当前第 98–110 行）：`@media (max-width: 600px)`，其中修改前第 106 行（当前第 107 行）`.toolbar` 在窄屏下改为纵向排列。
- `pages/main.tsx`
  - 第 3、14 行：直接渲染 `app/page.tsx` 的 `Home`，不含筛选逻辑；第 4 行引入 `app/globals.css`。浏览器验收按 `AGENTS.md` 使用 `npx vite --config vite.pages.config.ts --port <端口>` 启动此入口。

## 准备修改的文件

本次唯一的业务代码改动：按 code-review-report.md S1-2 的用户决定，拆分 `app/globals.css` 第 69 行的 `.filter` 规则（由 tasks.md 的 T7 在 W4 中执行，W2 只写进规格）。`app/page.tsx` 和其他样式规则不修改。

修改前第 69 行（T7 修改前的基准；当前工作区已按下方规则拆分为 `app/globals.css:69-70`）：

```css
.filter:hover, .filter.active { border-color: var(--forest); background: var(--forest); color: white; }
```

计划改为：

```css
.filter:hover { border-color: var(--forest); background: #eef1ea; color: var(--forest); }
.filter.active { border-color: var(--forest); background: var(--forest); color: white; }
```

- `.filter.active` 的三条声明与原规则完全相同；
- `#eef1ea` 是项目中已有的浅绿色（第 64 行 `.search-clear:hover`），不新增颜色变量；
- 两条选择器优先级相同（0,2,0），`.filter.active` 写在后面，因此悬停在已选中按钮上时仍是深绿底白字。

其余文件只涉及 `specs/todo-status-filter/` 下的规格文档和 `specs/INDEX.md` 登记。如果后续验收发现现有实现不满足其他验收标准，应先暂停并与用户确认，再决定是否新增修复任务；不在本规格中预先安排其他修改。

T6（用户 2026-11-11 决定 D-T6-fix，AC16）的最小修改——上文"`app/page.tsx` 不修改"的唯一例外：

- 只修改 `app/page.tsx`；不修改 `app/globals.css`（T7 的已有修改保持原样）及其他任何文件；
- 不改变 `deleteTodo`、`clearCompleted`、筛选、搜索、统计、持久化和其他行为。

## 数据结构和状态

- 筛选状态：`filter: Filter`，取值 `"all" | "active" | "completed"`，初始值 `"all"`，由 `setFilter` 更新，不持久化；
- 派生数据：`visibleTodos = todos` →（按 `filter` 过滤）→（按 `normalizedQuery` 过滤）；
- 任务数据 `Todo` 结构、`STORAGE_KEY` 和持久化逻辑不变；
- 统计（进度、待完成数、底部统计）始终基于 `todos`，不随筛选变化。

## 实现方案

已有实现，本次补规格和验收，另按 S1-2 的用户决定做一处最小样式修改：

1. 核对上文列出的代码位置，确认其行为与 `requirements.md` 的 AC1–AC11 在逻辑上对应；
2. 核对样式与窄屏规则，确认与 AC12 在逻辑上对应；
3. 按「准备修改的文件」拆分 `app/globals.css` 第 69 行的 `.filter` 规则（T7），使未选中按钮悬停为浅绿底深绿字、选中按钮保持深绿底白字（AC6、AC15）；
4. 在后续节点按 `AGENTS.md` 启动页面，在 T7 修改后的样式上逐条实际操作 AC1–AC12、AC14、AC15，并执行 AC13 的构建与 lint 基线对比；
5. T6（AC16）焦点修复，只改 `app/page.tsx`：
   - 在 `toggleTodo` 中，依据切换前的 `visibleTodos`、当前 `filter` 和搜索词，判断该项切换后是否仍留在当前视图（「全部」视图始终留下；「待完成」中勾选、「已完成」中取消勾选则离开）；
   - 留在视图时不移动焦点（焦点保持在该项复选框）；离开视图时按 AC16 选出焦点目标：原位置的下一项复选框 → 没有下一项时上一项复选框 → 视图变为空时，有搜索词则为搜索框（`searchRef`），没有搜索词则为当前选中的筛选按钮；
   - 把目标记入一个待处理焦点的 ref（如 `pendingFocusRef`），在渲染提交后执行的 Effect（依赖 `visibleTodos`）中消费该 ref 并聚焦目标后清空：复选框用已有的 `todoRefs`，筛选按钮新增一个按 `Filter` 取元素的 ref；
   - 不使用 `setTimeout` 等任意延时；不改变 `deleteTodo`、`clearCompleted` 及其他行为；
6. 完成标准按任务类型区分（见 tasks.md 说明）：静态核对任务以形成逐条对应记录、且记录已按审查意见更正为准；开发任务以修改完成并静态核对 diff 范围、且在 T3 中实际检查为准；运行验收任务和复现任务以实际执行并记录结果为准。

## 可能的风险

- 文案差异：需求原文为「未完成」，界面为「待完成」。已在 requirements 中作为默认决定记录；若用户坚持使用「未完成」，需要另起修改任务。
- 未经验收：尚未找到现有实现此前对应的规格和验收记录，实际行为可能与代码阅读得出的预期不一致。
- 运行方式：`npm run dev` 会导致 `GET /` 返回 500（见 `AGENTS.md`），浏览器验收必须使用 vite 配置启动。
- lint 基线：`npm run lint` 基线本身不通过，需用 `npx eslint app` 并与基线对比，只关注新增错误。
- 构建副作用：`npm run build` 会改写 `next-env.d.ts`，应先保存构建前内容并比较差异，仅撤销本次构建产生的变化，保留用户原有修改，不能直接丢弃整个文件的改动。
- 验收产物：Playwright MCP 会在仓库根目录生成 `.playwright-mcp/`，不能提交。
- 既有测试：`tests/rendered-html.test.mjs` 可能与当前页面不符（既有问题，不在本功能范围内）。
- 悬停与选中样式（code-review-report.md S1-2）：已决定拆分 `app/globals.css:69` 的规则（见「准备修改的文件」、T7）。剩余风险：触屏设备点击后可能残留 `:hover` 样式，使刚离开的按钮暂时呈浅绿色；这不影响选中按钮的深绿底白字，需在 T3/T4 中观察并记录，不预先处理。另外 T7 只改一条规则，若 diff 涉及其他样式或 `page.tsx`，视为超出范围。
- 键盘焦点（code-review-report.md S1-3）：已复现。W6 r20261111-w6r5、r20261111-w6r6 只用键盘在「待完成」「已完成」视图中切换完成状态后，焦点落到 `body`（证据见 `reports/batch-03/W6-test-r20261111-w6r6-1.md` 第 5 节，保留不动）；按用户决定 D-T6-fix 由 T6 修复（AC16）。剩余风险：焦点 Effect 若在 `visibleTodos` 之外的渲染中消费 ref 或目标元素尚未挂载，可能聚焦失败；修改须控制在 `app/page.tsx`，不得影响 `deleteTodo` 的既有焦点逻辑。

## 测试方案

只写计划，本次未执行：

- 代码核对：对照「当前相关代码」中的行号逐项阅读，记录与 AC 的对应关系；
- 样式修改核对（T7）：`git diff app/globals.css` 只涉及第 69 行的 `.filter` 规则，`.filter.active` 的声明未变，`.filter:hover` 的声明符合 AC15；
- 浏览器验收：在 T7 修改后，用 `npx vite --config vite.pages.config.ts --port <端口>` 启动，使用独立浏览器测试上下文，从默认 3 项任务开始，不清空用户现有浏览器数据，按 AC1–AC11、AC14 逐条操作并记录结果；
- 悬停检查（AC15）：在 T3 中把鼠标悬停在未选中按钮上，读取其计算样式（背景应为 `#eef1ea` 即 `rgb(238, 241, 234)`，文字和边框为 `--forest` 的颜色），同时确认选中按钮仍为深绿底白字、所有按钮的 `aria-pressed` 未变；再悬停在已选中按钮上，确认仍为深绿底白字；
- 响应式：将视口设为 390px 宽，检查 AC12，并查看控制台；
- 构建与静态检查：执行 `npm run build`（构建前保存 `next-env.d.ts` 内容，之后仅撤销本次构建产生的变化），执行 `npx eslint app` 并与基线对比（AC13）；
- 全局空清单：在独立测试上下文中删除全部任务，切换三种筛选，确认 AC14 的文案；
- 键盘焦点（T6，AC16）：W6 只用键盘重新执行 T6-REPRO 并逐条验证 AC16，覆盖「待完成」「已完成」视图、连续多次切换、视图变为空且有/无搜索词，每次操作后记录 `document.activeElement` 及再按 Tab/Shift+Tab 后的焦点位置；并回归 AC1–AC11、AC14、AC15 与 AC13（构建、lint 相对 HEAD 基线）。（原计划"按 T6 只用键盘复现、不修改代码"已由 W6 r20261111-w6r5、r20261111-w6r6 执行，结论为已复现。）
