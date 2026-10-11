import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextUsage,
} from 'claude-code'

import type { Body, Breakdown, Entry, EntryKind, Sample, Tab } from '../types'

const NAME = 'whats-in-context'
const PANE = 'whats-in-context'
const TITLE = "What's in context"
// How much one drawing shows; nothing recorded is ever dropped.
const ROWS = 200
const PART = 8000
// How many entries stay open at once: one more closes the one opened first.
const OPEN = 8
const BLOCKS = '▁▂▃▄▅▆▇█'

const entries = atom({ plugin: 'whats-in-context', key: 'entries' } as const, [])
const samples = atom({ plugin: 'whats-in-context', key: 'samples' } as const, [])
const breakdown = atom({ plugin: 'whats-in-context', key: 'breakdown' } as const, null)
const tab = atom({ plugin: 'whats-in-context', key: 'tab' } as const, 'timeline')
const startedAt = atom({ plugin: 'whats-in-context', key: 'startedAt' } as const, 0)
const isSeeded = atom({ plugin: 'whats-in-context', key: 'isSeeded' } as const, false)
const opened = atom({ plugin: 'whats-in-context', key: 'opened' } as const, [])
const listEnd = atom({ plugin: 'whats-in-context', key: 'listEnd' } as const, -1)
const bodies = { plugin: 'whats-in-context', key: 'bodies' } as const

const TABS: { id: Tab; title: string }[] = [
  { id: 'timeline', title: 'Timeline' },
  { id: 'files', title: 'Files' },
  { id: 'prompts', title: 'Prompts' },
  { id: 'now', title: 'Now' },
]

const KINDS: Record<EntryKind, { glyph: string; color: string; name: string }> = {
  prompt: { glyph: '›', color: 'claude', name: 'Prompt' },
  file: { glyph: '■', color: 'suggestion', name: 'File read' },
  mention: { glyph: '@', color: 'suggestion', name: 'File mentioned' },
  tool: { glyph: '·', color: 'inactive', name: 'Tool call' },
  compact: { glyph: '▼', color: 'warning', name: 'Compaction' },
  memory: { glyph: '■', color: 'inactive', name: 'Instruction file' },
}

const NONE: Body = { text: '', startLine: 0, input: '', note: '' }

// Pure helpers

const estimate = (text: string) => Math.ceil(text.length / 4)

// Text a tree may hold: no escape sequences, no control character but tab and newline.
const clean = (text: string) =>
  text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

const oneLine = (text: string) => clean(text).replace(/\s+/g, ' ').trim()

const cut = (text: string, most: number) =>
  text.length > most ? `${text.slice(0, Math.max(1, most - 1))}…` : text

