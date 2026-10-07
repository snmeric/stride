export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'
export type PlanSubstep = { title: string; status: StepStatus }
export type PlanStep = { title: string; status: StepStatus; substeps: PlanSubstep[] }
export type PlanStage = { name: string; steps: PlanStep[] }
export type PlanState = 'running' | 'needs_input' | 'error' | 'done'
// one subagent shown as a state strip under a bar; depth 1 sits under its parent agent
export type AgentRun = {
  id: string
  title: string
  state: 'running' | 'waiting' | 'done' | 'error'
  tool: string
  startedAt: number
  endedAt: number | null
  depth: number
}
// one rate-limit window: percent used and when it resets
export type Limit = { kind: string; used: number; resetsAt?: string }
export type Plan = {
  id: string
  title: string
  kind: 'plan' | 'todo'
  stages: PlanStage[]
  state: PlanState
  note: string | null
  startedAt: number
  agents?: AgentRun[]
  // when the current batch of agents all finished; their strips fold a few seconds later
  agentsDoneAt?: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'stride': {
      plans: Plan[]
      isOpen: boolean
      // bumped every second while agents run, so elapsed times and folding redraw
      tick: number
      // the 5 hour and weekly windows, from the engine's rate-limit figures (empty off a subscription)
      limits: Limit[]
    }
  }
}
