// notch-crab as a Claude Code mod: one module, loaded once per session, doing two jobs.
//
// 1. The notch. Every classic hook event goes to the bridge (tools/bridge.mjs) over its Unix socket, as POST /hook with the same
//    allowlisted fields the bridge reads from a curl hook (wire.mjs), so the notch crab reacts as it does to the settings hooks.
//    Fire-and-forget behind the event: Claude Code never waits on the bridge (SessionEnd waits up to a second, so it lands before
//    the process exits), and an absent bridge costs a refused connect.
// 2. The band above the prompt (ui.render AbovePrompt): the session's own crab in a bar the size of the notch's strip.
//    It runs the notch's engine (engine/band.js and every reaction, bundled into ./engine.mjs by tools/bundle-mod.mjs),
//    so it roams, naps and plays the same 33 reactions in the outfit the session wears in the notch (GET /style, a long poll).
//    - The Code tab (desktop): an Svg of the next seconds, the frames played by SMIL (engine/smil.js), drawn again when an event
//      changes them or they run out. Drawn as an image (no isInteractive): SMIL plays in an <img> too, and an image swaps cleanly.
//    - A terminal that shows images (kitty, Ghostty): an Image 2 rows tall, swapped by blit to a PNG of each frame that changed.
//    - Any other terminal: the small half-block Clawd of clawd.mjs and its caption, posed by the same events (a blit refused with
//      "the Image draws its alt here" is the cue).
//    - Beside the crab, the HUD (engine/hud.js): thin pixel bars for the context window (against auto-compact), the 5-hour and weekly
//      usage limits, and the task list when the session has one. A separate element, never composited into the crab's frames: the
//      Code tab's Svg beside the crab's Svg, a terminal's Raster beside the Image or the half-block Clawd. Its figures come from
//      $.session.usage() (free; at load, after each tool call) and session.measure (pushed after each turn), the task list from
//      TodoWrite / TaskCreate / TaskUpdate / TaskList / TaskGet results (hud-state.mjs; counts only, no task text is kept or sent).
//
// Options: outfit 'wardrobe' (default: the bridge's line-up and wardrobe dress the session) or 'plain' (the plain orange crab, here
// and in the notch); show 'both' (default), 'notch' (no band), or 'prompt' (the band only: the bridge keeps the session off the notch);
// hud 'on' (default: the bars beside the crab) or 'off' (the band exactly as before the HUD, and no usage reads at all); and which bars
// show while it is on, one switch each (all on by default): hudContext, hudFiveHour, hudWeekly, hudTasks. A bar turned off costs nothing:
// no usage read without the context and both limits, no breakdown without the context, no transcript replay without the task list. All
// four off is hud 'off'.
//
// Behaviour is untouched: every hook returns next(e) as it came, so settings hooks and Claude Code's own handling (worktrees,
// MessageDisplay, permission prompts) run exactly as without the mod. PermissionRequest is observed, never answered: the island's
// approvals still need the settings hooks (docs/approvals.md), and installing those beside the mod doubles every cue (README).
//
// `claude plugin validate` follows `$` statically: it may only be passed to functions declared at the top of this file, so the
// helpers below are top-level and share the per-load state through `ctx`.

import { COLS, ROWS, frameAt, caption } from './clawd.mjs';
import { bodyOf, messageKey, LANDMARKS, PLAIN } from './wire.mjs';
import { Band, BAND_H, MIN_W, bleed, toSvg, pngBase64, createCanvas, REACTIONS, TITLES, PRESETS, figures, sinceOf, hudSvg, hudTerm, HUD_MIN_W, HUD_MAX_W, DONE_MS } from './engine.mjs';
import { hudState, applyUsage, applyBreakdown, needsBreakdown, reduceTasks, replayTasks, setTasks, hudInput, hasClockedLimits } from './hud-state.mjs';

