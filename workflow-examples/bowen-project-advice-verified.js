export const meta = {
  name: 'bowen-project-advice-verified',
  description: '只读检查 TodoList 项目，逐项核对事实，再基于已核对的事实提出建议',
  phases: [{ title: 'Inspect' }, { title: 'Verify' }, { title: 'Advise' }],
}

const READ_ONLY_RULES = `
严格只读：
- 不创建、修改或删除任何文件
- 不安装依赖（不运行 npm install 等）
- 不运行项目脚本或检查命令（不运行 npm run *、npx eslint、npx tsc、node --test 等）
- 不执行任何 Git 写入操作（不 add、commit、checkout、stash、push 等）
- 只用读取类操作：读文件、列目录、搜索文本`

// ---------- 第 1 步 Inspect：只收集事实 ----------
phase('Inspect')
const projectFacts = await agent(
  `检查当前 TodoList 项目（即当前工作目录），整理成一份事实清单。

需要阅读：
- package.json
- AGENTS.md（请实际读取这个文件）
- 项目根目录结构（看目录和文件名即可，不必深入 node_modules 或构建产物）
- .claude/commands/bowen/feature.md
- yd-ai-nodes/ 下的所有工作流文件（README.md 和 w1-w8）

按以下四个小标题输出：
1. 技术栈：框架、语言、构建工具、数据库、部署等，注明信息来自哪个文件
2. 已有检查命令：package.json 里的脚本，以及文档里提到的已知问题（注明出自哪个文件）
3. 已有工作流：W1-W8 各阶段做什么，feature.md 如何串起它们
4. 尚不确定的信息：读不到、文件之间互相矛盾、或只能推测的内容

只输出事实，不要提出任何改进建议。推测的内容一律放进第 4 部分。
${READ_ONLY_RULES}`,
  { label: 'inspect-project', phase: 'Inspect', effort: 'low' }
)

// ---------- 第 2 步 Verify：逐项核对 ----------
phase('Verify')
const verifiedFacts = await agent(
  `下面是另一个 agent 对当前 TodoList 项目整理的事实清单，其中可能有错漏：

<projectFacts>
${projectFacts}
</projectFacts>

请实际读取相关源文件，逐项核对这份清单。

优先核对以下四项：
1. typecheck 脚本：package.json 里是否存在 typecheck 或 tsc 相关脚本；W8 节点文件对"类型检查"的原文要求是什么。
2. lint 问题：
   - 先读取 AGENTS.md，确认它是否记录了 lint 相关问题，以及具体记录了哪些（引用原文）。不要预设它记录了什么。
   - 再针对它实际记录的每个问题，读取相关的配置和代码，判断导致问题的配置或代码现在是否仍然存在。
   - 至少读取 package.json 的 lint 脚本。ESLint 配置优先读 eslint.config.mjs；如果它不存在，在项目根目录查找实际使用的 ESLint 配置文件（如 eslint.config.*、.eslintrc*、package.json 里的 eslintConfig），并写明找到的是哪个文件。
3. 工作流路由：对比 yd-ai-nodes/README.md 和 .claude/commands/bowen/feature.md 中的路由，列出两边各自有、对方没有的路由。
4. W2 的需求分析 Skill：
   - 读取 yd-ai-nodes/w2-spec.md 中引用这个 Skill 的原文。
   - 在 .claude/ 目录（包括 skills、commands 等子目录）和 ~/.claude/skills/ 中查找对应的 Skill。
   - 在证据里明确列出实际搜索过的每个目录和使用的搜索方式（如文件名匹配、内容关键词）。
   - 如果没有找到，结论只能写"在上述搜索范围内未发现"，不能断言这个 Skill 在所有来源中都不存在（例如插件、其他配置目录可能提供 Skill）。

然后再核对清单中的其他事实。

每一项按以下格式输出：
- 事实：要核对的内容
- 状态：已确认 / 需纠正 / 未确认
- 证据：文件路径，以及相关原文或配置片段（直接引用）
- 结论：核对得出的结论；状态为"需纠正"时，写出正确的内容

重要区分：
- "文档记录了某个问题"和"这个问题现在仍然存在"是两件事，要分开写。
- 本次不运行任何检查命令，所以不能声称 lint 或类型检查"通过"或"失败"。只能说导致问题的配置或代码"仍然存在"或"已不存在"。
- 找不到证据时标为"未确认"，不要猜测。
${READ_ONLY_RULES}`,
  { label: 'verify-facts', phase: 'Verify', effort: 'medium' }
)

// ---------- 第 3 步 Advise：只基于核对结果提建议 ----------
phase('Advise')
const advice = await agent(
  `下面是对当前 TodoList 项目逐项核对后的事实：

<verifiedFacts>
${verifiedFacts}
</verifiedFacts>

请只基于这份核对结果，提出最多三条最值得优先改进的开发工作流建议，按优先级从高到低排列。

每条建议包含：
- 建议：一句话说明改什么
- 依据：引用核对结果中状态为"已确认"或"需纠正"（以纠正后的内容为准）的具体事实
- 改进方法：具体怎么做

要求：
- 状态为"未确认"的内容不能作为建议的主要依据；如果确实要提到，必须标注为待确认的前提
- 依据不足时可以少于三条，不要凑数
- 不要声称 lint 或类型检查当前通过或失败，因为没有运行过这些命令
- 只提建议，不要动手实施，也不要读取或修改任何文件
${READ_ONLY_RULES}`,
  { label: 'advise-workflow', phase: 'Advise', effort: 'medium' }
)

return { projectFacts, verifiedFacts, advice }
