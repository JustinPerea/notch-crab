// The terminal Clawd: a 14 x 8 pixel crab drawn as 14 x 4 half-block cells (each cell holds two stacked pixels) in a Raster
// above Claude Code's prompt. Pure data and functions, no `$`: register.mjs draws it, and test/mod.test.mjs reads it with node.
//
// The grids are engine/crab.js at half scale (col = floor((x + 14) / 2), row = floor((y + 15) / 2)): body cols 2..11, arms at
// cols 1 and 12, eyes at 4 and 9, legs at 3 / 5 / 8 / 10, mirror c <-> 13 - c. Same palette as crab.js and kit.js.
// '.' is an empty pixel (the terminal's own background), 'S' the star, whose colour depends on the event.

export const COLS = 14, ROWS = 4;
export const PAL = { H: 0xEC9A76, B: 0xD97757, L: 0xB95A3C, G: 0xA24C33, E: 0x181521, W: 0xFFF8F0, Y: 0xFFC94D, A: 0xF4A22D };
export const STAR = { gold: 0xFFC94D, green: 0x5CE38A };   // green: PostToolUse's check colour (reactions/PostToolUse.js)

const BODY = ['..BLLLLLLLLB..', '..............', '...G.G..G.G...'];   // rows 5..7: bottom shade, gap, legs
export const FRAMES = {
  idle: [
    ['...HHHHHHHH...', '..HBBBBBBBBL..', '..BBEBBBBEBL..', '..BBEBBBBEBL..', '.BBBBBBBBBBLB.', ...BODY],
  ],
  blink: [   // eyes drop to their closed row, as crab.js 'closed' does at cy + 0.5
    ['...HHHHHHHH...', '..HBBBBBBBBL..', '..BBBBBBBBBL..', '..BBEBBBBEBL..', '.BBBBBBBBBBLB.', ...BODY],
  ],
  thinking: [   // UserPromptSubmit "Thinking Cap": eyes up and right, a thought bubble rising past the right arm
    ['...HHHHHHHH...', '..HBBEBBBBELW.', '..BBBEBBBBEL..', '..BBBBBBBBBL..', '.BBBBBBBBBBLB.', ...BODY],
    ['...HHHHHHHH..W', '..HBBEBBBBEL..', '..BBBEBBBBEL..', '..BBBBBBBBBL..', '.BBBBBBBBBBLB.', ...BODY],
  ],
  tool: [   // PreToolUse "Tool Time": hardhat brim over the hi row, eyes on the work, right pincer tapping
    ['..YYYYAAYYYY..', '..BBBBBBBBBL..', '..BBBEBBBBEL..', '..BBBEBBBBELBH', '.BBBBBBBBBBL..', ...BODY],
    ['..YYYYAAYYYY..', '..BBBBBBBBBL..', '..BBBEBBBBEL..', '..BBBEBBBBEL..', '.BBBBBBBBBBLB.', ...BODY],
  ],
  done: [   // Stop "Order Up" / PostToolUse "Nailed It": happy closed eyes (an arch: a 1-px ^ reads as an X at this size), arms up, a star
    ['.H.HHHHHHHH.HS', '.BHBBBBBBBBLB.', '..BEEEBBEEEL..', '..BEBEBBEBEL..', '..BBBBBBBBBL..', ...BODY],
    ['.H.HHHHHHHH.H.', '.BHBBBBBBBBLB.', '..BEEEBBEEEL..', '..BEBEBBEBEL..', '..BBBBBBBBBL..', ...BODY],
  ],
};

