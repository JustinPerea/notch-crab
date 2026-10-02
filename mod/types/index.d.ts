// The mod's contract: the one piece of state it keeps in the host (survives hot reloads), the band's last event.
declare module 'claude-code' {
  interface PluginState {
    'notch-crab': {
      band: { event: string; tool: string; at: number };
    };
  }
}
