import type { Args } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'
import { FRAMES, ONCE_MS, encode, frameAt } from '../hooks/clawd.mjs'
import { readPng } from './inflate.mjs'

tier('user')

const NO_CONTENT = { status: 204, ok: true, headers: {}, text: '' }
const NOT_FOUND = { status: 404, ok: false, headers: {}, text: '' }
const NO_IMAGES = 'the Image draws its alt here: the terminal draws no placeholder images (TERM=xterm-256color)'   // Claude Code 2.1.287's words
const PNG = /^iVBORw0KGgo/   // base64 of the PNG signature
const SOCK = '/Users/me/.notch-crab/bridge.sock'
const PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} }
const BAND = { component: 'AbovePrompt' as const, props: PROPS }
const IDLE = encode(FRAMES.idle[0])

// Beneath the plugins, the band's last hook is Claude Code's own drawing: next(e) answers an engine node ({ type: 'engine', ref }), and in a
// terminal Claude Code draws its collapse mark `[-]` top-right (the HUD keeps 4 columns clear of it). Most tests stand in another mod's
// line, 'below', which the crab must keep; `core` stands in the engine node itself, as in a band with no other mod (the real Code tab).
// The test kit has no core of its own, and the CLI refuses a whole tree with an engine node under a Box that has a sizing prop, which
// 'below' never showed (0.2.6-0.2.8 lost the Code tab's band that way, 2026-10-02).
const otherMod = (on: any) => on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
const core = (on: any) => on('ui.render', () => ({ type: 'engine', ref: 0 }))
const DESK = { component: 'AbovePrompt' as const, props: { ...PROPS, isWorking: false } }
// every Text in the band, line by line: the other mod's 'below', then the crab's caption
const words = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
// a Code-tab tree node by what it is (the desktop's drawing keeps no keys to find by): the crab's Svg by its alt (his name first), the other
// Svg the HUD, a Box by its direction, a Text (another mod's drawing) as 'below'
const namer = async (_ui: any) => (c: any) =>
  c.type === 'Text' ? 'below' : c.type === 'Box' ? c.props.flexDirection : c.type === 'Svg' ? (/^(Crab|Bow): /.test(c.props.alt) ? 'crab' : 'hud') : c.type

// the bridge as a list of what reached it; `answer` may be slow (a mock clock sleep) or refuse. GET /style (the band's look) goes to
// `style`, by default a 404 (a session the bridge has not seen yet: the mod asks again in 2 s), and is listed in `polls`
function bridge(on: any, answer: (body: any) => any = () => ({ value: NO_CONTENT }), style: (url: URL) => any = () => ({ value: NOT_FOUND })) {
  const posts: { path: string; socketPath?: string; body: any }[] = []
  const polls: { url: URL; socketPath?: string }[] = []
  on('http.fetch', async ($: unknown, e: Args<'http.fetch'>) => {
    const url = new URL(e.url)
    if (url.pathname === '/style') { polls.push({ url, socketPath: e.init?.socketPath }); return style(url) }
    const body = JSON.parse(String(e.init?.body))
    const r = await answer(body)
    posts.push({ path: url.pathname, socketPath: e.init?.socketPath, body })
    return r
  })
  return Object.assign(posts, { polls })
}
const events = (posts: { body: any }[]) => posts.map((p) => p.body.hook_event_name)

describe('register', () => {
  test('an event reaches the bridge socket as POST /hook, leaving the look to the bridge, and its answer is untouched', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.Stop', () => ({ additionalContext: ['from settings'] }))

    const answer = await $.classic.Stop({ stop_hook_active: false, session_id: 's-1', cwd: '/work/web-app' })
    await clock.settle()

    expect(answer).toEqual({ additionalContext: ['from settings'] })
    expect(posts).toEqual([{ path: '/hook', socketPath: SOCK, body: { hook_event_name: 'Stop', session_id: 's-1', cwd: '/work/web-app', show: 'both' } }])
  })

  test('posts go out one at a time, in the order Claude Code raised the events, even when the bridge is slow', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    let inFlight = 0, most = 0
    const posts = bridge(on, async (b) => {
      most = Math.max(most, ++inFlight)
      await clock.sleep(b.hook_event_name === 'SessionStart' ? 300 : 10)   // the first answer is the slowest
      inFlight--
      return { value: NO_CONTENT }
    })
    on('classic.*', () => ({}))
    await $.classic.SessionStart({ source: 'startup', session_id: 's-1' })
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's-1' })
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    expect(posts).toEqual([])   // the hooks returned before any answer
    await clock.advance(1000)
    expect(events(posts)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop'])
    expect(most).toBe(1)
  })

  test('only the allowlisted fields leave: no prompt, no transcript path, no tool input or output', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))

    await $.classic.UserPromptSubmit({ prompt: 'my secret plan', session_id: 's-1', cwd: '/work/app', transcript_path: '/Users/me/t.jsonl' })
    await $.classic.PostToolUse({
      session_id: 's-1', cwd: '/work/app', tool_name: 'Read', tool_use_id: 'toolu_1', tool_input: { file_path: '/etc/passwd' }, tool_response: 'root:x:0:0',
    })
    await clock.settle()

    expect(posts.map((p) => p.body)).toEqual([
      { hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: '/work/app', show: 'both' },
      { hook_event_name: 'PostToolUse', session_id: 's-1', cwd: '/work/app', tool_name: 'Read', tool_use_id: 'toolu_1', show: 'both' },
    ])
    expect(JSON.stringify(posts)).not.toMatch(/secret|passwd|root:x|t\.jsonl/)
  })

  test('PreToolUse rides the tool call envelope; the session comes from $.session; the input stays home', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('session.id', () => ({ value: 's-9' }))
    on('session.cwd', () => ({ value: '/work/api' }))
    on('classic.PreToolUse', () => ({}))
    on('tool.call', () => ({ result: 'done' }))

    await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x' })
    await clock.settle()

    const pre = posts.filter((p) => p.body.hook_event_name === 'PreToolUse').map((p) => p.body)
    expect(pre).toHaveLength(1)
    expect(Object.keys(pre[0]).sort()).toEqual(['cwd', 'hook_event_name', 'session_id', 'show', 'tool_name', 'tool_use_id'])
    expect(pre[0]).toEqual(expect.objectContaining({ session_id: 's-9', cwd: '/work/api', tool_name: 'Bash' }))
    expect(pre[0].tool_use_id).toEqual(expect.any(String))
    expect(JSON.stringify(posts)).not.toMatch(/rm -rf/)
  })

  test('$NOTCH_CRAB_SOCKET wins over HOME', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me', NOTCH_CRAB_SOCKET: '/tmp/nc/b.sock' })
    const posts = bridge(on)
    on('classic.Notification', () => ({}))
    await $.classic.Notification({ message: 'hi', notification_type: 'idle_prompt', session_id: 's-1' })
    await clock.settle()
    expect(posts.map((p) => p.socketPath)).toEqual(['/tmp/nc/b.sock'])
    expect(posts[0]?.body.notification_type).toBe('idle_prompt')
  })

  test('when the mod itself fails (no session id for a tool call), the event goes on untouched', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('session.id', () => ({ deny: 'no session' }))
    on('classic.PreToolUse', () => ({ decision: 'allow' }))
    let ran = false
    on('tool.call', () => { ran = true; return { result: 'done' } })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.settle()
    expect(ran).toBe(true)
  })

  test('an absent bridge never fails or changes an event', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    on('http.fetch', () => ({ deny: 'ECONNREFUSED' }))
    on('classic.Notification', () => ({}))
    on('classic.WorktreeCreate', () => ({ worktreePath: '/wt' }))
    await expect($.classic.Notification({ message: 'hi', notification_type: 'idle_prompt' })).resolves.toEqual({})
    expect(await $.classic.WorktreeCreate({ name: 'feature' })).toEqual({ worktreePath: '/wt' })
    await clock.settle()
  })

  test('outfit "plain" asks the bridge for the plain look on every session', { options: { outfit: 'plain' } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.Stop', () => ({}))
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    await clock.settle()
    expect(posts.map((p) => p.body)).toEqual([{ hook_event_name: 'Stop', session_id: 's-1', cwd: expect.any(String), preset: 'claude', show: 'both' }])
  })

  test('outfit "wardrobe", said out loud, is the default: no preset', { options: { outfit: 'wardrobe' } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.Stop', () => ({}))
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    await clock.settle()
    expect(posts.map((p) => p.body)).toEqual([{ hook_event_name: 'Stop', session_id: 's-1', cwd: expect.any(String), show: 'both' }])
  })

  // every body says where the crab shows, so the bridge's "off the notch" follows the option both ways (a body with none changes nothing)
  for (const show of [undefined, 'both', 'notch'] as const) test(`show ${show ?? 'left out'}: every body says ${show === 'notch' ? 'notch' : 'both'}`, show ? { options: { show } } : {}, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    await clock.settle()
    expect(posts.map((p) => p.body)).toEqual([
      { hook_event_name: 'Stop', session_id: 's-1', cwd: expect.any(String), show: show === 'notch' ? 'notch' : 'both' },
    ])
  })
  test('show "prompt": every body carries it', { options: { show: 'prompt' } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's-1' })
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    await clock.settle()
    expect(posts.map((p) => p.body)).toEqual([
      { hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: expect.any(String), show: 'prompt' },
      { hook_event_name: 'Stop', session_id: 's-1', cwd: expect.any(String), show: 'prompt' },
    ])
  })

  test('MessageDisplay reaches the bridge once per assistant message, not once per streamed batch', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    const batch = (message_id: string, index: number) =>
      $.classic.MessageDisplay({ session_id: 's-1', turn_id: 't-1', message_id, index, final: false, delta: 'line' })
    for (let i = 0; i < 5; i++) await batch('m-1', i)
    for (let i = 0; i < 3; i++) await batch('m-2', i)
    await clock.settle()
    expect(events(posts)).toEqual(['MessageDisplay', 'MessageDisplay'])
  })

  test('the queue drains: 200 events, 200 posts', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    for (let i = 0; i < 200; i++) await $.classic.Notification({ message: 'x', notification_type: 'idle_prompt', session_id: 's-1' })
    await clock.settle()
    expect(posts).toHaveLength(200)
  })

  test('a stuck bridge holds 64 posts; the ends of things still get in', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on, async () => { await clock.sleep(30_000); return { value: NO_CONTENT } })
    on('classic.*', () => ({}))
    for (let i = 0; i < 100; i++) await $.classic.Notification({ message: 'x', notification_type: 'idle_prompt', session_id: 's-1' })
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    await clock.advance(66 * 30_000)
    expect(events(posts).filter((n) => n === 'Notification')).toHaveLength(64)
    expect(events(posts).at(-1)).toBe('Stop')
  })

  test('SessionEnd waits for its post (up to a second), so it is out before the process exits', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on, async () => { await clock.sleep(200); return { value: NO_CONTENT } })
    on('classic.*', () => ({}))
    let ended = false
    const end = $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 's-1' }).then(() => { ended = true })
    await clock.advance(100)
    expect(ended).toBe(false)
    await clock.advance(150)
    await end
    expect(events(posts)).toEqual(['SessionEnd'])
  })

  test('a hung bridge holds SessionEnd one second, no longer', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/Users/me' })
    bridge(on, async () => { await clock.sleep(60_000); return { value: NO_CONTENT } })
    on('classic.*', () => ({}))
    let ended = false
    const end = $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 's-1' }).then(() => { ended = true })
    await clock.advance(999)
    expect(ended).toBe(false)
    await clock.advance(2)
    await end
    expect(ended).toBe(true)
  })
})