// Every hook event: its pose here and its title (hooks.json, checked by test/mod.test.mjs). A 'loop' pose holds while Claude
// Code is working; a 'once' pose plays for ONCE_MS and settles back to idle. This first Clawd has four poses; the 33 notch
// reactions are the full cast.
const P = (pose, title, kind = 'once') => ({ pose, title, kind });
export const EVENTS = {
  SessionStart: P('idle', 'Wake Up'), Setup: P('done', 'Unboxing'),
  UserPromptSubmit: P('thinking', 'Thinking Cap', 'loop'), UserPromptExpansion: P('thinking', 'Slash Magic'),
  MessageDisplay: P('thinking', 'Chatterbox', 'loop'),
  PreToolUse: P('tool', 'Tool Time', 'loop'), PermissionRequest: P('tool', 'May I?', 'loop'), PermissionDenied: P('idle', 'Nope'),
  PostToolUse: P('done', 'Nailed It'), PostToolUseFailure: P('idle', 'Oops'), PostToolBatch: P('tool', 'Juggler'),
  Notification: P('idle', 'Ding'),
  SubagentStart: P('thinking', 'Go Fetch'), SubagentStop: P('done', 'Report In'),
  TaskCreated: P('thinking', 'New Note'), TaskCompleted: P('done', 'Stamped'),
  Stop: P('done', 'Order Up'), StopFailure: P('idle', 'Unplugged'), TeammateIdle: P('idle', 'Break Room', 'loop'),
  InstructionsLoaded: P('idle', 'Read The Manual'), ConfigChange: P('idle', 'Tweak'),
  CwdChanged: P('idle', 'Walkabout'), DirectoryAdded: P('idle', 'Stack It'), FileChanged: P('idle', 'Lookout'),
  WorktreeCreate: P('idle', 'Second Pot'), WorktreeRemove: P('idle', 'Sweep Up'),
  PreCompact: P('thinking', 'Stuffed Suitcase', 'loop'), PostCompact: P('done', 'Neat And Tidy'),
  PreModelSwitch: P('thinking', 'Which Brain'), PostModelSwitch: P('done', 'Fresh Brain'),
  SessionEnd: P('idle', 'Lights Out'),
  Elicitation: P('tool', 'Asking Nicely', 'loop'), ElicitationResult: P('done', 'Answer Sent'),
};

export const ONCE_MS = 2500, BLINK_EVERY = 4000, BLINK_MS = 150;
const STEP = { thinking: 450, tool: 300, done: 350 };   // ms per frame of each animated pose

// What the Raster shows at `now` for the band's last event { event, tool, at } (undefined before any) and whether a turn runs.
// Returns { id, cells }: id changes exactly when the picture does, so the timer only blits real changes.
export function frameAt(band, working, now) {
  const ev = band && EVENTS[band.event];
  let pose = ev ? ev.pose : 'idle';
  if (ev && (ev.kind === 'once' ? now - band.at > ONCE_MS : !working)) pose = 'idle';   // a 'once' plays out; a loop needs a running turn
  const star = band && band.event === 'PostToolUse' ? 'green' : 'gold';
  if (pose === 'idle') {
    const blink = now % BLINK_EVERY < BLINK_MS;
    return { id: blink ? 'blink' : 'idle', cells: encode(FRAMES[blink ? 'blink' : 'idle'][0]) };
  }
  const n = Math.floor(Math.max(0, now - band.at) / STEP[pose]) % FRAMES[pose].length;
  return { id: `${pose}:${n}:${star}`, cells: encode(FRAMES[pose][n], STAR[star]) };
}

// The caption beside the crab: the event's title, and the tool when there is one.
export function caption(band) {
  const ev = band && EVENTS[band.event];
  return { title: ev ? ev.title : 'Idle', detail: band && band.tool ? band.tool : '' };
}

const DEFAULT = 0x01000000;   // bit 24 alone: the terminal's own colour
const FULL = 0x2588, UPPER = 0x2580, LOWER = 0x2584, SPACE = 0x20;
const colourOf = (ch, star) => (ch === '.' ? null : ch === 'S' ? star : PAL[ch]);

// A grid of 8 strings x 14 chars to the Raster's `cells`: row-major [codePoint, fg, bg] little-endian u32 triplets, base64.
// A cell is its top pixel over its bottom one: upper half block (fg top, bg bottom), lower half block when only the bottom is
// set, a full block for two of one colour, a space for none.
export function encode(grid, star = STAR.gold) {
  const words = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const t = colourOf(grid[2 * r][c], star), b = colourOf(grid[2 * r + 1][c], star);
      if (t == null && b == null) words.push(SPACE, DEFAULT, DEFAULT);
      else if (t != null && t === b) words.push(FULL, t, DEFAULT);
      else if (t != null) words.push(UPPER, t, b ?? DEFAULT);
      else words.push(LOWER, b, DEFAULT);
    }
  }
  const bytes = new Uint8Array(words.length * 4);
  words.forEach((w, i) => { bytes[4 * i] = w & 255; bytes[4 * i + 1] = (w >>> 8) & 255; bytes[4 * i + 2] = (w >>> 16) & 255; bytes[4 * i + 3] = (w >>> 24) & 255; });
  return base64(bytes);
}

// standard padded base64, written out: the mod runtime's web APIs are not listed one by one, so this does not lean on btoa or toBase64
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}
