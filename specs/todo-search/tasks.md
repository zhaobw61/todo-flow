# 任务：按任务名称搜索

- [x] T1 搜索逻辑、搜索框与交互（page.tsx）
  - 内容：新增 `query` 状态；`visibleTodos` 叠加名称搜索（trim + 不区分大小写）；搜索输入框 + 可访问标签；清除按钮与 Esc 清除；无结果空状态；结果数量播报；删除焦点逻辑改为基于可见列表
  - 依赖：无
  - 文件：`app/page.tsx`
  - 验证：AC1–AC9；`npm run lint` 通过

- [ ] T2 搜索框样式与移动端适配（globals.css）
  - 内容：`.search-box` 样式、隐藏原生清除图标、清除按钮触控尺寸、390px 下无横向滚动
  - 依赖：T1
  - 文件：`app/globals.css`
  - 验证：AC10、AC11

执行顺序：T1 → T2（存在依赖，Claude 串行开发）。