// a band's Image source, decoded enough to compare two frames
const png = (el: any) => el?.props.source?.png as string | undefined

describe('the bar, in a terminal that shows pictures', () => {
  test('draws the crab as an Image 2 rows tall, as wide as the band allows (at most 40 columns), keeping the other mods', { options: { hud: 'off' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    for (const [cols, want] of [[80, 40], [30, 28], [8, 6]] as const) {
      const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: cols } })
      const img = await ui.find({ key: 'crab' })
      expect(img?.type).toBe('Image')
      expect(img?.props).toEqual(expect.objectContaining({ columns: want, rows: 2, alt: 'Crab: Idle' }))
      expect(png(img)).toMatch(PNG)
      // transparent around the crab: no bar of its own, the crab on the terminal's background (2 px per unit); the whole frame
      // (64 px, 32 units) at the picture's bottom, under clear rows that make it 92 px tall at every width (the 40-column bar's 7 : 1,
      // and n / 40 of it for n columns, as the box is), so Ghostty fits it by height
      const { w, h, at } = readPng(png(img)!), alpha = (x: number, y: number) => at(x, y)[3]
      expect([w, h]).toEqual([want * 16, 92])
      let low = 0, above = 0
      for (let x = 0; x < w; x++) { if (alpha(x, h - 64 + 59)) low++; for (let y = 0; y < h - 64; y++) if (alpha(x, y)) above++ }
      expect(low).toBeGreaterThan(0)   // the floor's shadow, 5 px above the picture's bottom edge: the frame sits at the bottom
      expect(above).toBe(0)            // and nothing above it
      let clear = 0
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha(x, y) === 0) clear++
      expect([alpha(0, 0), alpha(w - 1, 0), alpha(0, h - 1), alpha(w - 1, h - 1)]).toEqual([0, 0, 0, 0])
      expect(clear / (w * h)).toBeGreaterThan(cols === 8 ? 0.3 : 0.6)   // the crab covers some of a narrow bar, little of a wide one
      // bled: a clear pixel beside the crab carries its visible neighbours' colour (alpha-weighted), not black, so the terminal's linear
      // scaling draws no dark rim at the crab's edges
      let rim = 0, off = 0
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        if (alpha(x, y)) continue
        const sum = [0, 0, 0]; let n = 0
        for (let Y = y - 1; Y <= y + 1; Y++) for (let X = x - 1; X <= x + 1; X++) { const p = at(X, Y); if (p[3]) { for (let c = 0; c < 3; c++) sum[c] += p[c] * p[3]; n += p[3] } }
        if (!n) continue
        rim++
        if (at(x, y).slice(0, 3).some((c: number, k: number) => Math.abs(c - sum[k] / n) > 0.51)) off++
      }
      expect(rim).toBeGreaterThan(20)
      expect(off).toBe(0)
      expect(await words(ui)).toEqual(['below'])   // no caption: the alt says it where the picture cannot
      await ui.unmount()
    }
    await clock.settle()
  })

  test('swaps the picture by blit, only when the pixels change, and the alt follows the events', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const blits: any[] = []
    on('ui.blit', ($: any, e: any) => { blits.push(e); return { value: {} } })

    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', requestId: 'band-1', ...BAND })
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's-1' })
    await clock.advance(2000)
    expect(blits.length).toBeGreaterThan(10)   // a reaction changes most frames at 20 a second
    for (const b of blits) { expect([b.requestId, b.key]).toEqual(['band-1', 'crab']); expect(b.source.png).toMatch(PNG) }
    expect(blits.filter((b, i) => i && b.source.png === blits[i - 1].source.png)).toHaveLength(0)   // only changes go out
    expect((await ui.find({ key: 'crab' }))?.props.alt).toBe('Crab: Thinking Cap')
    await ui.unmount()
  })

  test('a blit refused as "not mounted" is tried again on the next tick', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const tries: string[] = []
    on('ui.blit', ($: any, e: any) => { tries.push(e.source?.png); return tries.length === 1 ? { value: { deny: 'not mounted' } } : { value: {} } })
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    await clock.advance(500)
    expect(tries.length).toBeGreaterThanOrEqual(2)
    expect((await ui.find({ key: 'crab' }))?.type).toBe('Image')   // still the bar
    await ui.unmount()
  })

  test('a terminal that draws the alt instead: the half-block Clawd takes over, with its caption', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const cells: string[] = []
    on('ui.blit', ($: any, e: any) => { if (e.key === 'crab') return { value: { deny: NO_IMAGES } }; cells.push(e.cells); return { value: {} } })
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's-1' })
    await clock.advance(1000)
    expect(await ui.find({ key: 'crab' })).toBeUndefined()
    expect((await ui.find({ key: 'clawd' }))?.type).toBe('Raster')
    expect(await words(ui)).toEqual(['below', 'Thinking Cap'])
    await clock.advance(2000)
    expect(cells.length).toBeGreaterThanOrEqual(2)   // and it animates by blit as before
    await ui.unmount()
  })

  test('stays out of the way: under a survey, in a band too narrow or too short, on the editor and mobile surfaces', async ($, on) => {
    mock.clock(on)
    otherMod(on)
    const cases = [
      { surface: 'terminal' as const, props: { ...PROPS, hasSurvey: true } },
      { surface: 'terminal' as const, props: { ...PROPS, bodyColumns: 7 } },   // 5 columns: 40 units, under a reaction's 45
      { surface: 'terminal' as const, props: { ...PROPS, maxRows: 1 } },
      { surface: 'desktop' as const, props: { ...PROPS, hasSurvey: true } },
      { surface: 'vscode' as const, props: PROPS },
      { surface: 'mobile' as const, props: PROPS },
    ]
    for (const c of cases) {
      const ui = await $.ui.mount({ plugin: 'notch-crab', component: 'AbovePrompt', ...c } as any)
      expect(await words(ui)).toEqual(['below'])
      expect(await ui.find({ key: 'crab' })).toBeUndefined()
      expect(await ui.find({ key: 'clawd' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('show "notch": no band anywhere, and the events still reach the bridge', { options: { show: 'notch' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'notch-crab', surface, ...BAND })
      expect(await words(ui)).toEqual(['below'])
      expect(await ui.find({ key: 'crab' })).toBeUndefined()
      await ui.unmount()
    }
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    await clock.advance(100)
    expect(events(posts)).toEqual(['Stop'])
    expect(posts.polls).toEqual([])   // no band, no look to fetch
  })
})

// PostToolBatch closes every batch, a lone tool's too, in the same second as its result: the crab juggles only when several tools ran at once
describe('the batch', () => {
  const failed = { session_id: 's-1', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {}, error: 'exit 1' }
  const call = (id: string) => ({ tool_name: 'Bash', tool_input: {}, tool_use_id: id })

  test('one tool: its own reaction plays out, and the bridge still gets the batch', { options: { hud: 'off' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await $.classic.PostToolUseFailure(failed as any)
    await $.classic.PostToolBatch({ session_id: 's-1', tool_calls: [call('toolu_1')] } as any)
    await clock.advance(100)
    expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Crab: Oops (Bash)')
    expect(events(posts)).toEqual(['PostToolUseFailure', 'PostToolBatch'])   // the bridge releases held prompts on it
    expect(posts.at(-1)!.body).toMatchObject({ hook_event_name: 'PostToolBatch', session_id: 's-1', tool_calls_count: '1', show: 'both' })   // the notch skips it too
    expect(Object.keys(posts.at(-1)!.body).sort()).toEqual(['cwd', 'hook_event_name', 'session_id', 'show', 'tool_calls_count'])
    await ui.unmount()
  })

  test('several tools at once: the crab juggles', { options: { hud: 'off' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Read', tool_use_id: 'toolu_1', tool_input: {}, tool_response: '' })
    await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: {}, tool_response: '' })
    await $.classic.PostToolBatch({ session_id: 's-1', tool_calls: [call('toolu_1'), call('toolu_2')] } as any)
    await clock.advance(100)
    expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Crab: Juggler')
    expect(posts.at(-1)!.body).toMatchObject({ hook_event_name: 'PostToolBatch', session_id: 's-1', tool_calls_count: '2', show: 'both' })   // a count, never the calls
    expect(Object.keys(posts.at(-1)!.body).sort()).toEqual(['cwd', 'hook_event_name', 'session_id', 'show', 'tool_calls_count'])
    await ui.unmount()
  })

  test('a batch without its list of calls is taken as one tool', { options: { hud: 'off' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Edit', tool_use_id: 'toolu_2', tool_input: {}, tool_response: '' })
    await $.classic.PostToolBatch({ session_id: 's-1' } as any)
    await clock.advance(100)
    expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('Crab: Nailed It (Edit)')
    await ui.unmount()
  })
})

describe('the bar, in the Code tab', () => {
  test('an animated SVG of the next seconds (SMIL, drawn as an image), transparent around the crab, at the notch\'s size', { options: { hud: 'off' } }, async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    const svg = await ui.find({ type: 'Svg' })   // the Code tab keeps no key on an Svg
    expect(svg?.type).toBe('Svg')
    expect(svg?.props).toEqual(expect.objectContaining({ alt: 'Crab: Idle', width: 320, height: 32 }))   // the notch's size, not the slot's
    expect(svg?.props.isInteractive).toBeFalsy()   // an image: the Code tab's sandboxed frame reloads blank on every render, an image swaps cleanly
    const src = svg?.props.source as string
    expect(src).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 640 64" width="320" height="32" shape-rendering="crispEdges">/)
    expect(src).not.toMatch(/<rect width="640" height="64"/)   // no bar behind the crab: transparent, on the Code tab's own grey
    expect(src).toContain('<animateTransform')
    expect(src).not.toMatch(/<animate\s|<script|on[a-z]+=/)
    expect(src.length).toBeLessThanOrEqual(131072)
    expect(src).toMatch(/dur="12s"/)   // idle: twelve seconds ahead
    expect(await words(ui)).toEqual(['below'])
    await ui.unmount()
    await clock.settle()
  })

  test('an event draws it again from the band as it is then; a running turn looks 4 s ahead; the end of the timeline draws it again', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    const first = (await ui.find({ type: 'Svg' }))?.props.source
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's-1' })
    await ui.redraw({ ...PROPS, isWorking: true })
    await clock.advance(100)
    const working = await ui.find({ type: 'Svg' })
    expect(working?.props.source === first).toBe(false)
    expect(working?.props.source).toMatch(/dur="4s"/)
    expect(working?.props.alt).toBe('Crab: Thinking Cap')
    await clock.advance(4100)   // the timeline ran out: drawn again, the crab still thinking
    const again = await ui.find({ type: 'Svg' })
    expect(again?.props.source === working?.props.source).toBe(false)
    expect(again?.props.alt).toBe('Crab: Thinking Cap')
    await ui.unmount()
  })
})