const count = (tokens: number) => {
  const size = Math.abs(tokens)
  if (size >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (size >= 1000) return `${(tokens / 1000).toFixed(1)}k`

  return String(tokens)
}

const size = (tokens: number) =>
  tokens === 0 ? '' : tokens < 0 ? `−${count(-tokens)}` : `+${count(tokens)}`

const segments = (path: string) => path.split(/[\\/]/).filter(Boolean)

const baseName = (path: string) => segments(path).at(-1) ?? path

const dirName = (path: string) => segments(path).slice(-3, -1).join('/')

const shortPath = (path: string) => segments(path).slice(-2).join('/')

const hash = (text: string) => {
  let sum = 5381
  for (let index = 0; index < text.length; index++) {
    sum = ((sum * 33) ^ text.charCodeAt(index)) >>> 0
  }

  return sum.toString(36)
}

const memoryId = (path: string) => `memory-${hash(path)}`

const elapsed = (at: number, base: number) => {
  if (at === 0) return 'earlier'
  const seconds = Math.max(0, Math.floor((at - base) / 1000))
  if (seconds < 60) return `+${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `+${minutes}m`

  return `+${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

const sparkline = (values: number[], width: number) => {
  const peak = values.reduce((most, value) => Math.max(most, value), 1)
  const cells = Math.min(width, values.length)
  let line = ''
  for (let cell = 0; cell < cells; cell++) {
    const value = values[Math.floor(((cell + 1) * values.length) / cells) - 1] ?? 0
    line += BLOCKS[Math.min(7, Math.floor((value / peak) * 8))] ?? ''
  }

  return line
}

const bar = (value: number, most: number, width: number) =>
  most <= 0 || value <= 0 ? '' : '█'.repeat(Math.max(1, Math.round((value / most) * width)))

const fillOf = (fills: Sample[], parts: Breakdown | null) => {
  const last = fills.at(-1)
  const used = last?.tokens ?? parts?.total
  const window = last?.window ?? parts?.max
  const percent =
    used !== undefined && window !== undefined && window > 0
      ? Math.round((used / window) * 100)
      : undefined

  return { used, window, percent }
}

// A long text is drawn a part at a time, each part ending on a line where it can.
const partsOf = (text: string) => {
  const cuts = [0]
  let at = 0
  while (text.length - at > PART) {
    const edge = text.lastIndexOf('\n', at + PART)
    at = edge > at ? edge + 1 : at + PART
    cuts.push(at)
  }

  return cuts
}

const newlines = (text: string, until: number) => {
  let lines = 0
  for (let at = text.indexOf('\n'); at !== -1 && at < until; at = text.indexOf('\n', at + 1)) {
    lines += 1
  }

  return lines
}

// An opened entry's content as one text, and the part of it that is drawn.
const viewOf = (entry: Entry, held: Body | undefined, page: number) => {
  const isFile = entry.kind === 'file' || entry.kind === 'mention' || entry.kind === 'memory'
  const whole =
    held === undefined
      ? ''
      : isFile || held.input === ''
        ? held.text
        : `── Input ──\n${held.input}\n\n── Result ──\n${held.text}`
  const cuts = partsOf(whole)

  return { entry, held, isFile, whole, cuts, at: Math.min(Math.max(0, page), cuts.length - 1) }
}

type View = ReturnType<typeof viewOf>

// A tool call in a few words: the argument a person would name it by.

const HINTS = ['command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt', 'name']

const word = (value: unknown) => (typeof value === 'string' ? oneLine(value) : '')

const summarize = (tool: string, args: Record<string, unknown>) => {
  const path = word(args.file_path) || word(args.notebook_path) || word(args.path)
  const where = path === '' ? '' : ` in ${shortPath(path)}`
  if (tool === 'Grep') {
    const glob = word(args.glob)

    return `"${word(args.pattern)}"${where}${glob === '' ? '' : ` (${glob})`}`
  }
  if (tool === 'Glob') return `${word(args.pattern)}${where}`
  if (path !== '') return shortPath(path)
  for (const key of HINTS) {
    const value = word(args[key])
    if (value !== '') return value
  }

  return ''
}

const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

const inputOf = (args: Record<string, unknown>) => {
  const lines: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (ENVELOPE.has(key) || value === undefined) continue
    const shown = clean(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
    lines.push(shown.includes('\n') ? `${key}:\n${shown}` : `${key}: ${shown}`)
  }

  return lines.join('\n')
}

// A text file a Read returned, from the tool's own record: its content without
// the line numbers the model reads it with.
const fileOf = (result: unknown) => {
  if (typeof result !== 'object' || result === null) return undefined
  const { type, file } = result as { type?: unknown; file?: unknown }
  if (type !== 'text' || typeof file !== 'object' || file === null) return undefined
  const { content, startLine } = file as { content?: unknown; startLine?: unknown }
  if (typeof content !== 'string') return undefined

  return { content, startLine: typeof startLine === 'number' ? startLine : 1 }
}

const bodyOf = (
  tool: string,
  args: Record<string, unknown>,
  text: string,
  result: unknown,
): Body => {
  const file = tool === 'Read' ? fileOf(result) : undefined

  return {
    text: clean(file?.content ?? text),
    startLine: file?.startLine ?? 0,
    input: inputOf(args),
    note: '',
  }
}

const fromTool = (
  id: string,
  at: number,
  tool: string,
  args: Record<string, unknown>,
  body: Body,
): Entry => {
  const path = args.file_path
  const tokens = estimate(body.text) + estimate(body.input)
  if (tool === 'Read' && typeof path === 'string') {
    const from = typeof args.offset === 'number' ? `from line ${args.offset}` : ''

    return { id, at, kind: 'file', label: path, detail: from, tokens }
  }

  return { id, at, kind: 'tool', label: tool, detail: cut(summarize(tool, args), 300), tokens }
}

const toolName = (tool: string) => {
  const [, server, ...rest] = tool.split('__')

  return tool.startsWith('mcp__') && server !== undefined && rest.length > 0
    ? `${rest.join('__')} (${cut(server, 14)})`
    : tool
}

// A row's title cut to the room it has: the part that names the entry first,
// then as much of the rest as fits. The whole of it shows once the row is opened.
const fit = (name: string, rest: string, room: number) => {
  const head = cut(oneLine(name), room)
  const left = room - head.length - 1
  const tail = oneLine(rest)

  return { head, tail: tail === '' || left < 4 ? '' : ` ${cut(tail, left)}` }
}

const titleOf = (entry: Entry, room: number) => {
  if (entry.kind === 'file' || entry.kind === 'mention' || entry.kind === 'memory') {
    const rest = [dirName(entry.label), entry.detail].filter(part => part !== '').join(' · ')

    return fit(baseName(entry.label), rest, room)
  }
  if (entry.kind === 'tool') return fit(toolName(entry.label), entry.detail, room)

  return fit(entry.label, entry.detail, room)
}

const headingOf = (entry: Entry) => {
  if (entry.kind === 'prompt') return ''
  if (entry.kind === 'compact') return oneLine(`${entry.label} ${entry.detail}`)
  if (entry.kind === 'tool') return oneLine(entry.label)

  return oneLine(entry.detail === '' ? entry.label : `${entry.label} (${entry.detail})`)
}

// State writes. A failed write never costs the event it observes.

const add = async ($: EngineInterface, make: (at: number) => Entry, body?: Body) => {
  try {
    const entry = make(await $.clock.now())
    if (body !== undefined) await $.state.set({ ...bodies, id: entry.id }, body)
    await update($, entries, list => [...list, entry])
  } catch {
    // The entry is left out.
  }
}

const keep = async ($: EngineInterface, context: SessionContextUsage) => {
  const parts = context.breakdown
  if (parts === undefined) return
  const next: Breakdown = {
    rows: parts.categories.map(row => ({ name: row.name, tokens: row.tokens, kind: row.kind })),
    total: parts.totalTokens,
    max: parts.rawMaxTokens,
    percent: parts.percentage,
    model: parts.model,
    memoryFiles: parts.memoryFiles.map(file => ({
      path: file.path,
      type: file.type,
      tokens: file.tokens,
    })),
  }
  await update($, breakdown, () => next)
}

const refresh = async ($: EngineInterface) => {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    await update($, startedAt, () => usage.startedAt)
    await keep($, usage.context)
  } catch {
    // The last breakdown stands.
  }
}

// What the transcript already holds when the mod loads into a running session.
// A tool call's content is read back from the transcript when its row is opened.
const seed = async ($: EngineInterface) => {
  try {
    const found: Entry[] = []
    const rows = await $.session.messages()
    for (const [index, row] of rows.entries()) {
      if (row.role === 'user') {
        if ((row.toolResults?.length ?? 0) > 0 || row.text.trim() === '') continue
        const id = `seed-${index}`
        const text = clean(row.text)
        await $.state.set({ ...bodies, id }, { ...NONE, text })
        found.push({
          id,
          at: 0,
          kind: 'prompt',
          label: cut(oneLine(text), 200),
          detail: '',
          tokens: estimate(text),
        })
        continue
      }
      for (const use of row.toolUses) {
        const body = bodyOf(use.tool, use.input, use.text ?? '', use.result)
        found.push(fromTool(use.tool_use_id, 0, use.tool, use.input, body))
      }
    }
    if (found.length > 0) await update($, entries, list => [...found, ...list])
  } catch {
    // Nothing to read back.
  }
}

// An entry's content when none was kept as it was recorded.
const recover = async ($: EngineInterface, entry: Entry): Promise<Body> => {
  if (entry.kind === 'memory' || entry.kind === 'mention') {
    const text = clean(await $.fs.read(entry.label))

    return { ...NONE, text, startLine: 1, note: 'The file as it is on disk now.' }
  }
  if (entry.kind === 'tool' || entry.kind === 'file') {
    for (const row of await $.session.messages()) {
      for (const use of row.toolUses) {
        if (use.tool_use_id !== entry.id) continue

        return bodyOf(use.tool, use.input, use.text ?? '', use.result)
      }
    }

    return { ...NONE, note: 'This call is no longer in the transcript, so its content is gone.' }
  }

  return { ...NONE, text: clean(entry.label), note: 'Only this much of it was kept.' }
}

// Presses

const shut = ($: EngineInterface, id: string) =>
  update($, opened, list => list.filter(one => one.id !== id))

const turnTo = ($: EngineInterface, id: string, page: number) =>
  update($, opened, list => list.map(one => (one.id === id ? { ...one, page } : one)))

const open = async ($: EngineInterface, entry: Entry) => {
  try {
    if ((await read($, opened)).some(one => one.id === entry.id)) {
      await shut($, entry.id)

      return
    }
    await update($, opened, list =>
      [...list.filter(one => one.id !== entry.id), { id: entry.id, page: 0 }].slice(-OPEN),
    )
    const ref = { ...bodies, id: entry.id }
    if ((await $.state.get(ref)).value !== undefined) return
    let found: Body
    try {
      found = await recover($, entry)
    } catch {
      found = { ...NONE, note: 'Its content could not be loaded.' }
    }
    await $.state.set(ref, found)
  } catch {
    // The row stays closed.
  }
}

const show = async ($: EngineInterface, id: Tab) => {
  try {
    await update($, opened, () => [])
    await update($, tab, () => id)
  } catch {
    // The tab stays.
  }
}

// The press that asks for it waits on this: an open made once the press has settled
// is an unasked one, which a terminal under 144 columns leaves undrawn.
const toggle = async ($: EngineInterface) => {
  try {
    const mine = (await $.ui.panes()).find(pane => pane.id === PANE)
    if (mine === undefined) {
      await $.ui.open({ id: PANE, title: TITLE })
    } else if (mine.isPlaced && mine.isShown) {
      await $.ui.close({ id: PANE })
    } else {
      await $.ui.open({ id: PANE, title: TITLE, focus: true })
    }
  } catch {
    // The pane stays as it is.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Show what Claude has read into context this session',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    if (!(await read($, isSeeded))) {
      await update($, isSeeded, () => true)
      await seed($)
    }
    await refresh($)

    return next(e)
  })

  on('command.run', { command: NAME }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return {
      text: opened.isPlaced
        ? `${TITLE}: pane opened.`
        : `${TITLE}: the pane is not drawn here (${opened.reason}).`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop !== undefined) return entered
    const text = clean(entered.text)
    const beside = (entered.context ?? []).map(
      block => `── context added beside the prompt ──\n${clean(block)}`,
    )
    const whole = [text, ...beside].join('\n\n')
    await add(
      $,
      at => ({
        id: `prompt-${at}`,
        at,
        kind: 'prompt',
        label: cut(oneLine(text), 200),
        detail: e.origin.kind === 'composer' ? '' : e.origin.kind,
        tokens: estimate(whole),
      }),
      { ...NONE, text: whole },
    )

    return entered
  })

  on('prompt.mention', async ($, e, next) => {
    const attached = await next(e)
    if (e.agentId !== undefined || attached.deny !== undefined || attached.type === null) {
      return attached
    }
    let body: Body = {
      ...NONE,
      note: `Attached as ${attached.type.replace(/_/g, ' ')}: no new text entered the context.`,
    }
    if (attached.type === 'file') {
      try {
        const lines = clean(await $.fs.read(e.path)).split('\n')
        const from = (e.offset ?? 1) - 1
        const text = lines.slice(from, e.limit === undefined ? undefined : from + e.limit)
        body = { ...NONE, text: text.join('\n'), startLine: from + 1 }
      } catch {
        body = { ...NONE, note: 'Its content could not be read.' }
      }
    }
    await add(
      $,
      at => ({
        id: `mention-${at}-${hash(e.path)}`,
        at,
        kind: 'mention',
        label: e.path,
        detail: `@${oneLine(e.mention)}`,
        tokens: estimate(body.text),
      }),
      body,
    )

    return attached
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // A subagent's calls fill its own window, not this one.
    if (e.agentId !== undefined || ran.deny !== undefined) return ran
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    const body = bodyOf(tool, args, ran.text ?? '', ran.result)
    await add($, at => fromTool(e.tool_use_id, at, tool, args, body), body)

    return ran
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.trigger === 'precompute' || e.agentId !== undefined || done.skip !== undefined) {
      return done
    }
    const before = done.tokensBefore
    const after = done.tokensAfter
    const isCounted = before !== undefined && after !== undefined
    const summary = done.messages.find(message => message.text.trim() !== '')?.text ?? ''
    await add(
      $,
      at => ({
        id: `compact-${at}`,
        at,
        kind: 'compact',
        label: `Compacted (${e.trigger})`,
        detail: isCounted ? `${count(before)} → ${count(after)} tokens` : '',
        tokens: isCounted ? after - before : 0,
      }),
      {
        ...NONE,
        text: clean(summary),
        note: 'The summary the earlier conversation was replaced with.',
      },
    )

    return done
  })

  on('session.measure', async ($, e, next) => {
    const tokens = e.context.tokens
    if (e.changed.includes('context') && tokens !== undefined) {
      try {
        const sample = { at: await $.clock.now(), tokens, window: e.context.window }
        await update($, samples, list => [...list, sample])
      } catch {
        // The sample is left out.
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await refresh($)

    return done
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await update($, opened, () => [])
        await update($, listEnd, () => -1)
        await update($, entries, () => [])
        await update($, samples, () => [])
        await update($, breakdown, () => null)
      } catch {
        // The old conversation's rows stay listed.
      }
    }

    return next(e)
  })

  // The button that opens and closes the pane, with the window's fill beside it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { used, percent } = fillOf(await read($, samples), await read($, breakdown))
    const fill =
      used === undefined ? '' : ` ${count(used)}${percent === undefined ? '' : ` · ${percent}%`}`

    return (
      <Box flexDirection="row">
        <Button key="toggle" plain onPress={() => toggle($)}>
          ◧ Context
          <Text dimColor>{fill}</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, entries)
    const fills = await read($, samples)
    const parts = await read($, breakdown)
    const shown = await read($, tab)
    const began = await read($, startedAt)
    const chosen = await read($, opened)
    const until = await read($, listEnd)

    const columns = Math.max(24, e.props.bodyColumns)
    const base = began || (list.find(entry => entry.at > 0)?.at ?? 0)
    const { used, window, percent } = fillOf(fills, parts)
    const peak = fills.reduce((most, sample) => Math.max(most, sample.tokens), 0)
    const largest = list.reduce((most, entry) => Math.max(most, Math.abs(entry.tokens)), 1)
    const hasBar = columns >= 64
    const room = Math.max(8, columns - 19 - (hasBar ? 7 : 0))

    const memory: Entry[] = (parts?.memoryFiles ?? []).map(file => ({
      id: memoryId(file.path),
      at: 0,
      kind: 'memory',
      label: file.path,
      detail: file.type,
      tokens: file.tokens,
    }))
    const prompts = list.filter(entry => entry.kind === 'prompt')
    const files = new Map<string, { reads: number; tokens: number; latest: Entry }>()
    for (const entry of list) {
      if (entry.kind !== 'file' && entry.kind !== 'mention') continue
      const seen = files.get(entry.label)
      files.set(entry.label, {
        reads: (seen?.reads ?? 0) + 1,
        tokens: (seen?.tokens ?? 0) + entry.tokens,
        latest: entry,
      })
    }
    const readFiles = [...files.values()].sort((a, b) => b.tokens - a.tokens)

    const end = until < 0 || until > list.length ? list.length : until
    const start = Math.max(0, end - ROWS)

    // The entries opened in place, each drawn under its row.
    const drawn =
      shown === 'timeline'
        ? list.slice(start, end)
        : shown === 'files'
          ? [...memory, ...readFiles.map(seen => seen.latest)]
          : shown === 'prompts'
            ? prompts
            : []
    const views = new Map<string, View>()
    for (const one of chosen) {
      const entry = drawn.find(each => each.id === one.id)
      if (entry === undefined) continue
      const held = (await $.state.get({ ...bodies, id: entry.id })).value
      views.set(entry.id, viewOf(entry, held, one.page))
    }
    // The keys that turn the parts go to the long entry opened last.
    const keyed = [...views.values()].reverse().find(view => view.cuts.length > 1)?.entry.id

    const detail = ({ entry, held, isFile, whole, cuts, at }: View) => {
      const meta = [
        KINDS[entry.kind].name,
        elapsed(entry.at, base),
        entry.tokens === 0 ? '' : `~${count(Math.abs(entry.tokens))} tokens`,
      ]
        .filter(part => part !== '')
        .join(' · ')
      const heading = headingOf(entry)
      const from = cuts[at] ?? 0
      const source = whole.slice(from, cuts[at + 1] ?? whole.length)
      const code = {
        source,
        ...(isFile ? { path: entry.label } : {}),
        ...(held !== undefined && held.startLine > 0
          ? { startLine: held.startLine + newlines(whole, from) }
          : {}),
      }
      const turn = (where: string, keys: { earlier?: string; later?: string }) => (
        <Box flexDirection="row" gap={2}>
          {at > 0 && (
            <Button
              key={`${where}-earlier-${entry.id}`}
              plain
              {...(keys.earlier === undefined ? {} : { hotkey: keys.earlier })}
              onPress={() => {
                void turnTo($, entry.id, at - 1)
              }}
            >
              ‹ Earlier
            </Button>
          )}
          <Text dimColor>
            part {at + 1} of {cuts.length}
          </Text>
          {at < cuts.length - 1 && (
            <Button
              key={`${where}-later-${entry.id}`}
              plain
              {...(keys.later === undefined ? {} : { hotkey: keys.later })}
              onPress={() => {
                void turnTo($, entry.id, at + 1)
              }}
            >
              Later ›
            </Button>
          )}
        </Box>
      )

      return (
        <Box flexDirection="column" marginLeft={2} marginBottom={1}>
          <Text dimColor wrap="wrap">
            {meta}
          </Text>
          {heading !== '' && <Text wrap="wrap">{heading}</Text>}
          {held === undefined && <Text dimColor>Loading its content…</Text>}
          {held !== undefined && held.note !== '' && (
            <Text dimColor italic wrap="wrap">
              {held.note}
            </Text>
          )}
          {cuts.length > 1 &&
            turn('top', entry.id === keyed ? { earlier: 'k', later: 'j' } : {})}
          {held !== undefined && source === '' && held.note === '' && (
            <Text dimColor>It put no text into the context.</Text>
          )}
          {source !== '' && <Code {...code} />}
          {cuts.length > 1 && turn('end', {})}
          <Button
            key={`close-${entry.id}`}
            plain
            onPress={() => {
              void shut($, entry.id)
            }}
          >
            ▴ Close
          </Button>
        </Box>
      )
    }

    const row = (entry: Entry, when: string | undefined, width: number, right: string) => {
      const title = titleOf(entry, width)
      const view = views.get(entry.id)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {when !== undefined && (
              <Box width={8} flexShrink={0}>
                <Text dimColor>{when}</Text>
              </Box>
            )}
            <Box width={2} flexShrink={0}>
              <Text color={KINDS[entry.kind].color}>
                {view === undefined ? KINDS[entry.kind].glyph : '▾'}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Button
                key={`entry-${entry.id}`}
                plain
                onPress={() => {
                  void open($, entry)
                }}
              >
                {title.head}
                <Text dimColor>{title.tail}</Text>
              </Button>
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              <Text color={entry.tokens < 0 ? 'warning' : 'inactive'}>{right}</Text>
            </Box>
          </Box>
          {view !== undefined && detail(view)}
        </Box>
      )
    }

    const move = (where: string, keys: { older?: string; newer?: string }) => (
      <Box flexDirection="row" gap={2}>
        {start > 0 && (
          <Button
            key={`${where}-older`}
            plain
            {...(keys.older === undefined ? {} : { hotkey: keys.older })}
            onPress={() => {
              void update($, listEnd, () => Math.max(ROWS, end - ROWS))
            }}
          >
            ‹ Older
          </Button>
        )}
        <Text dimColor>
          {start + 1}–{end} of {list.length}
        </Text>
        {end < list.length && (
          <Button
            key={`${where}-newer`}
            plain
            {...(keys.newer === undefined ? {} : { hotkey: keys.newer })}
            onPress={() => {
              void update($, listEnd, () => (end + ROWS >= list.length ? -1 : end + ROWS))
            }}
          >
            Newer ›
          </Button>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>Context </Text>
          {used === undefined ? (
            <Text dimColor>no reading yet</Text>
          ) : (
            <Text color={percent !== undefined && percent >= 80 ? 'warning' : 'success'}>
              {count(used)}
              {window === undefined ? '' : ` / ${count(window)}`}
              {percent === undefined ? '' : `  ${percent}%`}
            </Text>
          )}
        </Box>
        {fills.length > 1 && (
          <Box flexDirection="column">
            <Text color="claude" wrap="truncate-end">
              {sparkline(
                fills.map(sample => sample.tokens),
                columns,
              )}
            </Text>
            <Text dimColor wrap="truncate-end">
              fill per response · peak {count(peak)} · {fills.length} readings
            </Text>
          </Box>
        )}
        <Box flexDirection="row" gap={2} marginTop={1}>
          {TABS.map((one, index) => (
            <Button
              key={`tab-${one.id}`}
              plain
              hotkey={String(index + 1)}
              dimColor={one.id !== shown}
              onPress={() => {
                void show($, one.id)
              }}
            >
              {one.title}
            </Button>
          ))}
        </Box>
        <Box height={1}>
          {chosen.length > 1 && (
            <Button
              key="close-all"
              plain
              onPress={() => {
                void update($, opened, () => [])
              }}
            >
              ▴ Close all
            </Button>
          )}
        </Box>

        {shown === 'timeline' && (
          <Box flexDirection="column">
            {list.length === 0 && <Text dimColor>Nothing has entered the context yet.</Text>}
            {list.length > ROWS && move('top', { older: 'u', newer: 'd' })}
            {list
              .slice(start, end)
              .map(entry =>
                row(
                  entry,
                  elapsed(entry.at, base),
                  room,
                  `${hasBar ? `${bar(Math.abs(entry.tokens), largest, 6)} ` : ''}${size(entry.tokens)}`,
                ),
              )}
            {list.length > ROWS && move('end', {})}
            {list.length > 0 && (
              <Text dimColor wrap="wrap">
                Click a row to read what it put into the context; up to {OPEN} stay open at once.
                Sizes are estimates (characters / 4).
              </Text>
            )}
          </Box>
        )}

        {shown === 'files' && (
          <Box flexDirection="column">
            <Text bold>Instruction and memory files</Text>
            {memory.length === 0 && <Text dimColor>None loaded.</Text>}
            {memory.map(entry => row(entry, undefined, room + 8, count(entry.tokens)))}
            <Box marginTop={1}>
              <Text bold>Read during the session</Text>
            </Box>
            {readFiles.length === 0 && <Text dimColor>No file read yet.</Text>}
            {readFiles.map(seen =>
              row(
                { ...seen.latest, detail: '' },
                undefined,
                room + 8,
                `${seen.reads}×${seen.tokens === 0 ? '' : ` ~${count(seen.tokens)}`}`,
              ),
            )}
          </Box>
        )}

        {shown === 'prompts' && (
          <Box flexDirection="column">
            {prompts.length === 0 && <Text dimColor>No prompt yet.</Text>}
            {prompts.map((entry, index) => (
              <Box flexDirection="column" marginBottom={1}>
                <Text dimColor>
                  #{index + 1} · {elapsed(entry.at, base)} · ~{count(entry.tokens)} tokens
                  {entry.detail === '' ? '' : ` · ${oneLine(entry.detail)}`}
                </Text>
                {row({ ...entry, detail: '' }, undefined, room + 8, '')}
              </Box>
            ))}
          </Box>
        )}

        {shown === 'now' && (
          <Box flexDirection="column">
            {parts === null && <Text dimColor>The breakdown appears once a turn completes.</Text>}
            {parts !== null && (
              <Text dimColor wrap="truncate-end">
                {parts.model} · {count(parts.total)} / {count(parts.max)} · {parts.percent}%
              </Text>
            )}
            {(parts?.rows ?? []).map(one => (
              <Box flexDirection="row">
                <Box width={22} flexShrink={0}>
                  <Text wrap="truncate-end" dimColor={one.kind !== 'used'}>
                    {one.name}
                  </Text>
                </Box>
                <Box width={8} flexShrink={0}>
                  <Text dimColor>{count(one.tokens)}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={one.kind === 'used' ? 'claude' : 'inactive'} wrap="truncate-end">
                    {bar(one.tokens, parts?.max ?? 0, Math.max(4, columns - 32))}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
