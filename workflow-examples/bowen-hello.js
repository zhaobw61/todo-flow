export const meta = {
  name: 'bowen-hello',
  description: '最小示例：一个 agent 输出问候语',
  phases: [{ title: 'Greet' }],
}

phase('Greet')
const greeting = await agent('只输出这句话，不要任何额外解释或标点变化：你好，Bowen！', {
  label: 'greet',
  phase: 'Greet',
  effort: 'low',
})
return greeting