describe('the look, from the bridge', () => {
  test('GET /style over the socket: the band wears what the bridge says, then asks again with the tag it has', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    on('session.id', () => ({ value: 's-7' }))
    let n = 0
    const bow = { id: 'bow', name: 'Bow', palette: 'coral', pal: null, accent: '#5B8DFF', hat: null, hair: null, eyewear: null, neck: null, face: [], pattern: null }
    const posts = bridge(on, undefined, async () => {
      n++
      if (n === 1) return { value: NOT_FOUND }   // the session's first hook has not reached the bridge yet
      if (n === 2) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ session: 's-7', style: bow, tag: 'abc123def456' }) } }
      await clock.sleep(20_000); return { value: NO_CONTENT }   // held: the look has not changed
    })
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    expect((await ui.find({ key: 'crab' }))?.props.alt).toBe('Crab: Idle')
    await clock.advance(2100)   // the 404, two seconds, then the 200
    expect(posts.polls.slice(0, 2).map((p) => [p.url.pathname + p.url.search, p.socketPath])).toEqual([['/style?session=s-7', SOCK], ['/style?session=s-7', SOCK]])
    expect((await ui.find({ key: 'crab' }))?.props.alt).toBe('Bow: Idle')
    expect(posts.polls[2]?.url.search).toBe('?session=s-7&tag=abc123def456')
    await ui.unmount()
  })

  // 15 s, not the default 5: the 15 s it steps are 300 terminal frames, each a PNG encode (about 4.5 s in all on an M-series Mac)
  test('outfit "plain" never asks: the plain orange crab', { options: { outfit: 'plain' }, timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })
    await clock.advance(100)
    expect((await ui.find({ key: 'crab' }))?.props.alt).toBe('Crab: Order Up')
    await clock.advance(15_000)   // the beat ends: drawn again, so the alt says so too
    expect(posts.polls).toEqual([])
    expect((await ui.find({ key: 'crab' }))?.props.alt).toBe('Crab: Idle')
    await ui.unmount()
  })

  test('no bridge: the plain crab, and the band still plays', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    on('http.fetch', () => ({ deny: 'ECONNREFUSED' }))
    on('classic.*', () => ({}))
    otherMod(on)
    const blits: any[] = []
    on('ui.blit', ($: any, e: any) => { blits.push(e); return { value: {} } })
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Edit', tool_use_id: 'toolu_2', tool_input: {}, tool_response: '' })
    await clock.advance(1500)
    expect(blits.length).toBeGreaterThan(5)
    expect((await ui.find({ key: 'crab' }))?.props.alt).toBe('Crab: Nailed It (Edit)')
    await ui.unmount()
  })
})