const MAX_QUEUE = 64;        // posts waiting on a slow bridge; past this new ones are dropped (LANDMARKS may use up to twice that)
const END_WAIT_MS = 1000;    // SessionEnd waits this long at most for its post: the session's teardown has 1.5 s for every hook
const TICK_MS = 125;         // the half-block Clawd's animation clock; a blit goes out only when the picture changes
const FRAME_MS = 50;         // the bar's clock in a terminal: the notch's own 20 steps a second; a blit goes out only when the pixels change
const REDRAW_MS = 100;       // events within this of each other redraw the band once (the Code tab's look-ahead costs ~0.1 s to build)
const AHEAD_WORKING = 4, AHEAD_IDLE = 12;   // seconds the Code tab's SVG looks ahead: short while a turn runs (the next event replaces it soon)
const SVG_MAX = 120_000;     // characters, under the Svg's 131072; a longer look-ahead is cut short and drawn again where it ends
const DESK_W = 320;          // the Code tab's bar, in units (1 CSS px each; the band scales it down in a narrower column)
const TERM_COLS = 40;        // the terminal bar at most, in columns of 8 units (320 units, the widest notch wing pair)
// the bar while the HUD is on: half the walk, so the bars sit by the crab. The gap between them is the part of the bar he isn't on, and at 320
// it ran to ~300 px as he roamed, however narrow the window was.
// Tied to the setting, not to a HUD drawn now: the task list alone comes and goes, and the crab would jump each time the bar's width did.
const DESK_HUD_W = 160, TERM_HUD_COLS = 20;
const NO_IMAGES = 'the Image draws its alt here';   // how a blit says this terminal draws no pictures (Claude Code 2.1.287)
const POLL_AGAIN_MS = 2000, POLL_DOWN_MS = 5000;    // GET /style: a session the bridge has not seen yet / no bridge at all
// events that restart their pose even when the same event repeats (each is a new beat: a new prompt, another success)
const RESTART = new Set(['UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStop', 'TaskCompleted']);
const TURN_ENDS = new Set(['Stop', 'StopFailure', 'SessionEnd']);
// PostToolBatch closes EVERY batch, one tool or many, in the same second as the last result (median 0 s in the bridge's log): the band's
// Juggler would replace Oops or Nailed It before either could play. So the band juggles only when several tools ran at once. The bridge
// still gets every batch, with how many tools it closed: it releases held permission prompts on it, and the notch juggles only for several.
const juggles = (e) => Array.isArray(e.tool_calls) && e.tool_calls.length > 1;
// The Code tab's HUD fills the room beside the crab, so it grows and shrinks with the window. The room is the band's bodyColumns times its
// 1ch: the renderer counts floor(content width / 1ch), measuring
// 1ch on the band itself, and the count follows the window because the band body is a block filling its grey box (the host's classes go through
// tailwind-merge, so its `block` beats the row style's `flex`). DESK_CH is a hair UNDER 1ch of the default
// band font (anthropic-sans 13 px: 7.84375 at 100% zoom, 7.8516 at 120%), so the room comes out short (8 px in a 768 px band at 120%) and the HUD never
// has to shrink. Fonts the mod cannot see: 12 px (7.23) overshoots by 8% and the HUD scales down evenly into the room (see desk()); the system font
// (8.19), OpenDyslexic (8.44) and 14 px (8.45) leave up to 8% of the band empty at its right end.
const DESK_CH = 7.84;
const DESK_HUD_BESIDE = 220;   // the least room for the HUD beside the crab (8 cells a limit); less, and it goes under him at the band's width
const HUD_W = 316;           // the Code tab's HUD when the band gives no column count
const HUD_COLS = 72, HUD_MIN_COLS = 16;   // a terminal's HUD at most / at least (narrower: no HUD)
// a terminal band's top-right corner is Claude Code's: its collapse mark `[-]` (3 columns, top row) is drawn over whatever is there, so
// the HUD stops this many columns short of the band's edge (the mark and a space). Seen in Ghostty 2026-10-02: it covered 7D's figure.
const HUD_CORNER = 4;
const HUD_SLOW_MS = 30_000;  // a terminal's HUD redrawn this often while limits exist, so pace flags and reset times move (nothing else redraws it)
// events after which the context may have moved without a session.measure (a tool call mid-turn, a compaction, a fresh start)
const HUD_REFRESH = new Set(['PostToolUse', 'PostCompact', 'SessionStart']);
const NEW_CONVERSATION = new Set(['clear', 'resume', 'fork']);   // SessionStart sources that start another conversation's task list
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
// a bar's switch (userConfig boolean, default true): off only when set false. Claude Code fills the default for an unset field and checks the
// type before the mod loads (a stored non-boolean fails the plugin's whole config), so a value here is a boolean or absent
const barOn = (v) => v !== false;

