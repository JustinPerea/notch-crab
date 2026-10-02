// What the mod sends the bridge for one event: pure, no `$`, so test/mod.test.mjs posts exactly these bodies to a real bridge.
//
// Only the fields the bridge reads (HOOK_FIELDS in tools/bridge.mjs) leave Claude Code: no prompt, no tool input or output, no
// transcript path. cwd goes whole, and the bridge cuts it to its folder name. A PostToolBatch also says how many tools it closed
// (tool_calls_count, a number as a string), never which. tool_input is left out on purpose: the bridge reads
// it from settings hooks only to match the notch app's held permission prompts, and the mod does not drive approvals (yet).

export const FIELDS = ['hook_event_name', 'session_id', 'tool_name', 'cwd', 'notification_type', 'tool_use_id', 'agent_id'];
export const PLAIN = 'claude';   // the bridge preset of the plain orange crab (engine/wardrobe.js PRESETS)

// name: the classic event's name; e: its input; session: { id, cwd } for PreToolUse, whose input is the tool call's envelope
// ({ tool, tool_use_id, ...input }) with no session fields; preset: the look to start in, or undefined to let the bridge choose;
// show: the mod's option ('both', 'notch' or 'prompt'), sent with every session's body: 'prompt' keeps the session off the notch, any
// other value puts it back, and a body with no show (a curl settings hook) leaves the bridge's state as it is. So turning "prompt only"
// off brings the crab back on the session's next hook.
export function bodyOf(name, e, session, preset, show) {
  const f = { hook_event_name: name };
  if (name === 'PreToolUse') Object.assign(f, { session_id: session && session.id, cwd: session && session.cwd, tool_name: e.tool, tool_use_id: e.tool_use_id });
  else for (const k of FIELDS) if (typeof e[k] === 'string') f[k] = e[k];
  if (name === 'PostToolBatch' && Array.isArray(e.tool_calls)) f.tool_calls_count = String(e.tool_calls.length);   // how many tools ran, never the calls: the notch juggles only for several
  for (const k of Object.keys(f)) if (typeof f[k] !== 'string') delete f[k];
  if (preset && f.session_id) f.preset = preset;
  if (typeof show === 'string' && show && f.session_id) f.show = show;
  return f;
}

// MessageDisplay fires once per batch of streamed lines (dozens a reply); the notch's Chatterbox is a loop that runs until the next
// hook, so one per assistant message is the cue. The key says "same message": the session and its message_id.
export const messageKey = (e) => `${e.session_id || ''}\u0000${e.message_id || ''}`;

// Events that may go past a full queue (a slow bridge): the ends of things, so the crab is never left mid-pose when it recovers.
export const LANDMARKS = new Set(['Stop', 'StopFailure', 'SessionEnd', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop']);