// The half-block Clawd: what a terminal with no pictures shows. Each test first has the bar's blit refused the way such a terminal refuses it.
async function noPictures(clock: any, ui: any) {
  await clock.advance(3000)   // the bar's first change goes out by blit, is refused, and the band is drawn again as the Clawd
  expect((await ui.find({ key: 'clawd' }))?.type).toBe('Raster')
}
const refuseBar = (rest: (e: any) => any) => ($: any, e: any) => (e.key === 'crab' ? { value: { deny: NO_IMAGES } } : rest(e))

describe('the half-block Clawd, in a terminal with no pictures', () => {
  test('draws the crab beside a caption, keeps the other mods, and follows the events', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })   // not inside a blink (now % 4000 < 150)
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    on('ui.blit', refuseBar(() => ({ value: {} })))
    otherMod(on)

    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await noPictures(clock, ui)
    expect((await ui.find({ key: 'clawd' }))?.props).toEqual(expect.objectContaining({ columns: 14, rows: 4 }))
    expect(await words(ui)).toEqual(['below', 'Idle'])

    await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's-1' })
    await clock.advance(100)
    expect(await words(ui)).toEqual(['below', 'Thinking Cap'])

    await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Edit', tool_use_id: 'toolu_2', tool_input: {}, tool_response: '' })
    await clock.advance(100)
    expect(await words(ui)).toEqual(['below', 'Nailed It', 'Edit'])
    await ui.unmount()
  })

  test('animates by blit: each new frame once, to the band and the crab, with the frame of that moment', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const blits: any[] = []
    on('ui.blit', refuseBar((e) => { blits.push({ ...e, at: clock.now() }); return { value: {} } }))

    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', requestId: 'band-1', ...BAND })
    await noPictures(clock, ui)
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's-1' })
    const band = { event: 'UserPromptSubmit', tool: '', at: clock.now() }
    await clock.advance(100)
    blits.length = 0
    await clock.advance(2000)

    expect(blits.length).toBeGreaterThanOrEqual(3)   // the thought bubble rises every 450 ms
    for (const b of blits) {
      expect([b.requestId, b.key]).toEqual(['band-1', 'clawd'])
      expect(b.cells).toBe(frameAt(band, true, b.at).cells)
    }
    for (let i = 1; i < blits.length; i++) expect(blits[i].cells).not.toBe(blits[i - 1].cells)   // only changes go out
    await ui.unmount()
  })

  test('a refused blit is tried again on the next tick', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const tries: string[] = []
    on('ui.blit', refuseBar((e) => { tries.push(e.cells); return tries.length === 1 ? { value: { deny: 'not mounted' } } : { value: {} } }))

    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await noPictures(clock, ui)
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's-1' })
    await clock.advance(100)   // drawn again with the thinking crab
    tries.length = 0
    await clock.advance(450 + 300)   // the bubble's first move at 450 ms (refused at the next tick), then the tick after
    expect(tries.length).toBeGreaterThanOrEqual(2)
    expect(tries[1]).toBe(tries[0])
    await ui.unmount()
  })

  test('a loop pose ends with the turn: after isWorking goes false the crab settles to idle', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    on('session.id', () => ({ value: 's-1' }))
    on('session.cwd', () => ({ value: '/work' }))
    on('tool.call', () => ({ result: 'done' }))
    otherMod(on)
    const blits: string[] = []
    on('ui.blit', refuseBar((e) => { blits.push(e.cells); return { value: {} } }))

    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await noPictures(clock, ui)
    await $.tool.call({ tool: 'Bash', command: 'sleep 9' })   // PreToolUse, then an interrupted turn: no PostToolUse, no Stop
    await clock.advance(600)
    expect((await ui.find({ key: 'clawd' }))?.props.cells).toBe(encode(FRAMES.tool[0]))   // the hardhat is on
    blits.length = 0
    await clock.advance(400)
    expect(blits.length).toBeGreaterThan(0)                                             // and the pincer taps
    expect(blits).not.toContain(IDLE)
    await ui.redraw({ ...PROPS, isWorking: false })
    expect((await ui.find({ key: 'clawd' }))?.props.cells).toBe(IDLE)
    const after = blits.length
    await clock.advance(1000)   // the clock must agree with the drawing: no hardhat frame comes back by blit
    expect(blits.slice(after).every((c) => c === IDLE || c === encode(FRAMES.blink[0]))).toBe(true)
    await ui.unmount()
  })

  test('the same success twice restarts the beat: done holds for ONCE_MS after the second one', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const blits: string[] = []
    on('ui.blit', refuseBar((e) => { blits.push(e.cells); return { value: {} } }))

    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await noPictures(clock, ui)
    const ok = () => $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Edit', tool_use_id: 'toolu_3', tool_input: {}, tool_response: '' })
    await ok()
    await clock.advance(ONCE_MS - 500)
    await ok()
    await clock.advance(100)
    blits.length = 0
    await clock.advance(1000)   // past the first one's end, inside the second one's
    expect(blits).not.toContain(IDLE)
    await clock.advance(ONCE_MS)
    expect(blits).toContain(IDLE)
    await ui.unmount()
  })
})

// ---------------------------------------------------------------- the HUD beside the crab

// $.session.usage as a typical 1M-window session reports it: a 1M window, auto-compact at 400k (breakdown 'summary' only), the two limits
const NOW = 10_000
const at = (ms: number) => new Date(NOW + ms).toISOString()
const LIMITS = [
  { kind: 'five_hour', percentUsed: 30, resetsAt: at(130 * 60_000) },   // resets in 2h10
  { kind: 'seven_day', percentUsed: 72, resetsAt: at(3 * 86_400_000) },
]
const CONTEXT = { tokens: 180_000, window: 1_000_000, percent: 18 }
const BREAKDOWN = { autoCompactThreshold: 400_000, isAutoCompactEnabled: true }
function usage(on: any, u: { context?: any; rateLimits?: any[] } = {}) {
  const calls: any[] = []
  on('session.usage', ($: any, e: any) => {
    calls.push(e)
    const context = u.context ?? { window: 1_000_000 }
    return { value: { startedAt: 0, rateLimits: u.rateLimits ?? [], context: e?.breakdown ? { ...context, breakdown: BREAKDOWN } : context } }
  })
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))   // core's echo, beneath the plugins
  return calls
}
const measure = ($: any, rateLimits: any[] = LIMITS, context: any = CONTEXT) =>
  $.session.measure({ context, rateLimits, changed: ['context', 'rateLimits'] })
const hudSvgOf = async (ui: any) => (await ui.findAll({ type: 'Svg' }))[1]
// a Raster's cells as text, row by row (the glyphs only)
function glyphs(cells: string, columns: number) {
  const b = Uint8Array.from(atob(cells), (c) => c.charCodeAt(0)), rows: string[] = []
  for (let i = 0, s = ''; i < b.length; i += 12) {
    s += String.fromCodePoint(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16))
    if ((i / 12 + 1) % columns === 0) { rows.push(s); s = '' }
  }
  return rows
}
const todo = ($: any, todos: { content: string; status: string }[], extra: any = {}) => $.classic.PostToolUse({
  session_id: 's-1', tool_name: 'TodoWrite', tool_use_id: 'toolu_t', tool_input: { todos: todos.map((t) => ({ ...t, activeForm: t.content })) },
  tool_response: { oldTodos: [], newTodos: todos.map((t) => ({ ...t, activeForm: t.content })) }, ...extra,
})

