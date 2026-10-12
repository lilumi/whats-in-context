import { expect, mock, test } from 'claude-code/testing'

const pane = (bodyColumns: number) =>
  ({
    plugin: 'whats-in-context',
    component: 'Pane',
    requestId: 'whats-in-context',
    props: {
      title: "What's in context",
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

// The surfaces that draw a field.
const FIELDS = ['terminal', 'desktop', 'vscode'] as const

// `find` takes a string by inclusion: this is the whole of an element's text.
const whole = (text: string) => new RegExp(`^${text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`)

const fileRead = (path: string, content: string) => ({
  result: {
    type: 'text',
    file: { filePath: path, content, numLines: 1, startLine: 1, totalLines: 1 },
  } as never,
  text: `1\t${content}`,
})

// What `$.session.usage` answers: a breakdown with these instruction files loaded.
const usage = (memoryFiles: { path: string; type: string; tokens: number }[]) => ({
  value: {
    startedAt: 500,
    rateLimits: [],
    context: {
      window: 200_000,
      breakdown: {
        categories: [],
        totalTokens: 900,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        autocompactSource: 'auto' as const,
        percentage: 1,
        gridRows: [],
        model: 'opus',
        memoryFiles: [...memoryFiles],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: true,
        apiUsage: null,
      },
    },
  },
})

// A session the mod loads into with a transcript already there.
const TRANSCRIPT = [
  { role: 'user' as const, text: 'Find the parser.', toolUses: [] },
  {
    role: 'assistant' as const,
    text: '',
    toolUses: [
      { tool_use_id: 'old1', tool: 'Grep', input: { pattern: 'parse\\(' }, text: 'src/parser.ts' },
      { tool_use_id: 'old2', tool: 'Bash', input: { command: 'ls' }, text: 'README.md' },
    ],
  },
]

test('a search finds one entry by its title and another by what it put in, in any letter case', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id === 'b' ? 'first line\n\tthe Needle is here\nlast line' : 'nothing',
  }))
  for (const id of ['a', 'b', 'c']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `echo ${id}` })
  }

  for (const surface of FIELDS) {
    const ui = await $.ui.mount({ ...pane(60), surface })
    expect(await ui.find({ type: 'Text', text: /match/ })).toBeUndefined()

    await ui.input({ key: 'search', text: 'NEEDLE' })
    expect(await ui.find({ key: 'entry-b' })).toBeDefined()
    expect(await ui.find({ key: 'entry-a' })).toBeUndefined()
    expect(await ui.find({ key: 'entry-c' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: whole('1 of 3 match') })).toBeDefined()
    expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('NEEDLE')

    await ui.input({ key: 'search', text: 'Echo C' })
    expect(await ui.find({ key: 'entry-c' })).toBeDefined()
    expect(await ui.find({ key: 'entry-b' })).toBeUndefined()

    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }
})

test('a row says where it holds what is sought: in its title, or on a line under it', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) =>
    e.tool === 'Read'
      ? fileRead('/repo/projects/deep/down/src/app.ts', 'export const answer = 42\n')
      : { result: undefined as never, text: 'first line\n\tthe Needle is here\nlast line' },
  )
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'echo one' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/repo/projects/deep/down/src/app.ts' })

  for (const surface of FIELDS) {
    const ui = await $.ui.mount({ ...pane(60), surface })

    // In what it put in: the line it is on, without its indent.
    await ui.input({ key: 'search', text: 'needle' })
    expect(await ui.find({ type: 'Text', text: whole('the Needle is here') })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: whole('Needle') }))?.props.inverse).toBe(true)

    // In its title as it is drawn: marked there, with no line under the row.
    await ui.input({ key: 'search', text: 'ECHO' })
    expect((await ui.find({ key: 'entry-b' }))?.text).toBe('Bash echo one')
    expect((await ui.find({ type: 'Text', text: whole('echo') }))?.props.inverse).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Needle/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: whole('Bash echo one') })).toBeUndefined()

    // In the part of its path the title leaves out.
    await ui.input({ key: 'search', text: 'projects' })
    expect((await ui.find({ key: 'entry-r' }))?.text).toBe('app.ts down/src')
    expect(
      await ui.find({ type: 'Text', text: whole('/repo/projects/deep/down/src/app.ts') }),
    ).toBeDefined()
    expect((await ui.find({ type: 'Text', text: whole('projects') }))?.props.inverse).toBe(true)

    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }
})