/** @type {import('claude-code').Register} */
export function register(on, options) {
  const o = options || {};
  // the bars a person chose to see, by engine/hud.js's keys; usage: whether any of them needs $.session.usage()
  const bars = { context: barOn(o.hudContext), five_hour: barOn(o.hudFiveHour), seven_day: barOn(o.hudWeekly), tasks: barOn(o.hudTasks) };
  const usage = bars.context || bars.five_hour || bars.seven_day;
  const ctx = {
    preset: o.outfit === 'plain' ? PLAIN : undefined,   // 'wardrobe' (the default): the bridge's line-up and wardrobe dress the session
    show: o.show === 'notch' || o.show === 'prompt' ? o.show : 'both',
    socketPath: undefined, queue: Promise.resolve(), queued: 0,
    lastMessage: null,   // the MessageDisplay message last sent on (messageKey)
    band: null,          // the last event { event, tool, at }, what the half-block Clawd poses by
    shown: null,         // { band, working, requestId }: what the half-block Clawd last drew from, for its timer
    timer: null, lastId: null,
    bar: null,           // the Band: the crab in the bar (both surfaces)
    style: o.outfit === 'plain' ? PRESETS.claude : null, tag: null, polling: false,
    images: true,        // until a blit says this terminal draws no pictures
    term: null,          // { requestId }: the terminal Image the bar's timer swaps
    barTimer: null, lastSig: null, lastAlt: null, lastPng: null, redrawing: null, deskTimer: null,
    // the HUD (null: hud 'off', every bar turned off, or no band at all): its figures (hud-state.mjs), the bars it shows and whether they read
    // the usage, where it is drawn ({ requestId, columns, cells, mounted } in a terminal, { svg } in the Code tab), and its timers
    hud: o.hud === 'off' || o.show === 'notch' || !(usage || bars.tasks) ? null : hudState(),
    bars, usage,
    hudSeeded: false, refreshing: false, refreshAgain: false, taskSeq: 0, hudTermSite: null, hudDeskSite: null, hudSlow: null, hudDone: null,
  };

  // the figures Claude Code pushes after each main-thread turn (and when a limit moves a point): observe only, and only for a bar that uses them
  if (ctx.hud && ctx.usage) on('session.measure', async ($, e, next) => {
    try { measure($, ctx, e); } catch {}   // the crab must never cost Claude Code an event
    return next(e);
  });

  on('classic.*', async ($, e, next) => {
    try { await observe($, ctx, next.event.slice('classic.'.length), e); } catch {}   // the crab must never cost Claude Code an event
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = e.props;   // a survey owns the band; the vscode and mobile surfaces have no band of this kind
    if (ctx.show === 'notch' || p.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e);
    const { value: band } = await $.state.get({ plugin: 'notch-crab', key: 'band' });   // subscribes this drawing to the next set
    const now = await $.clock.now();
    poll($, ctx, 1);
    seed($, ctx);
    if (e.surface === 'desktop') return desk($, ctx, e, next, now);
    if (ctx.images) { const tree = await bar($, ctx, e, next, now); if (tree) return tree; }
    return clawd($, ctx, e, next, band, now);
  });
}

// One event: to the bridge, then to the band.
async function observe($, ctx, name, e) {
  if (ctx.hud) hudEvent($, ctx, name, e);   // first, and never throws: the HUD must not cost the notch or the band their event
  const session = name === 'PreToolUse' ? { id: await $.session.id(), cwd: await $.session.cwd() } : null;
  const body = bodyOf(name, e, session, ctx.preset, ctx.show);
  const repeat = name === 'MessageDisplay' && messageKey(e) === ctx.lastMessage;
  if (name === 'MessageDisplay') ctx.lastMessage = messageKey(e);
  if (!repeat && await socketOf($, ctx)) {
    send($, ctx, body);
    if (name === 'SessionEnd') await Promise.race([ctx.queue, $.clock.sleep(END_WAIT_MS)]);   // the post must start before the process exits
  }
  if (ctx.show === 'notch' || repeat) return;   // MessageDisplay repeats by the hundred: the bar's Chatterbox would restart each time
  if (name === 'PostToolBatch' && !juggles(e)) return;   // one tool: its own reaction plays out

  const now = await $.clock.now(), b = barOf(ctx);
  b.advance(now / 1000);
  if (name === 'UserPromptSubmit') b.setWorking(true, now / 1000); else if (TURN_ENDS.has(name)) b.setWorking(false, now / 1000);
  b.fire(name, body.tool_name);
  const band = { event: name, tool: body.tool_name || '', at: now }, was = ctx.band;
  ctx.band = band; if (ctx.shown) ctx.shown.band = band;
  if (!was || was.event !== band.event || was.tool !== band.tool || RESTART.has(name) || ctx.bar) redraw($, ctx);
  poll($, ctx, 1);
}

// the band drawn again REDRAW_MS after an event, once for a burst of them (the drawing reads the 'band' state, so a set redraws it)
function redraw($, ctx) {
  if (ctx.redrawing) return;
  ctx.redrawing = $.clock.after(REDRAW_MS, () => {
    ctx.redrawing = null;
    void $.state.set({ plugin: 'notch-crab', key: 'band' }, ctx.band || { event: '', tool: '', at: 0 }).catch(() => {});
  });
}

// the bar's crab, made on first use: standing at home in the look the bridge gave this session (the plain crab until it answers)
function barOf(ctx, w) {
  if (!ctx.bar) ctx.bar = new Band(REACTIONS, { w: w || DESK_W, style: ctx.style, titles: TITLES });
  else if (w) ctx.bar.setWidth(w);
  return ctx.bar;
}
// what the bar shows, in words: the screen reader's line, and what a surface without pictures draws in its place. The plain orange crab is
// "Crab" whether no outfit came or the plain preset did (its name in the engine's wardrobe is a working name, not one to show people).
function altOf(ctx) {
  const { title, detail } = ctx.bar.caption();
  const who = ctx.style && ctx.style.id !== PLAIN ? ctx.style.name : 'Crab';
  return `${who}: ${title}${detail ? ` (${detail})` : ''}`;
}