describe('the HUD beside the crab', () => {
  test('the Code tab: the crab\'s Svg and the HUD\'s in a row, the HUD the room after him (80 columns: 627 - 160 = 467) with the figures in its alt', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: LIMITS })   // what $.session.usage reads agrees with what session.measure pushes
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    let svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs).toHaveLength(2)
    expect(svgs[0].props).toEqual(expect.objectContaining({ alt: 'Crab: Idle', width: 160, height: 32 }))   // the crab, his walk halved beside the HUD
    expect(svgs[0].props.source).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 320 64" width="160" height="32" /)
    expect(svgs[1].props).toEqual(expect.objectContaining({ width: 467, height: 32 }))
    expect(svgs[1].props.isInteractive).toBeFalsy()
    expect(svgs[1].props.alt).toBe('Context not measured yet. Usage limits not measured yet.')   // fresh: '--' in the slots the figures fill
    const row = (await ui.findAll({ type: 'Box' })).find((b: any) => b.props.flexDirection === 'row')
    expect(row?.children).toHaveLength(2)

    await measure($)
    await clock.advance(200)
    svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs[1].props.alt).toBe('Context 45% of auto-compact. 5-hour limit 30%, resets in 2h10. Weekly limit 72%, resets in 3d.')
    const src = svgs[1].props.source as string
    expect(src).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="467" height="32"/)
    expect(src).not.toMatch(/<text|<script|on[a-z]+=/)
    expect(await words(ui)).toEqual(['below'])
    // the next turn's measurement, pushed: drawn again with it
    await measure($, [{ ...LIMITS[0], percentUsed: 55 }, LIMITS[1]], { ...CONTEXT, tokens: 300_000 })
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toBe('Context 75% of auto-compact. 5-hour limit 55%, resets in 2h10. Weekly limit 72%, resets in 3d.')
    await ui.unmount()
  })

  test('a terminal with pictures: the HUD Raster beside the crab Image, 2 rows, in what the band has left', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: LIMITS })
    otherMod(on)
    const blits: any[] = []
    on('ui.blit', ($: any, e: any) => { if (e.key === 'hud') blits.push(e); return { value: {} } })
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    const hud = await ui.find({ key: 'hud' })
    expect(hud?.type).toBe('Raster')
    expect(hud?.props).toEqual(expect.objectContaining({ columns: 80 - 20 - 2 - 4, rows: 2 }))
    expect((await ui.find({ key: 'crab' }))?.props).toEqual(expect.objectContaining({ columns: 20, rows: 2 }))   // the walk halved beside it
    const row = (await ui.findAll({ type: 'Box' })).find((b: any) => b.props.flexDirection === 'row')
    expect(row?.children).toHaveLength(2)
    expect(glyphs(hud!.props.cells as string, 54)[0]).toMatch(/^CTX +-- /)   // before the seed lands: '--', never 0
    // the seed (a timer the first drawing starts) reads the usage; the HUD goes out by blit, the band is not drawn again for it
    await clock.advance(200)
    expect(blits.length).toBeGreaterThanOrEqual(1)
    expect(glyphs(blits.at(-1).cells, 54)[0]).toMatch(/^CTX +45%/)
    // narrow: no room for 16 columns beside even the halved crab (41 < 20 + 2 + 16 + 4), no HUD, and the crab keeps the whole walk
    await ui.redraw({ ...PROPS, bodyColumns: 41 })
    expect(await ui.find({ key: 'hud' })).toBeUndefined()
    expect((await ui.find({ key: 'crab' }))?.props).toEqual(expect.objectContaining({ columns: 39, rows: 2 }))
    await ui.unmount()
  })

  test('a terminal with no pictures: the HUD on top of the half-block Clawd\'s caption', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    on('ui.blit', refuseBar(() => ({ value: {} })))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await noPictures(clock, ui)
    expect((await ui.find({ key: 'hud' }))?.props).toEqual(expect.objectContaining({ columns: 80 - 14 - 4 - 4, rows: 2 }))
    expect(await words(ui)).toEqual(['below', 'Idle'])
    await ui.unmount()
  })

  test('TaskCreate / TaskUpdate change the tasks row; a finished list flashes, then its row goes', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    const task = (tool_name: string, tool_input: any, tool_response: any) =>
      $.classic.PostToolUse({ session_id: 's-1', tool_name, tool_use_id: 'toolu_x', tool_input, tool_response })
    await task('TaskCreate', { subject: 'Write the tests', description: 'all of them' }, { task: { id: '1', subject: 'Write the tests' } })
    await task('TaskCreate', { subject: 'Ship it', description: 'today' }, { task: { id: '2', subject: 'Ship it' } })
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 0 of 2\.$/)
    await task('TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } })
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 1 of 2\.$/)
    await task('TaskUpdate', { taskId: '2', status: 'in_progress' }, { success: false, taskId: '2', updatedFields: [], error: 'no' })   // refused: no change
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.source).not.toMatch(/fill-rule="evenodd" fill="#9C7EF5"/)   // no task drawn in progress (hollow violet)
    await task('TaskUpdate', { taskId: '2', status: 'in_progress' }, { success: true, taskId: '2', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } })
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.source).toMatch(/fill-rule="evenodd" fill="#9C7EF5"/)    // the same update, accepted: it is
    await task('TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true, taskId: '2', updatedFields: ['status'] })
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks all 1 done\.$/)
    await clock.advance(5200)   // DONE_MS: the gold row goes, drawn again by a timer of its own
    expect((await hudSvgOf(ui))?.props.alt).not.toMatch(/Tasks/)
    // a new task after a finished list starts a new list, not '2 of 3'
    await task('TaskCreate', { subject: 'Next', description: 'later' }, { task: { id: '3', subject: 'Next' } })
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 0 of 1\.$/)
    await ui.unmount()
  })

  test('TodoWrite sets the list; a subagent\'s TodoWrite is its own, not the session\'s; no task text reaches the bridge', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    const posts = bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const blits: any[] = []
    on('ui.blit', ($: any, e: any) => { blits.push(e); return { value: {} } })
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await todo($, [{ content: 'secret plan one', status: 'completed' }, { content: 'secret plan two', status: 'in_progress' }, { content: 'secret plan three', status: 'pending' }])
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 1 of 3\.$/)
    await todo($, [{ content: 'secret sub task', status: 'pending' }], { agent_id: 'agent-7' })
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 1 of 3\.$/)
    expect(events(posts).filter((n) => n === 'PostToolUse')).toHaveLength(2)
    expect(JSON.stringify(posts)).not.toMatch(/secret|todos|newTodos/)
    expect(JSON.stringify(blits)).not.toMatch(/secret/)
    expect(JSON.stringify(await ui.findAll({ type: 'Svg' }))).not.toMatch(/secret/)
    await ui.unmount()
  })

  test('a resumed session knows its list: the seed replays the transcript\'s task calls, errors skipped', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    const todos = (s: string[]) => s.map((status, i) => ({ content: `t${i}`, status, activeForm: `t${i}` }))
    on('session.messages', () => ({ value: [
      { role: 'user', text: 'hi', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'TodoWrite', input: { todos: todos(['pending', 'pending', 'pending']) }, result: { oldTodos: [], newTodos: todos(['pending', 'pending', 'pending']) } }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'TodoWrite', input: { todos: todos(['completed', 'completed', 'pending']) }, result: { oldTodos: [], newTodos: todos(['completed', 'completed', 'pending']) } }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c', tool: 'TodoWrite', input: { todos: todos(['completed', 'completed', 'completed']) }, isError: true, result: 'refused' }] },
    ] }))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(300)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 2 of 3\.$/)
    await ui.unmount()
  })

  test('measured with no limits at all (not a subscription): row B goes, on purpose; until then it holds its slots', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT })
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    const before = (await hudSvgOf(ui))?.props
    expect(before?.alt).toMatch(/Usage limits not measured yet\./)
    await measure($, [])
    await clock.advance(200)
    const after = (await hudSvgOf(ui))?.props
    expect(after?.alt).toBe('Context 45% of auto-compact.')
    expect(after?.width).toBe(467)
    // row A alone, centred: its cells at y 13 (with row B they sit at 5 and 21)
    expect(before?.source).toMatch(/M\d+ 5h5v7h-5z/)
    expect(after?.source).toMatch(/M\d+ 13h5v7h-5z/)
    expect(after?.source).not.toMatch(/M\d+ (5|21)h5v7h-5z/)
    await ui.unmount()
  })

  test('a subscription whose windows drop for a moment (a reset passed) keeps row B, drawn --', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on)
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await measure($)
    await clock.advance(200)
    await measure($, [])
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toBe('Context 45% of auto-compact. Usage limits not measured yet.')
    await ui.unmount()
  })

  test('a terminal\'s HUD moves with the clock: a limit at 100% counts down its reset by blit, with no event', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: at(45 * 60_000) }, LIMITS[1]] })
    otherMod(on)
    const blits: any[] = []
    on('ui.blit', refuseBar((e) => { if (e.key === 'hud') blits.push(e); return { value: {} } }))   // the half-block Clawd: its clock is cheap to step
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', requestId: 'band-1', ...BAND, props: { ...PROPS, bodyColumns: 120 } })
    await noPictures(clock, ui)
    if (!blits.length) blits.push({ requestId: 'band-1', cells: (await ui.find({ key: 'hud' }))!.props.cells })   // seeded before the redraw
    expect(glyphs(blits.at(-1).cells, 72)[0]).toContain('45m')
    const n = blits.length
    await clock.advance(61_000)
    expect(blits.length).toBeGreaterThan(n)
    expect(blits.at(-1).requestId).toBe('band-1')
    expect(glyphs(blits.at(-1).cells, 72)[0]).toContain('44m')
    await ui.unmount()
  })

  test('hud "off": the band exactly as before, and no usage read', { options: { hud: 'off' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    const calls = usage(on, { context: CONTEXT, rateLimits: LIMITS })
    otherMod(on)
    const desk = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await measure($)
    await todo($, [{ content: 'a', status: 'pending' }])
    await clock.advance(300)
    expect(await desk.findAll({ type: 'Svg' })).toHaveLength(1)
    expect((await desk.find({ type: 'Svg' }))?.props.width).toBe(320)   // the whole walk: no HUD beside him
    expect((await desk.findAll({ type: 'Box' })).some((b: any) => b.props.flexDirection === 'row')).toBe(false)
    await desk.unmount()
    const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    expect(await term.find({ key: 'hud' })).toBeUndefined()
    expect((await term.find({ key: 'crab' }))?.props.columns).toBe(40)
    expect((await term.find({ key: 'crab' }))?.type).toBe('Image')
    await term.unmount()
    expect(calls).toEqual([])
  })

  test('a session.usage that rejects (the test kit\'s default) never breaks the band or an event', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.Stop', () => ({ additionalContext: ['kept'] }))
    on('classic.PostToolUse', () => ({ decision: undefined }))
    on('session.measure', ($: any, e: any) => ({ changed: e.changed }))   // core's echo; session.usage and session.messages stay unanswered
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(300)
    expect(await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Edit', tool_use_id: 'toolu_9', tool_input: {}, tool_response: '' })).toEqual({ decision: undefined })
    expect(await $.classic.Stop({ stop_hook_active: false, session_id: 's-1' })).toEqual({ additionalContext: ['kept'] })
    await clock.advance(300)
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs[0].props.alt).toBe('Crab: Order Up')
    expect(svgs[1].props.alt).toBe('Context not measured yet. Usage limits not measured yet.')
    // session.measure still lands: no breakdown either, so the threshold falls back to the window less 33k (180k of 967k)
    await measure($)
    await clock.advance(300)
    expect((await hudSvgOf(ui))?.props.alt).toBe('Context 19% of auto-compact. 5-hour limit 30%, resets in 2h10. Weekly limit 72%, resets in 3d.')
    await ui.unmount()
  })

  // ---- review fixes (2026-10-02)

  test('a resumed session: the seed\'s usage has the transcript\'s tokens and no limits yet, and row B holds its slots', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: [] })   // what --resume reads before any response this process has seen
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    const before = (await hudSvgOf(ui))?.props.source
    await clock.advance(300)
    const after = (await hudSvgOf(ui))?.props
    expect(after?.alt).toBe('Context 45% of auto-compact. Usage limits not measured yet.')
    expect(after?.source).toMatch(/M\d+ 21h5v7h-5z/)   // row B still there, row A at y 5: no jump
    expect(after?.source).not.toMatch(/M\d+ 13h5v7h-5z/)
    expect(before).toMatch(/M\d+ 5h5v7h-5z/)
    // the first response's measurement brings the limits into the same slots
    await measure($)
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/5-hour limit 30%/)
    await ui.unmount()
  })

  test('/clear: the old conversation\'s task counts go at once (a new session id, a new list)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await todo($, [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }])
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 1 of 2\.$/)
    await $.classic.SessionEnd({ session_id: 's-1', reason: 'clear' })
    await $.classic.SessionStart({ session_id: 's-2', source: 'clear' })
    await clock.advance(2000)
    expect((await hudSvgOf(ui))?.props.alt).not.toMatch(/Tasks/)
    await ui.unmount()
  })

  test('an in-process /resume: the other conversation\'s list is replayed from its transcript', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    let transcript: any[] = []
    on('session.messages', () => ({ value: transcript }))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(200)
    await todo($, [{ content: 'a', status: 'pending' }])
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 0 of 1\.$/)
    const todos = ['completed', 'completed', 'pending'].map((status, i) => ({ content: `t${i}`, status, activeForm: `t${i}` }))
    transcript = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r', tool: 'TodoWrite', input: { todos }, result: { oldTodos: [], newTodos: todos } }] }]
    await $.classic.SessionEnd({ session_id: 's-1', reason: 'resume' })
    await $.classic.SessionStart({ session_id: 's-3', source: 'resume' })
    await clock.advance(300)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 2 of 3\.$/)
    await ui.unmount()
  })

  test('a replayed list that ended all done shows no row at load (no gold flash for an old list)', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    const todos = ['completed', 'completed'].map((status, i) => ({ content: `t${i}`, status, activeForm: `t${i}` }))
    on('session.messages', () => ({ value: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'TodoWrite', input: { todos }, result: { oldTodos: [], newTodos: todos } }] }] }))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(300)
    const h = (await hudSvgOf(ui))?.props
    expect(h?.alt).not.toMatch(/Tasks/)
    expect(h?.source).not.toMatch(/url\(#ggold\)/)
    await ui.unmount()
  })

  test('mid-turn: a tool call (no session.measure) reads the usage again, on both surfaces', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    let tokens = 180_000
    on('session.usage', ($: any, e: any) => {
      const context = { tokens, window: 1_000_000 }
      return { value: { startedAt: 0, rateLimits: LIMITS, context: e?.breakdown ? { ...context, breakdown: BREAKDOWN } : context } }
    })
    otherMod(on)
    const blits: any[] = []
    on('ui.blit', ($: any, e: any) => { if (e.key === 'hud') blits.push(e); return { value: {} } })
    const desk = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(300)
    expect((await hudSvgOf(desk))?.props.alt).toMatch(/^Context 45% /)
    tokens = 300_000
    await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Read', tool_use_id: 'toolu_r', tool_input: {}, tool_response: '' })
    await clock.advance(200)
    expect((await hudSvgOf(desk))?.props.alt).toMatch(/^Context 75% /)
    await desk.unmount()
  })

  test('mid-turn in a terminal: the tool call\'s usage read goes out by blit', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    let tokens = 180_000
    on('session.usage', ($: any, e: any) => {
      const context = { tokens, window: 1_000_000 }
      return { value: { startedAt: 0, rateLimits: LIMITS, context: e?.breakdown ? { ...context, breakdown: BREAKDOWN } : context } }
    })
    otherMod(on)
    const blits: any[] = []
    on('ui.blit', ($: any, e: any) => { if (e.key === 'hud') blits.push(e); return { value: {} } })
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await clock.advance(300)
    expect(glyphs(blits.at(-1).cells, 34)[0]).toMatch(/^CTX +45%/)
    tokens = 300_000
    await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Read', tool_use_id: 'toolu_r', tool_input: {}, tool_response: '' })
    await clock.advance(200)
    expect(glyphs(blits.at(-1).cells, 34)[0]).toMatch(/^CTX +75%/)
    await ui.unmount()
  })

  test('a burst of tool calls: one usage read out at a time, and one more after it so the last call is read', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    let tokens = 180_000, plain = 0, inFlight = 0, most = 0
    on('session.usage', async ($: any, e: any) => {
      if (!e?.breakdown) { plain++; most = Math.max(most, ++inFlight); await clock.sleep(50); inFlight-- }
      const context = { tokens, window: 1_000_000 }
      return { value: { startedAt: 0, rateLimits: LIMITS, context: e?.breakdown ? { ...context, breakdown: BREAKDOWN } : context } }
    })
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(300)
    plain = 0
    const call = () => $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Read', tool_use_id: 'toolu_r', tool_input: {}, tool_response: '' })
    await call(); await call(); await call()
    tokens = 300_000
    await call()
    await clock.advance(400)
    expect(most).toBe(1)
    expect(plain).toBe(2)   // the first, then one trailing read for the other three
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/^Context 75% /)
    await ui.unmount()
  })

  test('a task event that lands while the replay reads the transcript wins over it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    const todos = ['pending', 'pending', 'pending'].map((status, i) => ({ content: `t${i}`, status, activeForm: `t${i}` }))
    on('session.messages', async () => {
      await clock.sleep(500)
      return { value: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'TodoWrite', input: { todos }, result: { oldTodos: [], newTodos: todos } }] }] }
    })
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(100)
    await todo($, [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }])
    await clock.advance(1000)
    expect((await hudSvgOf(ui))?.props.alt).toMatch(/Tasks 1 of 2\.$/)
    await ui.unmount()
  })

  test('a HUD blit refused (the band not mounted yet) draws the band again, with the new figures in the Raster', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: LIMITS })
    otherMod(on)
    let refused = 0
    on('ui.blit', ($: any, e: any) => (e.key === 'hud' && !refused++ ? { value: { deny: 'not mounted' } } : { value: {} }))
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    expect(glyphs((await ui.find({ key: 'hud' }))!.props.cells as string, 34)[0]).toMatch(/^CTX +-- /)
    await clock.advance(300)
    expect(refused).toBeGreaterThanOrEqual(1)
    expect(glyphs((await ui.find({ key: 'hud' }))!.props.cells as string, 34)[0]).toMatch(/^CTX +45%/)
    await ui.unmount()
  })

  test('a measurement that changes nothing the HUD draws costs the Code tab no new drawing', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: LIMITS })
    let renders = 0
    on('ui.render', ($: any, e: any) => { renders++; return $.ui.resolve(e).Text({ children: 'below' }) })
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await measure($)
    await clock.advance(300)
    const n = renders
    await measure($)
    await clock.advance(200)
    expect(renders).toBe(n)
    await measure($, LIMITS, { ...CONTEXT, tokens: 300_000 })   // and one that does: drawn again
    await clock.advance(200)
    expect(renders).toBeGreaterThan(n)
    await ui.unmount()
  })

  test('the Code tab: the crab and a column Box holding the HUD, in a row that does not wrap, and no sizing prop anywhere', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    const boxes = await ui.findAll({ type: 'Box' })
    const row = boxes.find((b: any) => b.props.flexDirection === 'row')
    expect(row?.props.flexWrap).toBeUndefined()   // a wrapping row dropped the HUD under him whenever the room came out even 1 px too wide
    // the HUD in a column Box: its image adds nothing to the Box's min-content, so it can shrink into the room (an image straight in the row cannot)
    const name = await namer(ui)
    expect(row?.children.map(name)).toEqual(['crab', 'column'])
    expect(row?.children[1].children.map(name)).toEqual(['hud'])
    expect(boxes.flatMap((b: any) => SIZING.filter((k) => b.props?.[k] !== undefined))).toEqual([])
    await clock.advance(1)
    await ui.unmount()
  })

  test('the Code tab\'s HUD follows the window: the room after the crab, 160..600, and under him when the room is under 220', { timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: LIMITS })
    let renders = 0
    on('ui.render', ($: any, e: any) => { renders++; return $.ui.resolve(e).Text({ children: 'below' }) })
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await measure($)
    await clock.advance(300)
    // [the band's columns, where the HUD is, its width]: floor(columns x 7.84) is the band, less the crab's 160 the room. 95: a 768 px band at
    // 120% (752 inside, 1ch 7.8516), the HUD ending 8 px short of its end; 120: past the cap, the HUD stays 600
    for (const [cols, where, width] of [[95, 'beside', 584], [120, 'beside', 600], [49, 'beside', 224], [48, 'under', 376], [30, 'under', 235], [15, 'under', 160]] as const) {
      await ui.redraw({ ...DESK.props, bodyColumns: cols })
      const svgs = await ui.findAll({ type: 'Svg' })
      expect([cols, svgs.map((v: any) => v.props.width)]).toEqual([cols, [160, width]])   // the crab 160 at every width
      expect([cols, (svgs[1].props.source as string).match(/^<svg [^>]*width="(\d+)"/)?.[1]]).toEqual([cols, String(width)])
      const outer = (await ui.findAll({ type: 'Box' })).find((b: any) => b.props.flexDirection === 'column' && b.children.some((c: any) => c.type === 'Text'))
      expect([cols, outer?.children.map(await namer(ui))]).toEqual([cols, where === 'beside' ? ['below', 'row'] : ['below', 'crab', 'hud']])
      expect((await ui.findAll({ type: 'Box' })).flatMap((b: any) => SIZING.filter((k) => b.props?.[k] !== undefined))).toEqual([])
      // the redraw check draws the HUD at the width the band drew it: the same figures cost no new drawing (one at another width would, every time)
      await clock.advance(300)
      const n = renders
      await measure($)
      await clock.advance(200)
      expect([cols, renders]).toEqual([cols, n])
    }
    await ui.unmount()
    await clock.settle()
  })
})

