export const meta = {
  name: 'bowen-hello-pipeline',
  description: '流水线示例：每种语言先写问候，再翻译成英文',
  phases: [{ title: 'Write' }, { title: 'Translate' }],
}

const languages = ['中文', '日文']

const results = await pipeline(
  languages,

  // 第一步 Write：用这种语言写一句问候
  (language) => agent(
    `用${language}写一句向 Bowen 问好的简短问候语。只输出这句话本身，不要引号、解释或其他内容。`,
    { label: `write-${language}`, phase: 'Write', effort: 'low' }
  ),

  // 第二步 Translate：把上一步的问候翻译成英文
  async (greeting, language) => {
    const english = await agent(
      `把下面这句话翻译成自然的英文。只输出译文本身，不要引号、解释或其他内容。\n\n${greeting}`,
      { label: `translate-${language}`, phase: 'Translate', effort: 'low' }
    )
    return { language, greeting, english }
  },
)

return results
