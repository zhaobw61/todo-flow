# W7 标记、沉淀与提交

## 目标

在 W6 全部测试通过后，更新当前 Feature 的任务状态和索引，提炼可复用的开发经验，并准备 Git 提交。

本节点可以整理提交内容，但只有获得用户明确允许后才能执行 `git commit`，不得自动执行 `git push`。

## 输入

- 当前 Feature 的 `requirements.md`、`design.md` 和 `tasks.md`；
- W3 生成的 `current-batch.md`；
- W4 生成的 `development-report.md`；
- W5 生成的 `code-review-report.md`；
- W6 生成的 `test-report.md`；
- 当前 `specs/INDEX.md`；
- 当前 Git 状态和 diff；
- 项目中的 `AGENTS.md`。

## 执行步骤

1. 确认 W6 的全部验收场景已经通过；
2. 只把本批已验证通过的任务从 `[ ]` 更新为 `[x]`；
3. 检查当前 Feature 是否还有未完成任务；
4. 更新 `specs/INDEX.md` 中的 Feature 状态；
5. 从开发、审查和测试过程提炼可复用经验；
6. 将经过验证且不重复的经验写入相关 `AGENTS.md`；
7. 检查 Git diff，确认没有无关文件、敏感信息或意外修改；
8. 整理建议提交的文件和 commit message；
9. 请求用户确认是否执行 Git 提交；
10. 用户同意后，只提交本 Feature 相关文件，不执行 `git push`。

## 经验沉淀规则

只有同时满足以下条件的经验，才允许写入 `AGENTS.md`：

- 已经在本次开发或测试中得到验证；
- 后续开发任务仍可能重复遇到；
- 能形成明确、可执行的规则；
- 不包含账号、密钥、个人信息或临时环境信息；
- 不是只适用于当前一次 Feature 的细节。

写入前先搜索已有规则：

- 已有相同规则：不重复添加；
- 已有相近规则：更新原规则；
- 模块专用经验：写入距离该模块最近的 `AGENTS.md`；
- 全项目通用经验：写入项目根目录的 `AGENTS.md`；
- 每个开发批次最多沉淀 3 条经验。

## 输出

在当前 Feature 目录生成 `completion-report.md`，至少记录：

- 本批标记完成的任务；
- 当前 Feature 剩余的未完成任务；
- `specs/INDEX.md` 的更新结果；
- 写入 `AGENTS.md` 的经验；
- 本次涉及的文件列表；
- 建议的 commit message；
- 用户是否允许提交；
- 如果已提交，记录 commit SHA；
- 如果未提交，记录当前 Git 状态。

## 路由规则

- 如果当前 Feature 还有 `[ ]` 任务，返回 W3 领取下一批任务；
- 如果当前 Feature 已没有未完成任务，将 Feature 标记为完成并进入 W8；
- 如果用户不同意 Git 提交，保留未提交状态并记录，不得强行提交；
- Git 提交是否执行，不影响后续交付，但必须明确说明当前状态。

## 完成条件

- 只标记了经过 W6 验证通过的任务；
- 已正确更新 `tasks.md` 和 `specs/INDEX.md`；
- 经验沉淀符合规则且不重复；
- 已检查 Git diff 和敏感信息；
- 已生成 `completion-report.md`；
- 已根据剩余任务数量选择 W3 或 W8。

## 停止条件

出现以下情况时暂停并报告：

- W6 尚未全部通过；
- 无法确认某个任务是否应该标记完成；
- Git diff 中存在无关修改或敏感信息；
- 需要覆盖或删除用户已有修改；
- `AGENTS.md` 中的规则互相冲突；
- Git 提交失败或提交范围无法确定。

不得为了完成 W7 而自动执行 `git push`。
