# AGENTS.md

## 本地运行与测试

- 浏览器验收 TodoFlow 页面时，用 `npx vite --config vite.pages.config.ts --port <端口>` 启动。`npm run dev`（vinext）会把 `pages/main.tsx` 当作 Pages Router 页面做 SSR，抛出 `document is not defined`，`GET /` 返回 500。
- `npm run lint` 的基线本身不通过：它会扫描 `pages-dist/` 构建产物，并且 `app/page.tsx` 中读取 localStorage 的 Effect 会触发 `react-hooks/set-state-in-effect`。检查改动时用 `npx eslint app`，并与 `git stash` 后的基线对比，只关注新增错误。
- `npm run build` 会改写 `next-env.d.ts` 里的注释链接。提交前用 `git checkout -- next-env.d.ts` 还原，不要把它混进 Feature 提交。