// The Code tab: the next seconds as one SVG. A new event, a turn starting or ending, and a new look all draw it again (a new source
// is a new image, its timeline starting over from the band as it is now); so does the timeline running out.
// How the Code tab draws it (2026-10-01): every render replaces the band's whole
// tree. An Svg is an <img src="data:image/svg+xml,..."> sized ONLY by the width/height props (display:block; max-width:100%), or with
// isInteractive an <iframe sandbox srcdoc> whose SVG is forced to 100% x 100%. The iframe reloads blank on each render (the bar
// blinked), defaults to the slot's width and 150 px tall, and shows a white canvas around the SVG in a dark window (its document's
// color-scheme is light). The image is transparent and, measured in Chromium, a new one is ready by the next frame (0.3 to 6 ms).
async function desk($, ctx, e, next, now) {
  const w = ctx.hud ? DESK_HUD_W : DESK_W;
  const b = barOf(ctx, w), t = now / 1000;
  b.setWorking(e.props.isWorking, t); b.advance(t);
  const ahead = b.lookahead(e.props.isWorking ? AHEAD_WORKING : AHEAD_IDLE, createCanvas, 1);
  let sv = toSvg(ahead, { px: 0.5, minFps: 20, max: SVG_MAX });   // no bg: transparent, the crab on the Code tab's own band; minFps 20: cut the timeline short rather than drop frames
  if (sv.overBudget) sv = toSvg(ahead.slice(0, 1), { px: 0.5, max: SVG_MAX });   // one frame alone too big: the band as it is
  if (ctx.deskTimer) ctx.deskTimer.cancel();
  ctx.deskTimer = $.clock.after(Math.max(250, sv.seconds * 1000), () => { ctx.deskTimer = null; void $.ui.invalidate('ui.render'); });
  const { Box, Svg } = $.ui.resolve(e);
  // the box at the notch's own size, 1 CSS px per unit (given no width it would stretch across the slot: the column Box stretches it)
  const crab = Svg({ key: 'crab', source: sv.svg, alt: altOf(ctx), width: w, height: BAND_H });
  if (!ctx.hud) return Box({ flexDirection: 'column', children: [await next(e), crab] });   // whatever other mods draw here stays
  // the HUD, its own static Svg as wide as the room (deskHudOf), BESIDE the crab in a row that does not wrap, inside a column Box of its own.
  // The Box is what lets it shrink: an <img> straight in a row cannot get narrower than its width (the flex item's automatic minimum), but in a
  // column Box its max-width:100% counts for nothing in the Box's min-content, so the row gives the Box what is left after the crab and the
  // image scales down evenly into it (its viewBox; the height stays 32 and it sits centred). A room that came out too wide (a smaller font
  // than DESK_CH's) shrinks the HUD a little instead of dropping it under him; the old wrapping row did that on any overshoot, even 1 px.
  // A room under DESK_HUD_BESIDE: the HUD under him in the band's own column, as wide as the band. Measured in Chromium with the band's own
  // CSS and its tailwind-merged classes, from 150 to 800 px with the room off by -15% to +10%: no overflow, the crab 160 throughout (2026-10-02).
  // NO SIZING PROP anywhere in this tree: with no other mod in the band, next(e) is Claude Code's own drawing (an engine node), and the CLI's
  // validator refuses an engine node under a Box with display, overflow, position, width, height, minWidth, minHeight or an offset. One
  // refusal throws the whole tree away for the engine's own: 0.2.6-0.2.8 put minWidth 0 on the column and the Code tab showed no band at all,
  // crab included (2026-10-02; seen in Claude Code 2.1.286 and 2.1.287).
  const at = deskHudOf(e.props.bodyColumns), h = hudSvg(figOf(ctx, now), { width: at.width });
  ctx.hudDeskSite = { svg: h ? h.svg : null, width: at.width };   // svg null: no bar to draw now (the task list alone, and no list), drawn when one comes
  if (!h) return Box({ flexDirection: 'column', children: [await next(e), crab] });
  const hud = Svg({ key: 'hud', source: h.svg, alt: h.alt, width: h.width, height: h.height });
  if (!at.beside) return Box({ flexDirection: 'column', children: [await next(e), crab, hud] });
  return Box({ flexDirection: 'column', children: [
    await next(e),
    Box({ flexDirection: 'row', children: [crab, Box({ flexDirection: 'column', children: [hud] })] }),
  ] });
}
// the Code tab's HUD for a band `cols` columns wide: { beside, width }. Beside the crab it takes the room after him, else the band's width; in
// HUD_MIN_W..HUD_MAX_W either way (past HUD_MAX_W the band is left empty at the right)
function deskHudOf(cols) {
  const band = Number.isFinite(cols) && cols > 0 ? Math.floor(cols * DESK_CH) : DESK_HUD_W + HUD_W;
  const room = band - DESK_HUD_W, beside = room >= DESK_HUD_BESIDE;
  return { beside, width: Math.max(HUD_MIN_W, Math.min(HUD_MAX_W, beside ? room : band)) };
}