test('a search nothing matches says so, and an empty Enter or Clear brings every row back', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))
  for (const id of ['a', 'b']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `echo ${id}` })
  }

  for (const surface of FIELDS) {
    const ui = await $.ui.mount({ ...pane(60), surface })

    await ui.input({ key: 'search', text: 'zebra' })
    expect(await ui.find({ type: 'Text', text: whole('Nothing matches') })).toBeDefined()
    expect(await ui.find({ key: 'entry-a' })).toBeUndefined()

    await ui.press({ key: 'search-clear' })
    expect(await ui.find({ key: 'entry-a' })).toBeDefined()
    expect(await ui.find({ key: 'entry-b' })).toBeDefined()
    expect(await ui.find({ key: 'search-clear' })).toBeUndefined()
    expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('')

    await ui.input({ key: 'search', text: 'zebra' })
    expect(await ui.find({ key: 'entry-a' })).toBeUndefined()
    await ui.input({ key: 'search', text: '   ' })
    expect(await ui.find({ key: 'entry-a' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /match/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the text is sought as it is typed, never as a pattern', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id === 'a' ? 'cost: $5 (a.b) [x]' : 'cost: 5 aXb x',
  }))
  for (const id of ['a', 'b']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `echo ${id}` })
  }

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  for (const text of ['$5', '(a.b)', '[x]', 'a.b']) {
    await ui.input({ key: 'search', text })
    expect(await ui.find({ key: 'entry-a' })).toBeDefined()
    expect(await ui.find({ key: 'entry-b' })).toBeUndefined()
  }
  await ui.unmount()
})

test('an entry recorded while a search is set joins it when it holds the text', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id.startsWith('late-miss') ? 'nothing' : 'a needle',
  }))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'early', command: 'echo 1' })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'needle' })
  expect(await ui.find({ type: 'Text', text: whole('1 of 1 match') })).toBeDefined()

  await $.tool.call({ tool: 'Bash', tool_use_id: 'late-hit', command: 'echo 2' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'late-miss', command: 'echo 3' })
  await ui.redraw()
  expect(await ui.find({ key: 'entry-late-hit' })).toBeDefined()
  expect(await ui.find({ key: 'entry-late-miss' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: whole('2 of 3 match') })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: whole('a needle') })).toBeDefined()

  // Another search starts its own list of what joins it, and leaves the last one's.
  await ui.input({ key: 'search', text: 'nothing' })
  expect(await ui.find({ type: 'Text', text: whole('1 of 3 match') })).toBeDefined()
  await $.tool.call({ tool: 'Bash', tool_use_id: 'late-miss-2', command: 'echo 4' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'late-hit-2', command: 'echo 5' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: whole('2 of 5 match') })).toBeDefined()
  expect(await ui.find({ key: 'entry-late-miss-2' })).toBeDefined()
  expect(await ui.find({ key: 'entry-late-hit' })).toBeUndefined()
  expect(await ui.find({ key: 'entry-late-hit-2' })).toBeUndefined()
  await ui.unmount()
})

test('what the transcript and the disk hold is searched too, and none of it is kept', async ($, on) => {
  mock.clock(on, { now: 1000 })
  let reads = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => ({ value: '# Rules\nBe brief.\n' }))
  on('session.messages', () => {
    reads += 1

    return { value: TRANSCRIPT }
  })
  on('session.usage', () => usage([{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 12 }]))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const seeded = reads

  const ui = await $.ui.mount({ ...pane(60), surface: 'desktop' })
  await ui.input({ key: 'search', text: 'parser.ts' })
  expect(await ui.find({ key: 'entry-old1' })).toBeDefined()
  expect(await ui.find({ key: 'entry-old2' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: whole('src/parser.ts') })).toBeDefined()
  // The transcript is read once for one search, however many calls it holds.
  expect(reads).toBe(seeded + 1)

  await ui.input({ key: 'search', text: 'BRIEF' })
  expect(await ui.find({ type: 'Text', text: whole('Nothing matches') })).toBeDefined()
  await ui.press({ key: 'tab-files' })
  expect(await ui.find({ type: 'Button', text: /^CLAUDE\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: whole('Be brief.') })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: whole('1 of 1 match') })).toBeDefined()
  // Nothing was kept of it: another search reads the transcript again.
  expect(reads).toBe(seeded + 2)
  await ui.unmount()
})

