export const meta = {
  name: 'bowen-hello-chain',
  description: '两步串联：先写中文问候，再翻译成英文',
  phases: [{ title: 'Write' }, { title: 'Translate' }],
}

phase('Write')
const chinese = await agent(
  '写一句包含"Bowen"的简短中文问候语。只输出这句话本身，不要引号、解释或其他内容。',
  { label: 'write-chinese', phase: 'Write', effort: 'low' }
)

phase('Translate')
const english = await agent(
  `把下面这句中文翻译成自然的英文。只输出译文本身，不要引号、解释或其他内容。\n\n${chinese}`,
  { label: 'translate-english', phase: 'Translate', effort: 'low' }
)

return { chinese, english }
