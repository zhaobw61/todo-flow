# W5 Codex 代码审查

## 目标

Claude 完成本批开发后，通过 Codex CLI 对工作区代码改动进行一轮独立审查。

Codex 只负责发现问题并提出修改建议；Claude 根据审查结果判断并修复，然后进入 W6 自动化测试。

## 输入

- 当前 Feature 的 `requirements.md` 和 `design.md`；
- W3 生成的 `current-batch.md`；
- W4 生成的 `development-report.md`；
- 当前工作区的 Git diff；
- 与本批任务相关的 `AGENTS.md`；
- 本批任务的验收标准和验证方法。

## 执行步骤

1. 检查 Git 改动中是否包含密码、密钥或其他敏感信息；
2. Claude 在项目根目录调用 Codex CLI：

   ```bash
   codex review --uncommitted
   ```

3. Codex 根据 Feature 规格、验收标准和当前代码改动进行审查；
4. Codex 输出具体问题、文件位置、严重程度和修改建议；
5. Claude 判断审查意见是否成立，并修复确认存在的问题；
6. 对修复后的代码执行基础检查；
7. 记录审查结果，然后进入 W6 自动化测试。

本节点只进行一轮 Codex 审查。Claude 修复后不再重复调用 Codex。

## 输出

在当前 Feature 目录生成 `code-review-report.md`，至少记录：

- Codex 是否发现问题；
- 每个问题的严重程度和文件位置；
- Codex 的修改建议；
- Claude 是否接受该意见；
- 接受或拒绝的理由；
- Claude 实际完成的修复；
- 修复后执行的基础检查及结果；
- 是否可以进入 W6。

## 路由与完成条件

满足以下条件时进入 W6：

- 已完成一轮 Codex 审查；
- 审查结果已记录到 `code-review-report.md`；
- Claude 已处理确认成立的问题；
- 修复后的基础检查通过；
- 不存在尚未解决的严重问题。

如果审查发现需求或设计不明确，返回 W2；如果需要重新开发当前任务，返回 W4。

## 停止条件

出现以下情况时暂停并报告：

- Git 改动中包含密码、密钥或敏感信息；
- Codex CLI 无法正常运行；
- Codex 发现严重问题，但无法在当前任务范围内修复；
- 审查建议要求扩大 Feature 范围；
- Claude 无法判断某条审查意见是否正确。

停止时说明问题、影响以及需要用户决定的内容。