// ---------------------------------------------------------------- Claude Code's own drawing beneath, and which bars show

// the props the CLI's validator refuses on a Box above an engine node (validateTree, 2.1.286 / 2.1.287)
const SIZING = ['display', 'overflow', 'position', 'width', 'height', 'minWidth', 'minHeight', 'top', 'left', 'right', 'bottom']
const holds = (n: any, type: string): boolean => n?.type === type || (n?.children ?? []).some((c: any) => holds(c, type))
const sizedAboveEngine = async (ui: any) =>
  (await ui.findAll({ type: 'Box' })).filter((b: any) => holds(b, 'engine')).flatMap((b: any) => SIZING.filter((k) => b.props?.[k] !== undefined))

describe('Claude Code\'s own drawing beneath the band', () => {
  test('with no other mod (the real Code tab), every surface keeps the engine node and validates: the crab, the HUD beside it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: LIMITS })
    core(on)
    on('ui.blit', ($: any, e: any) => ({ value: {} }))
    const desk = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    // both of the Code tab's trees through the kit's validator, over the engine node: beside him (80 columns, and 120 at the cap) and under him (30)
    for (const cols of [80, 30, 120]) {
      if (cols !== 80) await desk.redraw({ ...DESK.props, bodyColumns: cols })
      expect([cols, (await desk.findAll({ type: 'Svg' })).length]).toEqual([cols, 2])   // a refused tree draws nothing of the mod's
      expect([cols, (await desk.findAll({ type: 'engine' })).length]).toEqual([cols, 1])
      expect([cols, await sizedAboveEngine(desk)]).toEqual([cols, []])
    }
    await desk.unmount()
    const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    expect((await term.find({ key: 'crab' }))?.type).toBe('Image')
    expect((await term.find({ key: 'hud' }))?.type).toBe('Raster')
    expect(await term.findAll({ type: 'engine' })).toHaveLength(1)
    expect(await sizedAboveEngine(term)).toEqual([])
    await term.unmount()
    await clock.settle()
  })

  test('the half-block Clawd and hud "off" keep it too', { options: { hud: 'off' } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    core(on)
    on('ui.blit', refuseBar(() => ({ value: {} })))
    const desk = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    expect(await desk.findAll({ type: 'Svg' })).toHaveLength(1)
    expect(await desk.findAll({ type: 'engine' })).toHaveLength(1)
    await desk.unmount()
    const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await noPictures(clock, term)
    expect(await term.findAll({ type: 'engine' })).toHaveLength(1)
    expect(await sizedAboveEngine(term)).toEqual([])
    await term.unmount()
  })

  test('the half-block Clawd with its HUD keeps it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    core(on)
    on('ui.blit', refuseBar(() => ({ value: {} })))
    const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await noPictures(clock, term)
    expect((await term.find({ key: 'hud' }))?.type).toBe('Raster')
    expect(await term.findAll({ type: 'engine' })).toHaveLength(1)
    expect(await sizedAboveEngine(term)).toEqual([])
    await term.unmount()
  })
})