test('more matches than one drawing holds are moved through, and a new search starts at the newest', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id.startsWith('p') ? 'a pear' : 'an apple',
  }))
  for (let call = 0; call < 230; call++) {
    await $.tool.call({ tool: 'Bash', tool_use_id: `a${call}`, command: `echo ${call}` })
    if (call % 10 === 0) {
      await $.tool.call({ tool: 'Bash', tool_use_id: `p${call}`, command: `echo ${call}` })
    }
  }

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'apple' })
  expect(await ui.find({ type: 'Text', text: whole('230 of 253 match') })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /131–230 of 230/ })).toBeDefined()
  expect(await ui.find({ key: 'entry-a229' })).toBeDefined()
  expect(await ui.find({ key: 'entry-a130' })).toBeDefined()
  expect(await ui.find({ key: 'entry-a129' })).toBeUndefined()
  expect(await ui.find({ key: 'entry-p220' })).toBeUndefined()

  await ui.press({ key: 'top-older' })
  expect(await ui.find({ type: 'Text', text: /31–130 of 230/ })).toBeDefined()
  await ui.press({ key: 'top-older' })
  expect(await ui.find({ type: 'Text', text: /1–100 of 230/ })).toBeDefined()
  expect(await ui.find({ key: 'entry-a0' })).toBeDefined()
  await ui.press({ key: 'top-newer' })
  expect(await ui.find({ type: 'Text', text: /101–200 of 230/ })).toBeDefined()

  // Sent from an older page, a search with more matches than one drawing holds
  // starts at its newest all the same.
  await ui.press({ key: 'top-older' })
  expect(await ui.find({ type: 'Text', text: /1–100 of 230/ })).toBeDefined()
  await ui.input({ key: 'search', text: 'echo' })
  expect(await ui.find({ type: 'Text', text: whole('253 of 253 match') })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /154–253 of 253/ })).toBeDefined()
  expect(await ui.find({ key: 'entry-a229' })).toBeDefined()

  await ui.press({ key: 'top-older' })
  await ui.input({ key: 'search', text: 'pear' })
  expect(await ui.find({ type: 'Text', text: whole('23 of 253 match') })).toBeDefined()
  expect(await ui.find({ key: 'entry-p220' })).toBeDefined()
  expect(await ui.find({ key: 'top-older' })).toBeUndefined()

  await ui.press({ key: 'search-clear' })
  expect(await ui.find({ type: 'Text', text: /54–253 of 253/ })).toBeDefined()
  await ui.unmount()
})

test('a search is kept across the tabs, and filters the files and the prompts as well', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e) =>
    e.tool === 'Read'
      ? fileRead(
          String(e.file_path),
          String(e.file_path).endsWith('auth.ts') ? 'export const login = 1\n' : 'export const add = 2\n',
        )
      : { result: undefined as never, text: 'ok' },
  )
  await $.prompt.submit({ text: 'Fix the login flow.', wait: false, origin: { kind: 'composer' } })
  // A prompt is known by the moment it was sent.
  await clock.advance(1000)
  await $.prompt.submit({ text: 'Now add a test.', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/repo/src/auth.ts' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/repo/src/util.ts' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' })

  for (const surface of FIELDS) {
    const ui = await $.ui.mount({ ...pane(60), surface })
    await ui.input({ key: 'search', text: 'login' })
    expect(await ui.find({ type: 'Text', text: whole('2 of 5 match') })).toBeDefined()
    expect(await ui.find({ key: 'entry-r1' })).toBeDefined()
    expect(await ui.find({ key: 'entry-r2' })).toBeUndefined()
    expect(await ui.find({ key: 'entry-b1' })).toBeUndefined()

    await ui.press({ key: 'tab-files' })
    expect(await ui.find({ type: 'Text', text: whole('1 of 2 match') })).toBeDefined()
    expect(await ui.find({ key: 'entry-r1' })).toBeDefined()
    expect(await ui.find({ key: 'entry-r2' })).toBeUndefined()
    expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('login')

    await ui.press({ key: 'tab-prompts' })
    expect(await ui.find({ type: 'Text', text: whole('1 of 2 match') })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /^Fix the login flow\./ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /^Now add a test\./ })).toBeUndefined()
    // A prompt keeps its number among them all.
    expect(await ui.find({ type: 'Text', text: /^#1 / })).toBeDefined()

    await ui.input({ key: 'search', text: 'add a' })
    expect(await ui.find({ type: 'Text', text: /^#2 / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^#1 / })).toBeUndefined()

    // The Now tab lists no entry: no field, and nothing said of the search.
    await ui.press({ key: 'tab-now' })
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    expect(await ui.find({ key: 'search-clear' })).toBeUndefined()

    await ui.press({ key: 'tab-timeline' })
    expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('add a')
    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }
})

test('a file read several times is counted, and opened, by the reads that hold the text', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) =>
    fileRead('/repo/src/app.ts', e.tool_use_id === 'first' ? 'const needle = 1\n' : 'const other = 2\n'),
  )
  await $.tool.call({ tool: 'Read', tool_use_id: 'first', file_path: '/repo/src/app.ts' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'second', file_path: '/repo/src/app.ts', offset: 40 })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'tab-files' })
  expect(await ui.find({ key: 'entry-second' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^2×/ })).toBeDefined()

  await ui.input({ key: 'search', text: 'needle' })
  expect(await ui.find({ key: 'entry-second' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1×/ })).toBeDefined()
  await ui.press({ key: 'entry-first' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('const needle = 1\n')
  await ui.unmount()
})

test('a row opened under a search starts at the part that holds the text', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const lines = Array.from({ length: 1200 }, (_, index) =>
    index === 900 ? 'the zebra crossing' : `line ${index + 1} of the output`,
  )
  on('tool.call', () => ({ result: undefined as never, text: lines.join('\n') }))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'cat big.log' })

  for (const surface of FIELDS) {
    const ui = await $.ui.mount({ ...pane(60), surface })
    await ui.input({ key: 'search', text: 'zebra' })
    await ui.press({ key: 'entry-b1' })
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('the zebra crossing')
    expect(await ui.find({ key: 'top-earlier-b1' })).toBeDefined()
    expect(await ui.find({ key: 'top-later-b1' })).toBeDefined()

    // Its title holds this one, and so does its input, in the first part.
    await ui.press({ key: 'entry-b1' })
    await ui.input({ key: 'search', text: 'big.log' })
    await ui.press({ key: 'entry-b1' })
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('command: cat big.log')
    expect(await ui.find({ key: 'top-earlier-b1' })).toBeUndefined()

    await ui.press({ key: 'entry-b1' })
    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }
})

