// one rate-limit window: percent used and when it resets
export type Limit = { kind: string; used: number; resetsAt?: string }
// a small sign the pixels gather into for a moment: which, on which window's meter, and when it appeared
export type Sign = { name: string; kind: string; at: number }
// one reading of a window, kept to estimate how fast it is being spent
export type Sample = { t: number; used: number }

declare module 'claude-code' {
  interface PluginState {
    'stride': {
      isOpen: boolean
      // the 5 hour and weekly windows, from the engine's rate-limit figures (empty off a subscription)
      limits: Limit[]
      // true while the main conversation's turn runs, so the meters show usage being spent
      busy: boolean
      // the sign on show (it fades by itself a few seconds after `at`)
      sign: Sign | null
    }
  }
}