// A terminal: the bar as an Image, 2 rows (a row is ~16 units) by W / 8 columns, its frames swapped by blit. null: no room for it.
// With the HUD on, the bar is TERM_HUD_COLS wide when a HUD fits beside it (HUD_MIN_COLS after the gap and the corner), else as wide as the band
// allows: a band too narrow for the HUD keeps the whole walk. Decided by the room, not by a HUD drawn now (see DESK_HUD_W).
async function bar($, ctx, e, next, now) {
  const p = e.props, beside = ctx.hud && p.bodyColumns - TERM_HUD_COLS - 2 - HUD_CORNER >= HUD_MIN_COLS;
  const cols = beside ? TERM_HUD_COLS : Math.min(TERM_COLS, p.bodyColumns - 2);
  if (cols * 8 < MIN_W || p.maxRows < 2) return null;
  const b = barOf(ctx, cols * 8), t = now / 1000;
  b.setWorking(p.isWorking, t); b.advance(t);
  ctx.term = { requestId: e.requestId }; ctx.lastSig = b.sig(); ctx.lastAlt = altOf(ctx); ctx.lastPng = pngOf(b);
  armBar($, ctx);
  const { Box, Image, Raster } = $.ui.resolve(e);
  const img = Image({ key: 'crab', source: { png: ctx.lastPng }, columns: cols, rows: 2, alt: ctx.lastAlt });
  const hud = hudRaster(ctx, e, Raster, p.bodyColumns - cols - 2 - HUD_CORNER, now);
  if (ctx.hud) armSlow($, ctx);
  return Box({ flexDirection: 'column', children: [
    await next(e),
    hud ? Box({ flexDirection: 'row', gap: 1, children: [img, hud] }) : img,
  ] });
}

// The terminal HUD as a Raster `room` columns wide at most (HUD_COLS), or null: no HUD (hud 'off', under HUD_MIN_COLS, no bar to draw now).
// Remembers what it drew, so a change of figures goes out by blit, and only when the cells differ. With room but no bar to draw (the task
// list alone, and no list) it remembers the room, unmounted, so the bar's coming draws the band again.
function hudRaster(ctx, e, Raster, room, now) {
  ctx.hudTermSite = null;
  if (!ctx.hud) return null;
  const cols = Math.min(HUD_COLS, room);
  if (cols < HUD_MIN_COLS) return null;
  const h = hudTerm(figOf(ctx, now), { columns: cols });
  if (!h.cells) { ctx.hudTermSite = { requestId: e.requestId, columns: cols, cells: null, mounted: false }; return null; }
  ctx.hudTermSite = { requestId: e.requestId, columns: h.columns, cells: h.cells, mounted: true };
  return Raster({ key: 'hud', columns: h.columns, rows: h.rows, cells: h.cells });
}

// the terminal's picture of the band: the frame transparent around the crab, so it stands on the terminal's own background (a blit uploads
// the picture again under the same image id: the terminal replaces it, it does not paint it over the last one), bled so the terminal's
// linear scaling draws no dark rim at the crab's edges (engine/band.js bleed).
// Sat on the box's floor: Ghostty fits a picture to its box keeping the aspect and CENTRES it (graphics_unicode.zig), so the 10 : 1 frame in
// a 2-row box of tall cells sat in a letterbox, half of it under the crab's feet. Clear rows ABOVE the frame make the picture BAR_PX_H px tall
// at ANY width: a box of n columns over 2 rows is n / 40 of the 40-column box's 7 : 1, and so is the picture, so a box of these cells (or
// squatter ones) fits it by height, and the frame's bottom is the box's. (Padding to a fixed 7 : 1, as before 2026-10-02, left every bar under
// 40 columns letterboxed: a 20-column bar's 5 : 1 frame in a 3.5 : 1 box sat 14 px off the floor.) The whole frame stays (props and their
// shadows reach its bottom edge). The mod is not told the cell's pixels, so one height is right for one cell shape: 40 columns over 2 rows at
// 7 : 1 is cells 2.83 times as tall as wide (a tall-cell setup, e.g. 17 x 48 px cells). Squatter cells
// (Ghostty's defaults are 17 x 37) fit it by height too, smaller and centred across: about 1.61 px per unit there, against 2.1 here.
const BAR_ASPECT = 7, BAR_PX_H = Math.ceil(TERM_COLS * 16 / BAR_ASPECT);   // 92 px: the 40-column bar's 7 : 1 (16 px per column at 2 px per unit)
function pngOf(b) {
  const f = b.frame(createCanvas, 1), pad = Math.max(0, BAR_PX_H - f.h);
  if (!pad) return pngBase64(bleed(f));
  // bled with one clear row above the frame, the only pad row a linear sample next to the frame reads; the rest stay (0, 0, 0, 0)
  const lip = new Uint8ClampedArray(f.w * (f.h + 1) * 4); lip.set(f.data, f.w * 4);
  const data = new Uint8ClampedArray(f.w * (f.h + pad) * 4); data.set(bleed({ w: f.w, h: f.h + 1, data: lip }).data, (pad - 1) * f.w * 4);
  return pngBase64({ w: f.w, h: f.h + pad, data });
}