test('a search closes the open entries it hides, and taking it away leaves the others open', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({ result: undefined as never, text: `output of ${e.tool_use_id}` }))
  for (const id of ['a', 'b']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `echo ${id}` })
  }

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'entry-a' })
  await ui.press({ key: 'entry-b' })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(2)

  await ui.input({ key: 'search', text: 'output of b' })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(1)
  expect(await ui.find({ key: 'close-b' })).toBeDefined()

  await ui.press({ key: 'search-clear' })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(1)
  expect(await ui.find({ key: 'close-b' })).toBeDefined()
  expect(await ui.find({ key: 'close-a' })).toBeUndefined()
  expect(await ui.find({ key: 'entry-a' })).toBeDefined()
  await ui.unmount()
})

test('/clear takes the search away with the rest', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'echo a' })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'echo' })
  expect(await ui.find({ key: 'search-clear' })).toBeDefined()

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await ui.redraw()
  expect(await ui.find({ key: 'search-clear' })).toBeUndefined()
  expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('')
  expect(await ui.find({ type: 'Text', text: whole('Nothing has entered the context yet.') })).toBeDefined()
  await ui.unmount()
})

test('the mobile app, which draws no field, draws the pane as before, and a search the command set', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id === 'b' ? 'a needle' : 'nothing',
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  for (const id of ['a', 'b']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `echo ${id}` })
  }

  const ui = await $.ui.mount({ ...pane(60), surface: 'mobile' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ key: 'search-focus' })).toBeUndefined()
  expect(await ui.find({ key: 'entry-a' })).toBeDefined()
  expect(await ui.find({ key: 'entry-b' })).toBeDefined()

  const ran = await $.command.run({
    command: 'whats-in-context',
    args: ' needle ',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(ran.text).toBe('What\'s in context: pane opened, searching for "needle".')
  await ui.redraw()
  expect(await ui.find({ key: 'entry-a' })).toBeUndefined()
  expect(await ui.find({ key: 'entry-b' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: whole('1 of 2 match "needle"') })).toBeDefined()

  await ui.press({ key: 'search-clear' })
  expect(await ui.find({ key: 'entry-a' })).toBeDefined()
  await ui.unmount()
})

test('/whats-in-context with a text opens the pane with that search set, on a tab that lists entries', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const opens: string[] = []
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id === 'b' ? 'a needle' : 'nothing',
  }))
  on('ui.open', (_, e) => {
    opens.push(e.id)

    return { value: { isPlaced: true } }
  })
  for (const id of ['a', 'b']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `echo ${id}` })
  }
  const run = (args: string) =>
    $.command.run({
      command: 'whats-in-context',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'tab-now' })
  expect((await run('needle')).text).toBe('What\'s in context: pane opened, searching for "needle".')
  expect(opens).toEqual(['whats-in-context'])
  await ui.redraw()
  expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('needle')
  expect(await ui.find({ key: 'entry-b' })).toBeDefined()
  expect(await ui.find({ key: 'entry-a' })).toBeUndefined()

  // Bare, it opens the pane and leaves the search as it is.
  expect((await run('')).text).toBe("What's in context: pane opened.")
  await ui.redraw()
  expect(await ui.find({ key: 'entry-a' })).toBeUndefined()
  await ui.unmount()
})

