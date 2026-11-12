export const meta = {
  name: 'bowen-hello-parallel',
  description: '并行示例：两个 agent 分别用中文和英文向 Bowen 问好',
  phases: [{ title: 'Greet' }],
}

phase('Greet')
const [chinese, english] = await parallel([
  () => agent(
    '用中文写一句向 Bowen 问好的简短问候语。只输出这句话本身，不要引号、解释或其他内容。',
    { label: 'greet-chinese', phase: 'Greet', effort: 'low' }
  ),
  () => agent(
    'Write one short greeting to Bowen in English. Output only the greeting itself, with no quotes, explanation, or anything else.',
    { label: 'greet-english', phase: 'Greet', effort: 'low' }
  ),
])

return { chinese, english }