// The bar's clock in a terminal, armed by its first drawing: the band steps with real time and a frame goes out only when its pixels
// change. A blit refused because the terminal draws the alt instead turns the bar off for this load: the half-block Clawd takes over.
function armBar($, ctx) {
  if (ctx.barTimer) return;
  ctx.barTimer = $.clock.every(FRAME_MS, () => {
    const term = ctx.term, b = ctx.bar;
    if (!term || !b || !ctx.images) return;
    void $.clock.now().then(async (now) => {
      b.advance(now / 1000);
      const sig = b.sig();
      if (sig === ctx.lastSig) return;
      if (altOf(ctx) !== ctx.lastAlt) { void $.ui.invalidate('ui.render'); return; }   // a new caption: draw it again, so the alt says it too
      ctx.lastSig = sig;   // before the await: a tick that lands while this blit is out must not send the same frame again
      const png = pngOf(b);
      if (png === ctx.lastPng) return;   // a new step, the same pixels (a pose held, a frame repeated)
      ctx.lastPng = png;
      const r = await $.ui.blit({ requestId: term.requestId, key: 'crab', source: { png } });
      if (r && r.deny) {
        if (String(r.deny).startsWith(NO_IMAGES)) { ctx.images = false; ctx.barTimer.cancel(); ctx.barTimer = null; void $.ui.invalidate('ui.render'); }
        else if (ctx.lastPng === png) ctx.lastSig = ctx.lastPng = null;   // not mounted yet, or collapsed: the next tick tries again
      }
    }).catch(() => { ctx.lastSig = ctx.lastPng = null; });
  });
}

// Any other terminal: the half-block Clawd beside its caption, as before the bar.
async function clawd($, ctx, e, next, band, now) {
  const p = e.props;   // too narrow or too short a band would clip it
  if (p.bodyColumns < COLS + 2 || p.maxRows < ROWS) return next(e);
  const { Box, Text, Raster } = $.ui.resolve(e);
  ctx.shown = { band, working: p.isWorking, requestId: e.requestId };
  arm($, ctx);
  const f = frameAt(band, p.isWorking, now);
  ctx.lastId = f.id;
  const { title, detail } = caption(band);
  const words = [Text({ bold: true, color: '#D97757', wrap: 'truncate', children: title })];
  if (detail) words.push(Text({ dimColor: true, wrap: 'truncate', children: detail }));
  // the HUD's 2 rows on top of the caption's 2, the Clawd's 4 rows in all: nothing moves when the caption gains or loses its detail
  const hud = hudRaster(ctx, e, Raster, p.bodyColumns - COLS - 2 - 2 - HUD_CORNER, now);
  if (ctx.hud) armSlow($, ctx);
  return Box({ flexDirection: 'column', children: [
    await next(e),
    Box({ flexDirection: 'row', gap: 2, children: [
      Raster({ key: 'clawd', columns: COLS, rows: ROWS, cells: f.cells }),
      hud ? Box({ flexDirection: 'column', children: [hud, ...words] }) : Box({ flexDirection: 'column', justifyContent: 'center', children: words }),
    ] }),
  ] });
}

// The session's look, from the bridge: GET /style holds until the look differs from the tag it was given (or 20 s pass: 204), so one
// poll is always out. Each poll starts from a timer, never inside an event's hook. 404: the bridge has not seen this session yet (its
// first hook is on its way): ask again shortly. No bridge: the plain crab, and ask again now and then.
function poll($, ctx, ms) {
  if (ctx.polling || ctx.preset) return;
  ctx.polling = true;
  $.clock.after(ms, () => { void pollOnce($, ctx); });
}
async function pollOnce($, ctx) {
  let wait = 1;
  try {
    const id = await $.session.id(), sock = await socketOf($, ctx);
    if (!id || !sock) { wait = POLL_DOWN_MS; return; }
    const r = await $.http.fetch(`http://localhost/style?session=${encodeURIComponent(id)}${ctx.tag ? `&tag=${ctx.tag}` : ''}`, { socketPath: sock });
    if (r.status === 200) {
      const j = JSON.parse(r.text);
      if (j && j.style && typeof j.tag === 'string' && j.tag !== ctx.tag) {
        ctx.tag = j.tag; ctx.style = j.style;
        if (ctx.bar) ctx.bar.setStyle(j.style);
        void $.ui.invalidate('ui.render');   // the Code tab's SVG has the old look baked in; a terminal's next blit has the new one anyway
      }
    } else if (r.status === 404) wait = POLL_AGAIN_MS;
    else if (r.status !== 204) wait = POLL_DOWN_MS;
  } catch { wait = POLL_DOWN_MS; }   // ENOENT / ECONNREFUSED: no bridge
  finally { ctx.polling = false; poll($, ctx, wait); }
}