// The kit keeps no focus ring, so the move itself is seen in a real terminal.
test('the Search button, wherever there is a field, has a key of its own', async $ => {
  for (const surface of FIELDS) {
    const ui = await $.ui.mount({ ...pane(60), surface })
    expect((await ui.find({ key: 'search-focus' }))?.props.hotkey).toBe('s')
    await ui.press({ key: 'search-focus' })
    expect(await ui.find({ type: 'Input', key: 'search' })).toBeDefined()
    await ui.unmount()
  }
})

test('an instruction file loaded while a search is set joins it when it holds the text', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const loaded = [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 12 }]
  // A read names the path as the machine spells it.
  on('fs.read', (_, e) => ({
    value: /src[\\/]CLAUDE\.md$/.test(String(e.path)) ? 'Keep the needle sharp.\n' : '# Rules\n',
  }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => usage(loaded))
  const turn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  await turn()
  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'tab-files' })
  await ui.input({ key: 'search', text: 'needle' })
  expect(await ui.find({ type: 'Text', text: whole('Nothing matches') })).toBeDefined()

  loaded.push({ path: '/repo/src/CLAUDE.md', type: 'Project', tokens: 9 })
  await turn()
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: whole('1 of 2 match') })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: whole('Keep the needle sharp.') })).toBeDefined()
  await ui.unmount()
})

// The files and the prompts are drawn whole, so a search must not make a long list longer.
test('a list of more than a hundred files is drawn whole, without the lines', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) =>
    fileRead(e.tool === 'Read' ? e.file_path : '', 'const needle = 1\n'),
  )
  for (let file = 0; file < 101; file++) {
    await $.tool.call({ tool: 'Read', tool_use_id: `r${file}`, file_path: `/repo/src/file${file}.ts` })
  }

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'tab-files' })
  await ui.input({ key: 'search', text: 'needle' })
  expect(await ui.find({ type: 'Text', text: whole('101 of 101 match') })).toBeDefined()
  expect(await ui.findAll({ type: 'Button', text: /^file\d+\.ts / })).toHaveLength(101)
  expect(await ui.findAll({ type: 'Text', text: whole('const needle = 1') })).toHaveLength(0)

  // The timeline draws a hundred of them at a time, and those have their lines.
  await ui.press({ key: 'tab-timeline' })
  expect(await ui.find({ type: 'Text', text: /2–101 of 101/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: whole('const needle = 1') })).toHaveLength(100)
  await ui.unmount()
})

test('the fullest drawing of the files under a search stays whole', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const long = Array.from({ length: 400 }, (_, index) => `line ${index + 1} holds a needle and more`)
  on('tool.call', (_, e) =>
    fileRead(
      e.tool === 'Read' ? e.file_path : '',
      e.tool_use_id.startsWith('long')
        ? long.join('\n')
        : `${'x'.repeat(200)} needle ${'y'.repeat(200)}\n`,
    ),
  )
  for (let file = 0; file < 100; file++) {
    await $.tool.call({
      tool: 'Read',
      tool_use_id: file < 8 ? `long${file}` : `r${file}`,
      file_path: `/repo/${'d'.repeat(70)}${file}/${'e'.repeat(70)}/file${file}.ts`,
    })
  }

  // A wide pane, a hundred files whose titles fill their rows, each with its line,
  // and eight long ones open.
  const ui = await $.ui.mount({ ...pane(170), surface: 'terminal' })
  await ui.press({ key: 'tab-files' })
  await ui.input({ key: 'search', text: 'needle' })
  for (let file = 0; file < 8; file++) await ui.press({ key: `entry-long${file}` })

  expect(await ui.findAll({ type: 'Code' })).toHaveLength(8)
  expect(await ui.findAll({ type: 'Button', text: /^file\d+\.ts / })).toHaveLength(100)
  expect(await ui.findAll({ type: 'Text', text: /^…x+ needle y+…$/ })).toHaveLength(92)
  const drawn = (await ui.find({ type: 'Box' }))?.text.length ?? 0
  expect(drawn).toBeGreaterThan(85_000)
  expect(drawn).toBeLessThan(100_000)
  await ui.unmount()
})