describe('which bars show (hudContext, hudFiveHour, hudWeekly, hudTasks)', () => {
  test('the limits alone: no context or task bar, no auto-compact estimate and no transcript read', { options: { hudContext: false, hudTasks: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    const calls = usage(on, { context: CONTEXT, rateLimits: LIMITS })
    let reads = 0
    on('session.messages', () => { reads++; return { value: [] } })
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await measure($)
    await todo($, [{ content: 'a', status: 'pending' }])
    await clock.advance(300)
    const hud = (await hudSvgOf(ui))?.props
    expect(hud?.alt).toBe('5-hour limit 30%, resets in 2h10. Weekly limit 72%, resets in 3d.')
    expect(hud?.source).toMatch(/M\d+ 13h5v7h-5z/)   // row B alone, centred
    expect(hud?.source).not.toMatch(/M\d+ (5|21)h5v7h-5z/)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.some((c) => c?.breakdown)).toBe(false)
    expect(reads).toBe(0)
    await ui.unmount()
  })

  test('the task list alone: no HUD until there is a list, then it comes and goes on both surfaces; no usage read', { options: { hudContext: false, hudFiveHour: false, hudWeekly: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    const calls = usage(on, { context: CONTEXT, rateLimits: LIMITS })
    core(on)
    const hudBlits: any[] = []
    on('ui.blit', ($: any, e: any) => { if (e.key === 'hud') hudBlits.push(e); return { value: {} } })
    const task = (tool_name: string, tool_input: any, tool_response: any) =>
      $.classic.PostToolUse({ session_id: 's-1', tool_name, tool_use_id: 'toolu_x', tool_input, tool_response })
    const desk = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await measure($)
    await clock.advance(300)
    expect(await desk.findAll({ type: 'Svg' })).toHaveLength(1)   // nothing to draw yet: the crab as with hud 'off'
    await task('TaskCreate', { subject: 'One', description: 'x' }, { task: { id: '1', subject: 'One' } })
    await clock.advance(200)
    expect(await desk.findAll({ type: 'Svg' })).toHaveLength(2)
    expect((await hudSvgOf(desk))?.props.alt).toBe('Tasks 0 of 1.')
    expect(await sizedAboveEngine(desk)).toEqual([])
    await task('TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } })
    await clock.advance(200)
    expect((await hudSvgOf(desk))?.props.alt).toBe('Tasks all 1 done.')
    await clock.advance(5200)   // the gold row goes, and with it the HUD
    expect(await desk.findAll({ type: 'Svg' })).toHaveLength(1)
    await desk.unmount()
    // a terminal: no Raster without a list; a new list draws the band again (a blit cannot add the Raster), its end takes it away
    const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    expect(await term.find({ key: 'hud' })).toBeUndefined()
    await task('TaskCreate', { subject: 'Two', description: 'y' }, { task: { id: '2', subject: 'Two' } })
    await clock.advance(200)
    const hud = await term.find({ key: 'hud' })
    expect(hud?.type).toBe('Raster')
    expect(glyphs(hud!.props.cells as string, hud!.props.columns as number)[0]).toMatch(/^TODO +0\/1 /)
    expect(hudBlits).toEqual([])
    await task('TaskUpdate', { taskId: '2', status: 'completed' }, { success: true, taskId: '2', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } })
    await clock.advance(5400)
    expect(await term.find({ key: 'hud' })).toBeUndefined()
    await term.unmount()
    expect(calls).toEqual([])
    await clock.settle()
  })

  test('the context off: a tool call reads no usage mid-turn (the limits come with session.measure); a start still does', { options: { hudContext: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    const calls = usage(on, { context: CONTEXT, rateLimits: LIMITS })
    otherMod(on)
    const ui = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(300)
    const seeded = calls.length
    expect(seeded).toBeGreaterThan(0)   // the seed: the limits show at load
    for (let i = 0; i < 5; i++) await $.classic.PostToolUse({ session_id: 's-1', tool_name: 'Bash', tool_use_id: `t${i}`, tool_input: { command: 'ls' }, tool_response: {} })
    await $.classic.PostCompact({ session_id: 's-1', trigger: 'auto' })
    await clock.advance(300)
    expect(calls.length).toBe(seeded)
    await $.classic.SessionStart({ session_id: 's-1', source: 'clear' })
    await clock.advance(300)
    expect(calls.length).toBeGreaterThan(seeded)
    expect(calls.some((c) => c?.breakdown)).toBe(false)
    await measure($)
    await clock.advance(200)
    expect((await hudSvgOf(ui))?.props.alt).toBe('5-hour limit 30%, resets in 2h10. Weekly limit 72%, resets in 3d.')
    await ui.unmount()
  })

  test('a finished list goes DONE_MS after it was done, however often the model looks at it again', { options: { hudContext: false, hudFiveHour: false, hudWeekly: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    core(on)
    on('ui.blit', ($: any, e: any) => ({ value: {} }))
    const task = (tool_name: string, tool_input: any, tool_response: any) =>
      $.classic.PostToolUse({ session_id: 's-1', tool_name, tool_use_id: 'toolu_x', tool_input, tool_response })
    const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    await task('TaskCreate', { subject: 'One', description: 'x' }, { task: { id: '1', subject: 'One' } })
    await task('TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } })
    await clock.advance(3000)
    await task('TaskList', {}, { tasks: [{ id: '1', subject: 'One', status: 'completed' }] })   // the model checks the finished list
    await clock.advance(1000)
    expect((await term.find({ key: 'hud' }))?.type).toBe('Raster')   // 4 s: still gold
    await clock.advance(1400)
    expect(await term.find({ key: 'hud' })).toBeUndefined()   // 5.4 s after it was done, not 5 s after the look
    await term.unmount()
    await clock.settle()
  })

  test('all four off is hud "off": the crab alone, no usage read', { options: { hudContext: false, hudFiveHour: false, hudWeekly: false, hudTasks: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    const calls = usage(on, { context: CONTEXT, rateLimits: LIMITS })
    otherMod(on)
    const desk = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await measure($)
    await todo($, [{ content: 'a', status: 'pending' }])
    await clock.advance(300)
    expect(await desk.findAll({ type: 'Svg' })).toHaveLength(1)
    expect((await desk.find({ type: 'Svg' }))?.props.width).toBe(320)   // the whole walk: no HUD beside him
    expect((await desk.findAll({ type: 'Box' })).some((b: any) => b.props.flexDirection === 'row')).toBe(false)
    await desk.unmount()
    const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    expect(await term.find({ key: 'hud' })).toBeUndefined()
    expect((await term.find({ key: 'crab' }))?.props.columns).toBe(40)
    await term.unmount()
    expect(calls).toEqual([])
  })
})

describe('the walk beside the HUD', () => {
  test('halved where a HUD fits beside him: 160 units in the Code tab, 20 columns in a terminal; a band too narrow for one keeps the whole walk', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    usage(on, { context: CONTEXT, rateLimits: LIMITS })
    core(on)
    const desk = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await measure($)
    await clock.advance(300)
    const svgs = await desk.findAll({ type: 'Svg' })
    expect(svgs.map((v: any) => v.props.width)).toEqual([160, 467])   // the room after him at 80 columns
    expect(await sizedAboveEngine(desk)).toEqual([])
    await desk.unmount()
    // [the band's columns, the crab's, the HUD's]: 20 + the gap and the margin + HUD_MIN_COLS 16 + the corner's 4 = 42 at the least
    for (const [cols, crab, hud] of [[80, 20, 54], [42, 20, 16], [41, 39, undefined], [30, 28, undefined]] as const) {
      const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: cols } })
      const img = await term.find({ key: 'crab' })
      expect([cols, img?.props.columns]).toEqual([cols, crab])
      expect([cols, (await term.find({ key: 'hud' }))?.props.columns]).toEqual([cols, hud])
      // the picture 92 px tall at any width, the frame on its floor: a 20-column box is half the 40-column one's 7 : 1, and so is the
      // picture, so Ghostty fits it by height (a fixed 7 : 1 left this 5 : 1 frame 14 px off the floor of a 3.5 : 1 box)
      const { w, h, at } = readPng(png(img)!)
      expect([cols, w, h]).toEqual([cols, crab * 16, 92])
      let low = 0, above = 0
      for (let x = 0; x < w; x++) { if (at(x, h - 5)[3]) low++; for (let y = 0; y < h - 64; y++) if (at(x, y)[3]) above++ }
      expect([cols, low > 0, above]).toEqual([cols, true, 0])
      await term.unmount()
    }
    await clock.settle()
  })

  test('the task list alone keeps the halved walk with no list drawn: the width follows the setting, so he does not jump as the list comes and goes', { options: { hudContext: false, hudFiveHour: false, hudWeekly: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/Users/me' })
    bridge(on)
    on('classic.*', () => ({}))
    core(on)
    const task = (tool_name: string, tool_input: any, tool_response: any) =>
      $.classic.PostToolUse({ session_id: 's-1', tool_name, tool_use_id: 'toolu_x', tool_input, tool_response })
    const desk = await $.ui.mount({ plugin: 'notch-crab', surface: 'desktop', ...DESK })
    await clock.advance(300)
    const widths = async () => (await desk.findAll({ type: 'Svg' })).map((v: any) => v.props.width)
    expect(await widths()).toEqual([160])   // no list yet: no HUD, and the walk already halved
    await task('TaskCreate', { subject: 'One', description: 'x' }, { task: { id: '1', subject: 'One' } })
    await clock.advance(200)
    expect(await widths()).toEqual([160, 467])
    await task('TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } })
    await clock.advance(5400)
    expect(await widths()).toEqual([160])
    await desk.unmount()
    const term = await $.ui.mount({ plugin: 'notch-crab', surface: 'terminal', ...BAND })
    expect(await term.find({ key: 'hud' })).toBeUndefined()
    expect((await term.find({ key: 'crab' }))?.props.columns).toBe(20)
    await term.unmount()
    await clock.settle()
  })
})