// the bridge's socket, in the bridge's own order (after its --socket flag): $NOTCH_CRAB_SOCKET, else ~/.notch-crab/bridge.sock
async function socketOf($, ctx) {
  if (ctx.socketPath === undefined) {
    const own = await $.env.get('NOTCH_CRAB_SOCKET'), home = await $.env.get('HOME');   // socketPath must be absolute: no ~
    ctx.socketPath = own || (home ? `${home}/.notch-crab/bridge.sock` : null);
  }
  return ctx.socketPath;
}

// One queue per session process, so the bridge sees events in the order Claude Code raised them. Detached: the hook has
// returned by the time a post goes out (SessionEnd excepted, above).
function send($, ctx, body) {
  if (ctx.queued >= (LANDMARKS.has(body.hook_event_name) ? 2 * MAX_QUEUE : MAX_QUEUE)) return;
  ctx.queued++;
  ctx.queue = ctx.queue
    .then(() => $.http.fetch('http://localhost/hook', {   // Host: localhost passes the bridge's loopback check
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), socketPath: ctx.socketPath,
    }))
    .catch(() => {})   // ENOENT / ECONNREFUSED (no bridge) and the 30 s no-answer abort all land here
    .finally(() => { ctx.queued--; });
}

// The half-block Clawd's clock, armed by its first drawing: a frame goes out by blit (no redraw) only when the picture changes, and
// a refused blit (the band not mounted yet, collapsed) is tried again on the next tick.
function arm($, ctx) {
  if (ctx.timer) return;
  ctx.timer = $.clock.every(TICK_MS, () => {
    const shown = ctx.shown;
    if (!shown) return;
    void $.clock.now().then(async (now) => {
      const f = frameAt(shown.band, shown.working, now);
      if (f.id === ctx.lastId) return;
      ctx.lastId = f.id;   // before the await: a tick that lands while this blit is out must not send the same frame again
      const r = await $.ui.blit({ requestId: shown.requestId, key: 'clawd', cells: f.cells });
      if (r && r.deny && ctx.lastId === f.id) ctx.lastId = null;
    }).catch(() => { ctx.lastId = null; });
  });
}

// ---------------------------------------------------------------- the HUD's figures

// the fig engine/hud.js draws, at `now`, with the bars turned on
function figOf(ctx, now) { return figures({ ...hudInput(ctx.hud), bars: ctx.bars }, now); }
// after new figures: when each bar reached 100% (the head's blink stops 60 s after), kept across measurements
function settleSince(ctx, now) { ctx.hud.since = sinceOf(ctx.hud.since, figOf(ctx, now)); }

// session.measure: the figures pushed after a turn. Taken at once (no awaits in the hook); the breakdown, when due, read behind it.
function measure($, ctx, e) {
  applyUsage(ctx.hud, e, { measured: true });
  if (ctx.bars.context && needsBreakdown(ctx.hud)) void readBreakdown($, ctx).then(() => hudChanged($, ctx)).catch(() => {});
  else void hudChanged($, ctx).catch(() => {});
}

// A classic event: a task tool's answer changes the list; a tool call, a compaction or a start may have moved the context (a turn's
// session.measure comes only at its end). Detached: nothing here holds the event.
function hudEvent($, ctx, name, e) {
  try {
    if (ctx.bars.tasks && name === 'PostToolUse' && TASK_TOOLS.has(e.tool_name)) {
      const list = reduceTasks(ctx.hud.tasks, e.tool_name, e.tool_input, e.tool_response, typeof e.agent_id === 'string' && e.agent_id ? e.agent_id : undefined);
      if (list) { ctx.taskSeq++; void tasksChanged($, ctx, list).catch(() => {}); }
    }
    // a new conversation in this process (/clear, an in-process /resume, a fork): its task list is another one (Claude Code keys the list
    // by session id), so the old counts go at once; a resume or fork then replays its own transcript (from a timer, never in the event).
    // SessionEnd's 'clear' / 'resume' clears too (no replay there: messages() would still read the ending conversation).
    const fresh = ctx.bars.tasks && (name === 'SessionStart' ? NEW_CONVERSATION.has(e.source) : name === 'SessionEnd' && (e.reason === 'clear' || e.reason === 'resume'));
    if (fresh) {
      ctx.taskSeq++;
      if (ctx.hudDone) { ctx.hudDone.cancel(); ctx.hudDone = null; }
      setTasks(ctx.hud, [], 0);
      void hudChanged($, ctx).catch(() => {});
      if (name === 'SessionStart') $.clock.after(1, () => { void replay($, ctx).catch(() => {}); });
    }
    // the limits come with session.measure (a turn's end, a window moving a point), so a mid-turn read is the context bar's alone
    if (ctx.usage && HUD_REFRESH.has(name) && (ctx.bars.context || name === 'SessionStart')) void refreshUsage($, ctx).catch(() => {});
  } catch {}
}
async function tasksChanged($, ctx, list) {
  const now = await $.clock.now();
  if (setTasks(ctx.hud, list, now)) {   // all done: gold for DONE_MS, then the row goes, which only a redraw shows
    // timed from when the list was done, not from this call: a TaskList or TaskGet on the finished list must not keep it up longer
    if (ctx.hudDone) ctx.hudDone.cancel();
    ctx.hudDone = $.clock.after(Math.max(0, ctx.hud.completedAt + DONE_MS - now) + 100, () => { ctx.hudDone = null; void hudChanged($, ctx).catch(() => {}); });
  }
  await hudChanged($, ctx);
}