// An id is the search's own key, never a name every object has. (`__proto__` is
// left out: the engine drops that key from a value on its way to `$.state`, so no
// value keyed by id can carry it, and no entry's id has that form.)
test('an entry whose id is a name every object has is found, or not, like any other', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id === 'toString' || e.tool_use_id === 'late' ? 'a needle' : 'nothing',
  }))
  for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: 'echo' })
  }

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'needle' })
  expect(await ui.find({ type: 'Text', text: whole('1 of 4 match') })).toBeDefined()
  expect(await ui.find({ key: 'entry-toString' })).toBeDefined()
  expect(await ui.find({ key: 'entry-constructor' })).toBeUndefined()
  expect(await ui.find({ key: 'entry-valueOf' })).toBeUndefined()
  expect(await ui.find({ key: 'entry-hasOwnProperty' })).toBeUndefined()

  // Nor does one of them come to match when another entry joins the search.
  await $.tool.call({ tool: 'Bash', tool_use_id: 'late', command: 'echo' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: whole('2 of 5 match') })).toBeDefined()
  expect(await ui.find({ key: 'entry-constructor' })).toBeUndefined()
  await ui.unmount()
})

test('a tool call is found by any of its arguments, and by its result under a long input', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const lines = Array.from({ length: 1200 }, (_, index) =>
    index === 900 ? 'the zebra crossing' : `line ${index + 1} of the output`,
  )
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id === 'long' ? lines.join('\n') : 'nothing',
  }))
  // The title is made of the command; the description is in the input alone.
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'b',
    command: 'ls -a',
    description: 'Lists the hidden files',
  })
  // An input of several parts' length, so the result starts far into what is drawn.
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'long',
    command: 'cat big.log',
    description: 'Reads the log. '.repeat(1300),
  })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'hidden files' })
  expect(await ui.find({ key: 'entry-b' })).toBeDefined()
  expect(await ui.find({ key: 'entry-long' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: whole('description: Lists the hidden files') })).toBeDefined()

  await ui.input({ key: 'search', text: 'zebra' })
  await ui.press({ key: 'entry-long' })
  const source = String((await ui.find({ type: 'Code' }))?.props.source)
  expect(source).toContain('the zebra crossing')
  expect(source).not.toContain('Reads the log.')
  await ui.unmount()
})

test('the line under a row is cut to the room the row has, around the text', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({
    result: undefined as never,
    text: `${'x'.repeat(300)} needle ${'y'.repeat(300)}`,
  }))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'echo a' })

  // The room a title has at each width, and never more than a hundred characters.
  for (const [columns, room] of [
    [24, 8],
    [60, 41],
    [100, 74],
    [170, 100],
  ] as const) {
    const ui = await $.ui.mount({ ...pane(columns), surface: 'terminal' })
    await ui.input({ key: 'search', text: 'needle' })
    const line = (await ui.find({ type: 'Text', text: /needle/ }))?.text ?? ''
    expect(line).toMatch(/^…x* ?needle/)
    expect(line.length).toBeLessThanOrEqual(room)
    expect(line.length).toBeGreaterThan(room - 2)
    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }

  // A name the title leaves out is drawn on that line too, and held to the same hundred.
  await $.tool.call({
    tool: 'Read',
    tool_use_id: 'r',
    file_path: `/repo/${'d'.repeat(120)}/middle-part/${'e'.repeat(60)}/src/app.ts`,
  })
  const ui = await $.ui.mount({ ...pane(170), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'middle-part' })
  const name = (await ui.find({ type: 'Text', text: /middle-part/ }))?.text ?? ''
  expect(name).toMatch(/^…d+\/middle-part\/e+…$/)
  expect(name.length).toBeLessThanOrEqual(100)
  expect(name.length).toBeGreaterThan(98)
  await ui.unmount()
})

// One drawing holds 100,000 characters of text, and what is past them is not drawn.
test('the fullest drawing of a search stays whole', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const long = Array.from({ length: 400 }, (_, index) => `line ${index + 1} holds a needle and more`)
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: e.tool_use_id.startsWith('long')
      ? long.join('\n')
      : `${'x'.repeat(200)} needle ${'y'.repeat(200)}`,
  }))
  for (let call = 0; call < 210; call++) {
    const id = call >= 200 && call < 208 ? `long${call}` : `c${call}`
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `${'z'.repeat(280)} ${call}` })
  }

  // A wide pane: every title fills its row, every match has a full line under it,
  // and eight long entries are open.
  const ui = await $.ui.mount({ ...pane(170), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'needle' })
  for (let call = 200; call < 208; call++) await ui.press({ key: `entry-long${call}` })

  const codes = await ui.findAll({ type: 'Code' })
  expect(codes).toHaveLength(8)
  expect(codes.reduce((sum, code) => sum + String(code.props.source).length, 0)).toBeGreaterThan(60_000)
  expect(await ui.find({ type: 'Text', text: /111–210 of 210/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^…x+ needle y+…$/ })).length).toBe(92)
  const drawn = (await ui.find({ type: 'Box' }))?.text.length ?? 0
  expect(drawn).toBeGreaterThan(85_000)
  expect(drawn).toBeLessThan(100_000)
  expect(await ui.find({ key: 'entry-c110' })).toBeDefined()
  expect(await ui.find({ key: 'entry-c209' })).toBeDefined()
  expect(await ui.find({ key: 'end-older' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Sizes are estimates \(characters \/ 4\)\.$/ })).toBeDefined()
  await ui.unmount()
})

