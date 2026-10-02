// The HUD's figures, kept between events: pure reducers, no `$`, so register.mjs feeds them what Claude Code reports and the
// renderer (engine/hud.js, in ./engine.mjs) draws what they hold.
//
// Nothing here keeps a task's words: a list is { id, status } entries only, so no subject, description or todo text is held,
// drawn or sent anywhere (the HUD shows counts; the bridge's allowlist, wire.mjs, is untouched).

// A fresh HUD state: nothing measured, no task list.
export function hudState() {
  return {
    context: null,        // $.session.usage().context: { tokens?, window, percent? }
    threshold: undefined, autoCompact: undefined, windowFor: null,   // the breakdown's figures, and the window they were read for
    limits: [],           // the last rateLimits reported
    measured: false,      // a session.measure came in (only it: a plain usage() on a resumed session has the transcript's tokens, no limits yet)
    sawLimits: false,     // a five_hour or seven_day window was ever reported: a subscription, so an empty list is "not right now"
    since: {},            // engine/hud.js sinceOf: when each bar reached 100%
    tasks: [],            // [{ id, status }]: pending | in_progress | completed
    completedAt: null,    // when the list was last found all done (live), or long ago (replayed)
  };
}

const LONG_AGO = -1e15;   // a list replayed already finished: its gold flash is long over
const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const statusOf = (s) => (STATUSES.has(s) ? s : 'pending');
const isObj = (v) => v && typeof v === 'object';
const isLimitKind = (k) => k === 'five_hour' || k === 'seven_day';

// $.session.usage() (or session.measure's input) into the state. Returns true when it read a context or limits.
export function applyUsage(st, u, { measured = false } = {}) {
  if (!isObj(u)) return false;
  if (isObj(u.context) && typeof u.context.window === 'number') {
    const c = u.context;
    st.context = { window: c.window, ...(typeof c.tokens === 'number' ? { tokens: c.tokens } : {}), ...(typeof c.percent === 'number' ? { percent: c.percent } : {}) };
  }
  if (Array.isArray(u.rateLimits)) {
    st.limits = u.rateLimits.filter((l) => isObj(l) && typeof l.kind === 'string' && typeof l.percentUsed === 'number')
      .map((l) => ({ kind: l.kind, percentUsed: l.percentUsed, ...(typeof l.resetsAt === 'string' ? { resetsAt: l.resetsAt } : {}) }));
    if (st.limits.some((l) => isLimitKind(l.kind))) st.sawLimits = true;
  }
  if (measured) st.measured = true;
  return true;
}

// The breakdown's auto-compact figures ($.session.usage({ breakdown: 'summary' }).context.breakdown), read for this window.
export function applyBreakdown(st, u) {
  const c = isObj(u) && isObj(u.context) ? u.context : null, b = c && isObj(c.breakdown) ? c.breakdown : null;
  if (!c) return false;
  st.windowFor = typeof c.window === 'number' ? c.window : null;
  if (b) {
    st.autoCompact = b.isAutoCompactEnabled !== false;
    st.threshold = typeof b.autoCompactThreshold === 'number' ? b.autoCompactThreshold : undefined;
  }
  return true;
}
// whether the breakdown is due: never read, or read for another window (a model switch)
export const needsBreakdown = (st) => !!st.context && st.windowFor !== st.context.window;

// One answered tool call into the task list. tool: its name; input: what the model gave; result: the tool's record. agentId: set
// when a subagent made the call (its TodoWrite is its own list, not the session's). Returns the new list, or null: not a task call.
export function reduceTasks(list, tool, input, result, agentId) {
  const inp = isObj(input) ? input : {}, res = isObj(result) ? result : {};
  switch (tool) {
    case 'TodoWrite': {
      if (agentId) return null;
      const todos = Array.isArray(res.newTodos) ? res.newTodos : Array.isArray(inp.todos) ? inp.todos : null;
      if (!todos) return null;
      return todos.filter(isObj).map((t, i) => ({ id: `todo-${i}`, status: statusOf(t.status) }));
    }
    case 'TaskCreate': {
      const id = isObj(res.task) && res.task.id != null ? String(res.task.id) : null;
      if (!id) return null;
      const base = list.length && list.every((t) => t.status === 'completed') ? [] : list.filter((t) => t.id !== id);   // a new list after a finished one
      return [...base, { id, status: 'pending' }];
    }
    case 'TaskUpdate': {
      if (res.success !== true) return null;
      const id = String(res.taskId ?? inp.taskId ?? '');
      const to = (isObj(res.statusChange) && res.statusChange.to) || inp.status;
      if (!id || !to) return null;
      if (to === 'deleted') return list.filter((t) => t.id !== id);
      const known = list.some((t) => t.id === id);
      return known ? list.map((t) => (t.id === id ? { id, status: statusOf(to) } : t)) : [...list, { id, status: statusOf(to) }];
    }
    case 'TaskList': {
      if (!Array.isArray(res.tasks)) return null;
      return res.tasks.filter((t) => isObj(t) && t.id != null).map((t) => ({ id: String(t.id), status: statusOf(t.status) }));
    }
    case 'TaskGet': {
      const t = isObj(res.task) ? res.task : null;
      if (!t || t.id == null) return null;
      const id = String(t.id), known = list.some((x) => x.id === id);
      return known ? list.map((x) => (x.id === id ? { id, status: statusOf(t.status) } : x)) : [...list, { id, status: statusOf(t.status) }];
    }
    default: return null;
  }
}

// A transcript's tool uses ($.session.messages().flatMap(m => m.toolUses ?? [])) replayed into a list, errors skipped.
export function replayTasks(uses) {
  let list = [];
  for (const u of uses || []) {
    if (!isObj(u) || u.isError) continue;
    const next = reduceTasks(list, u.tool, u.input, u.result, undefined);
    if (next) list = next;
  }
  return list;
}

// done / total / active of a list (deleted entries are gone already)
export function taskCounts(list) {
  let done = 0, active = 0;
  for (const t of list) { if (t.status === 'completed') done++; else if (t.status === 'in_progress') active++; }
  return { done, total: list.length, active };
}

// Sets the list, keeping when it was found all done: now when it just got there live, LONG_AGO when replayed.
export function setTasks(st, list, now, { replayed = false } = {}) {
  const was = taskCounts(st.tasks), is = taskCounts(list);
  st.tasks = list;
  const allDone = is.total > 0 && is.done === is.total;
  if (!allDone) st.completedAt = null;
  else if (replayed) st.completedAt = LONG_AGO;
  else if (!(was.total > 0 && was.done === was.total) || st.completedAt == null) st.completedAt = now;
  return allDone && !replayed;
}

// The renderer's input (engine/hud.js figures). `measured` there means "measured, and knows there are no 5-hour or weekly windows":
// a subscription whose windows dropped for a moment (a reset passed; the engine reports it again with the next response) keeps
// row B with '--' rather than losing it.
export function hudInput(st) {
  const c = taskCounts(st.tasks);
  return {
    context: st.context, threshold: st.threshold, autoCompact: st.autoCompact, limits: st.limits,
    tasks: c.total > 0 ? { ...c, completedAt: st.completedAt } : null,
    measured: st.measured && !st.sawLimits, since: st.since,
  };
}
// whether a limit that is drawn has a clock that moves (a pace flag, a reset label): the terminal's slow timer runs only then. bars: the bars
// turned on ({ five_hour, seven_day } false: that limit is not drawn, so its clock moves nothing)
export const hasClockedLimits = (st, bars) => st.limits.some((l) => isLimitKind(l.kind) && !(bars && bars[l.kind] === false));