// the plain $.session.usage() (free), one at a time; and the breakdown when this window has none yet. A refresh asked for while one is out
// runs once more after it (one trailing read for a whole burst), so the last tool call of a parallel batch is never left unread.
async function refreshUsage($, ctx) {
  if (ctx.refreshing) { ctx.refreshAgain = true; return; }
  ctx.refreshing = true;
  try {
    do {
      ctx.refreshAgain = false;
      try {
        applyUsage(ctx.hud, await $.session.usage());
        if (ctx.bars.context && needsBreakdown(ctx.hud)) await readBreakdown($, ctx);
      } catch {}
    } while (ctx.refreshAgain);
  } finally { ctx.refreshing = false; }
  await hudChanged($, ctx);
}
// auto-compact's threshold, estimated locally ('summary': no API call): once per session, and again when the window changes (the context bar
// alone uses it)
async function readBreakdown($, ctx) {
  const window = ctx.hud.context && ctx.hud.context.window;
  try { applyBreakdown(ctx.hud, await $.session.usage({ breakdown: 'summary' })); }
  catch { ctx.hud.windowFor = window; }   // not again for this window: the threshold falls back to window - 33k
}

// Once per load, from a timer the first drawing starts (never inside the render): the figures so far, and the task list replayed from
// the transcript, so a reloaded mod or a resumed session knows its list (each only for a bar turned on). A task event that lands meanwhile
// wins over the replay.
function seed($, ctx) {
  if (!ctx.hud || ctx.hudSeeded) return;
  ctx.hudSeeded = true;
  $.clock.after(1, () => { void seedOnce($, ctx).catch(() => {}); });
}
async function seedOnce($, ctx) {
  if (ctx.usage) try { await refreshUsage($, ctx); } catch {}
  if (ctx.bars.tasks) await replay($, ctx);
}
// The task list replayed from this conversation's transcript (the seed, and a resume or fork in this process). A task event that lands
// while messages() is out wins over the replay (taskSeq moved).
async function replay($, ctx) {
  const seq = ctx.taskSeq;
  try {
    const msgs = await $.session.messages();
    if (Array.isArray(msgs) && ctx.taskSeq === seq) {
      const list = replayTasks(msgs.flatMap((m) => (m && Array.isArray(m.toolUses) ? m.toolUses : [])));
      setTasks(ctx.hud, list, await $.clock.now(), { replayed: true });
    }
  } catch {}
  await hudChanged($, ctx);
}

// New figures, or time passing: the terminal's Raster blitted when its cells changed (a refused blit draws the band again); the Code tab's
// Svg drawn again (redraw) when its picture changed. termOnly: the slow timer's tick (the Code tab draws itself again when its crab's
// look-ahead runs out, reading the clock then). A HUD that comes or goes (the task list alone turned on: its list starts, or its gold row
// leaves) changes the band's tree, which a blit cannot: the band is drawn again.
async function hudChanged($, ctx, termOnly) {
  if (!ctx.hud) return;
  const now = await $.clock.now();
  settleSince(ctx, now);
  armSlow($, ctx);
  const fig = figOf(ctx, now), site = ctx.hudTermSite, deskSite = ctx.hudDeskSite;
  if (deskSite && !termOnly) { const h = hudSvg(fig, { width: deskSite.width }); if ((h ? h.svg : null) !== deskSite.svg) redraw($, ctx); }
  if (site) {
    const h = hudTerm(fig, { columns: site.columns });
    if (h.cells === site.cells) return;
    if (!h.cells || !site.mounted) { site.cells = h.cells; void $.ui.invalidate('ui.render'); return; }
    site.cells = h.cells;   // before the await: a second change while this blit is out compares against it
    const r = await $.ui.blit({ requestId: site.requestId, key: 'hud', cells: h.cells });
    if (r && r.deny) { if (ctx.hudTermSite === site) site.cells = null; void $.ui.invalidate('ui.render'); }
  }
}
// the terminal's slow clock: only while a limit that is drawn has a clock (pace flags, reset times) and a terminal shows the HUD
function armSlow($, ctx) {
  const want = !!ctx.hudTermSite && hasClockedLimits(ctx.hud, ctx.bars);
  if (want && !ctx.hudSlow) ctx.hudSlow = $.clock.every(HUD_SLOW_MS, () => { if (ctx.hudTermSite) void hudChanged($, ctx, true).catch(() => {}); });
  else if (!want && ctx.hudSlow) { ctx.hudSlow.cancel(); ctx.hudSlow = null; }
}