// A path is kept as the machine spells it and drawn with a forward slash.
test('a file is found by its path spelled with either slash, and by its title as it is drawn', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) =>
    e.tool === 'Read'
      ? fileRead(e.file_path, 'export const answer = 42\n')
      : { result: undefined as never, text: 'nothing' },
  )
  await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: 'E:\\projects\\app\\src\\auth.ts' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'echo one' })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  expect((await ui.find({ key: 'entry-r' }))?.text).toBe('auth.ts app/src')

  const spellings = ['app/src', 'app\\src', 'src/auth.ts', 'src\\auth.ts', 'auth.ts app', 'E:\\projects']
  for (const text of spellings) {
    await ui.input({ key: 'search', text })
    expect(await ui.find({ key: 'entry-r' })).toBeDefined()
    expect(await ui.find({ key: 'entry-b' })).toBeUndefined()
  }

  // In the title as it is drawn the text is marked there; out of it, on a line under.
  await ui.input({ key: 'search', text: 'app/src' })
  expect((await ui.find({ type: 'Text', text: whole('app/src') }))?.props.inverse).toBe(true)
  await ui.input({ key: 'search', text: 'src/auth.ts' })
  expect((await ui.find({ type: 'Text', text: whole('src/auth.ts') }))?.props.inverse).toBe(true)
  expect(await ui.find({ type: 'Text', text: whole('E:/projects/app/src/auth.ts') })).toBeDefined()
  await ui.unmount()
})

test('a title is found by its whole text as drawn, and marked from its first letter', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({ result: undefined as never, text: 'nothing' }))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'echo one' })
  const marked = async (ui: { findAll: (by: { type: 'Text'; text: RegExp }) => Promise<{ props: { inverse?: boolean } }[]> }, text: string) =>
    (await ui.findAll({ type: 'Text', text: whole(text) })).some(one => one.props.inverse === true)

  for (const surface of FIELDS) {
    const ui = await $.ui.mount({ ...pane(60), surface })

    // The whole of the name, with nothing before the mark, and no line under the row.
    await ui.input({ key: 'search', text: 'BASH' })
    expect((await ui.find({ key: 'entry-b' }))?.text).toBe('Bash echo one')
    expect(await marked(ui, 'Bash')).toBe(true)
    expect(await ui.find({ type: 'Text', text: whole('Bash echo one') })).toBeUndefined()

    // Across the name and the rest of the title: found, and said on a line of its own.
    await ui.input({ key: 'search', text: 'bash echo' })
    expect((await ui.find({ key: 'entry-b' }))?.text).toBe('Bash echo one')
    expect(await marked(ui, 'Bash echo')).toBe(true)

    // The whole of the title.
    await ui.input({ key: 'search', text: 'bash echo one' })
    expect(await marked(ui, 'Bash echo one')).toBe(true)

    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }
})

test('a space in the text stands for any run of white space within a line', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text:
      e.tool_use_id === 'a'
        ? 'key\tvalue\nPrix : 12 €\nfoo    bar'
        : 'keyvalue Prix: 12€ foobar\nfoo\nbar',
  }))
  for (const id of ['a', 'b']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `echo ${id}` })
  }

  for (const surface of FIELDS) {
    const ui = await $.ui.mount({ ...pane(60), surface })
    // Typed with a space, or pasted with what the content holds: a tab, a no-break space.
    const texts = ['key value', 'key\tvalue', 'Prix : 12 €', 'Prix : 12 €', '  foo \t bar  ', 'foo bar']
    for (const text of texts) {
      await ui.input({ key: 'search', text })
      expect(await ui.find({ key: 'entry-a' })).toBeDefined()
      expect(await ui.find({ key: 'entry-b' })).toBeUndefined()
    }
    // What is kept, and drawn back in the field, holds no tab.
    expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('foo bar')

    // The line is drawn with its tab as a space, and the text is marked on it.
    await ui.input({ key: 'search', text: 'key value' })
    const lines = await ui.findAll({ type: 'Text', text: whole('key value') })
    expect(lines.some(one => one.props.inverse === true)).toBe(true)

    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }
})

