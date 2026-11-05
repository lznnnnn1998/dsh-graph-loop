/** Proves design/kernel.ts is consumable by the loop design without kernel types. */
import {
  createGraph, InTurnCheckpointer, START, END,
  type JsonValue, type NodeContext, type RunResult,
} from '../../design/kernel.ts'

/** A DSH loop state. An interface — proves the state generic accepts one. */
interface LoopState {
  turn: number
  step: number
  toolCalls: number
  messages: string[]
  gate?: string
}

const graph = createGraph<LoopState>({
  name: 'react-dsh',
  initialState: { turn: 0, step: 0, toolCalls: 0, messages: [] },
})
  .addNode('model', async (ctx: NodeContext<LoopState>) => ({
    step: ctx.step + 1,
    messages: [...ctx.state.messages, `model@${ctx.step}`],
  }), { retry: { maxAttempts: 3 } })
  .addNode('tools', (ctx) => ({
    toolCalls: 0,
    messages: [...ctx.state.messages, `tools:${ctx.state.toolCalls}`],
  }))
  .addNode('gate', async (ctx) => {
    // C4: pure up to the pause point — no side effects above this line.
    const answer = await ctx.interrupt<string>({ question: 'ship it?' })
    return { gate: answer }
  })
  .addNode('finish', () => ({ step: 0 }))
  .addEdge(START, 'model')
  .addConditionalEdge('model', (s) => (s.toolCalls > 0 ? 'tools' : 'gate'), ['tools', 'gate'])
  .addConditionalEdge('tools', () => 'model', ['model'])
  .addEdge('gate', 'finish')
  .addEdge('finish', END)
  .compile({ checkpointer: new InTurnCheckpointer<LoopState>(), maxSteps: 64 })

async function run(): Promise<void> {
  const result: RunResult<LoopState> = await graph.invoke({ turn: 1 }, {
    threadId: 'session-abc',
    onBoundary: (b) => { void b.next },
  })
  const chunk: JsonValue = { status: result.status, steps: result.steps }
  for await (const ev of graph.stream({ turn: 2 }, { threadId: 'session-abc' })) {
    if (ev.type === 'custom') void ev.chunk
  }
  void chunk
}
void run