test('an entry listed from the transcript opens at the part that holds the text', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const lines = Array.from({ length: 1200 }, (_, index) =>
    index === 900 ? 'the zebra crossing' : `line ${index + 1} of the output`,
  )
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => usage([]))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Show the log.', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'old1', tool: 'Bash', input: { command: 'cat big.log' }, text: lines.join('\n') },
        ],
      },
    ],
  }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'zebra' })
  await ui.press({ key: 'entry-old1' })
  expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('the zebra crossing')
  expect(await ui.find({ key: 'top-earlier-old1' })).toBeDefined()
  expect(await ui.find({ key: 'top-later-old1' })).toBeDefined()
  await ui.unmount()
})

test('a call the transcript no longer holds is searched by its title, and each tab says how many', async ($, on) => {
  mock.clock(on, { now: 1000 })
  let isCompacted = false
  const calls = [
    { tool_use_id: 'old1', tool: 'Grep', input: { pattern: 'parse\\(' }, text: 'src/parser.ts' },
    { tool_use_id: 'old2', tool: 'Bash', input: { command: 'ls' }, text: 'src/parser.ts' },
    { tool_use_id: 'old3', tool: 'Read', input: { file_path: '/repo/src/app.ts' }, text: 'parser.ts' },
  ]
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => usage([]))
  // After the mod has listed them, a compaction takes the last two calls.
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Find the parser.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: isCompacted ? calls.slice(0, 1) : calls },
    ],
  }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  isCompacted = true

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.input({ key: 'search', text: 'parser.ts' })
  expect(await ui.find({ key: 'entry-old1' })).toBeDefined()
  expect(await ui.find({ key: 'entry-old2' })).toBeUndefined()
  expect(await ui.find({ key: 'entry-old3' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: whole('1 of 4 match · 2 by title only') })).toBeDefined()

  // The figure is of the rows the tab lists: one file, and no prompt, whose text is kept.
  await ui.press({ key: 'tab-files' })
  expect(await ui.find({ type: 'Text', text: whole('Nothing matches · 1 by title only') })).toBeDefined()
  await ui.press({ key: 'tab-prompts' })
  expect(await ui.find({ type: 'Text', text: whole('Nothing matches') })).toBeDefined()

  // Its title is searched still, and then it is no row searched by title alone.
  await ui.press({ key: 'tab-timeline' })
  await ui.input({ key: 'search', text: 'bash ls' })
  expect(await ui.find({ key: 'entry-old2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: whole('1 of 4 match · 1 by title only') })).toBeDefined()
  await ui.unmount()
})

test('of two searches under way at once, the one asked for last stands', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let isSlow = false
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => usage([]))
  // The transcript answers the first search late.
  on('session.messages', async () => {
    if (isSlow) {
      isSlow = false
      await clock.sleep(1000)
    }

    return { value: TRANSCRIPT }
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  isSlow = true
  const first = ui.input({ key: 'search', text: 'parser.ts' })
  await clock.settle()
  const second = ui.input({ key: 'search', text: 'readme' })
  await clock.settle()
  await ui.redraw()
  expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('readme')

  await clock.advance(1000)
  await Promise.all([first, second])
  await ui.redraw()
  expect((await ui.find({ type: 'Input', key: 'search' }))?.props.value).toBe('readme')
  expect(await ui.find({ key: 'entry-old2' })).toBeDefined()
  expect(await ui.find({ key: 'entry-old1' })).toBeUndefined()
  await ui.unmount()
})

test('what is recorded or loaded while a search reads joins that search', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const loaded = [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 12 }]
  let isSlow = false
  // The first instruction file is read late, and the rest comes meanwhile.
  on('fs.read', async (_, e) => {
    if (isSlow) {
      isSlow = false
      await clock.sleep(1000)
    }

    return {
      value: /src[\\/]CLAUDE\.md$/.test(String(e.path)) ? 'Keep the needle sharp.\n' : '# Rules\n',
    }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => usage(loaded))
  on('tool.call', () => ({ result: undefined as never, text: 'a needle' }))
  const turn = () =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  await turn()
  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  isSlow = true
  const search = ui.input({ key: 'search', text: 'needle' })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', tool_use_id: 'late', command: 'echo 1' })
  loaded.push({ path: '/repo/src/CLAUDE.md', type: 'Project', tokens: 9 })
  await turn()
  await clock.advance(1000)
  await search
  await ui.redraw()

  expect(await ui.find({ key: 'entry-late' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: whole('1 of 1 match') })).toBeDefined()
  await ui.press({ key: 'tab-files' })
  expect(await ui.find({ type: 'Text', text: whole('1 of 2 match') })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: whole('Keep the needle sharp.') })).toBeDefined()
  await ui.unmount()
})
