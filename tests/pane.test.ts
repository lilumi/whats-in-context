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

const BAND = {
  plugin: 'whats-in-context',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

const CONTENT = 'export const answer = 42\n'

const fileRead = () => ({
  result: {
    type: 'text',
    file: {
      filePath: '/repo/src/app.ts',
      content: CONTENT,
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    },
  } as never,
  text: `1\t${CONTENT}`,
})

test('a file Claude read is listed by its name, on every surface', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', fileRead)

  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/repo/src/app.ts' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane(60), surface })
    const row = await ui.find({ type: 'Button', key: 'entry-t1' })
    expect(row?.text).toMatch(/^app\.ts repo\/src/)
    await ui.unmount()
  }
})

test('a click on an entry shows what it put into the context, another closes it', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', fileRead)

  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/repo/src/app.ts' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(60), surface })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()

    await ui.press({ key: 'entry-t1' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.source).toBe(CONTENT)
    expect(code?.props.startLine).toBe(1)
    expect(await ui.find({ type: 'Text', text: '/repo/src/app.ts' })).toBeDefined()

    await ui.press({ key: 'entry-t1' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a long Grep is one short row, and whole once opened', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({ result: undefined as never, text: 'src/a.ts\nsrc/b.ts' }))
  const pattern = Array.from({ length: 60 }, (_, index) => `word${index}`).join('|')

  await $.tool.call({ tool: 'Grep', tool_use_id: 'g1', pattern, path: '/repo/src' })

  const ui = await $.ui.mount({ ...pane(40), surface: 'desktop' })
  const row = await ui.find({ type: 'Button', key: 'entry-g1' })
  expect(row?.text).toMatch(/^Grep "word0\|/)
  expect(row?.text.length ?? 0).toBeLessThanOrEqual(40)

  await ui.press({ key: 'entry-g1' })
  const source = String((await ui.find({ type: 'Code' }))?.props.source)
  expect(source).toContain(`pattern: ${pattern}`)
  expect(source).toContain('src/b.ts')
  await ui.unmount()
})

test('a long result is read a part at a time', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const lines = Array.from({ length: 1200 }, (_, index) => `line ${index + 1} of the output`)
  on('tool.call', () => ({ result: undefined as never, text: lines.join('\n') }))

  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'cat big.log' })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'entry-b1' })
  expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('command: cat big.log')
  expect(await ui.find({ key: 'top-earlier-b1' })).toBeUndefined()

  let source = ''
  for (let part = 0; part < 20 && (await ui.find({ key: 'top-later-b1' })) !== undefined; part++) {
    await ui.press({ key: 'top-later-b1' })
    source = String((await ui.find({ type: 'Code' }))?.props.source)
  }
  expect(source).toContain('line 1200 of the output')
  await ui.unmount()
})

test('several entries stay open at once, each closed by itself or all together', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({ result: undefined as never, text: `output of ${e.tool_use_id}` }))

  for (const id of ['a', 'b', 'c']) {
    await $.tool.call({ tool: 'Bash', tool_use_id: id, command: `echo ${id}` })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(60), surface })
    const sources = async () =>
      (await ui.findAll({ type: 'Code' })).map(code => String(code.props.source).split('\n').at(-1))

    await ui.press({ key: 'entry-a' })
    expect(await ui.find({ key: 'close-all' })).toBeUndefined()
    await ui.press({ key: 'entry-c' })
    await ui.press({ key: 'entry-b' })
    expect(await sources()).toEqual(['output of a', 'output of b', 'output of c'])

    await ui.press({ key: 'close-b' })
    expect(await sources()).toEqual(['output of a', 'output of c'])
    await ui.press({ key: 'entry-a' })
    expect(await sources()).toEqual(['output of c'])

    await ui.press({ key: 'entry-a' })
    await ui.press({ key: 'close-all' })
    expect(await sources()).toEqual([])
    await ui.unmount()
  }
})

test('each open entry turns its own parts, and the keys go to the one opened last', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', (_, e) => ({
    result: undefined as never,
    text: Array.from({ length: 1200 }, (_, index) => `${e.tool_use_id} line ${index + 1}`).join('\n'),
  }))

  await $.tool.call({ tool: 'Bash', tool_use_id: 'x', command: 'cat x.log' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'y', command: 'cat y.log' })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'entry-x' })
  expect((await ui.find({ key: 'top-later-x' }))?.props.hotkey).toBe('j')

  await ui.press({ key: 'entry-y' })
  expect((await ui.find({ key: 'top-later-x' }))?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: 'top-later-y' }))?.props.hotkey).toBe('j')

  await ui.press({ key: 'top-later-x' })
  const [first, second] = await ui.findAll({ type: 'Code' })
  expect(String(first?.props.source)).not.toContain('x line 1\n')
  expect(String(second?.props.source)).toContain('y line 1\n')
  await ui.unmount()
})

test('one more than fit closes the entry opened first', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))

  for (let call = 0; call < 9; call++) {
    await $.tool.call({ tool: 'Bash', tool_use_id: `c${call}`, command: `echo ${call}` })
  }

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  for (let call = 0; call < 9; call++) await ui.press({ key: `entry-c${call}` })

  expect(await ui.findAll({ type: 'Code' })).toHaveLength(8)
  expect(await ui.find({ key: 'close-c0' })).toBeUndefined()
  expect(await ui.find({ key: 'close-c8' })).toBeDefined()
  await ui.unmount()
})

test('every entry is kept, and the timeline moves through them', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('tool.call', () => ({ result: undefined as never, text: 'ok' }))

  for (let call = 0; call < 230; call++) {
    await $.tool.call({ tool: 'Bash', tool_use_id: `c${call}`, command: `echo ${call}` })
  }

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /31–230 of 230/ })).toBeDefined()
  expect(await ui.find({ key: 'entry-c229' })).toBeDefined()
  expect(await ui.find({ key: 'entry-c0' })).toBeUndefined()

  await ui.press({ key: 'top-older' })
  expect(await ui.find({ type: 'Text', text: /1–200 of 230/ })).toBeDefined()
  expect(await ui.find({ key: 'entry-c0' })).toBeDefined()
  await ui.unmount()
})

test('a prompt is listed and opens to its whole text', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const text = `Refactor the parser.\n\n${'Keep every public name as it is. '.repeat(30)}`
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

  const ui = await $.ui.mount({ ...pane(60), surface: 'desktop' })
  const row = await ui.find({ type: 'Button', text: /^Refactor the parser\./ })
  expect(row).toBeDefined()

  await ui.press({ key: row?.key ?? '' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(text)
  await ui.unmount()
})

test('loaded into a running session, it lists what came before and reads it back', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => ({ value: '# Rules\nBe brief.\n' }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Find the parser.', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'old1',
            tool: 'Grep',
            input: { pattern: 'parse\\(', path: '/repo/src' },
            text: 'src/parser.ts',
          },
        ],
      },
    ],
  }))
  on('session.usage', () => ({
    value: {
      startedAt: 500,
      rateLimits: [],
      context: {
        window: 200_000,
        breakdown: {
          categories: [{ name: 'Messages', tokens: 900, color: 'claude', isDeferred: false, kind: 'used' }],
          totalTokens: 900,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          autocompactSource: 'auto',
          percentage: 1,
          gridRows: [],
          model: 'opus',
          memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 12 }],
          mcpTools: [],
          agents: [],
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
    },
  }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...pane(60), surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /^Find the parser\./ })).toBeDefined()
  expect((await ui.find({ key: 'entry-old1' }))?.text).toBe('Grep "parse\\(" in repo/src')

  await ui.press({ key: 'entry-old1' })
  const source = String((await ui.find({ type: 'Code' }))?.props.source)
  expect(source).toContain('pattern: parse\\(')
  expect(source).toContain('src/parser.ts')

  await ui.press({ key: 'tab-files' })
  const memory = await ui.find({ type: 'Button', text: /^CLAUDE\.md/ })
  await ui.press({ key: memory?.key ?? '' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('# Rules\nBe brief.\n')
  expect(await ui.find({ type: 'Text', text: 'The file as it is on disk now.' })).toBeDefined()
  await ui.unmount()
})

test('the button above the prompt opens the pane, then closes it', async ($, on) => {
  const calls: string[] = []
  let isOpen = false
  on('ui.panes', () => ({
    value: isOpen
      ? [
          {
            id: 'whats-in-context',
            title: "What's in context",
            isShown: true,
            isFocused: false,
            isPlaced: true,
          },
        ]
      : [],
  }))
  on('ui.open', (_, e) => {
    calls.push(`open ${e.id}`)
    isOpen = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    calls.push(`close ${e.id}`)
    isOpen = false

    return { value: undefined }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'toggle' })
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }

  expect(calls).toEqual([
    'open whats-in-context',
    'close whats-in-context',
    'open whats-in-context',
    'close whats-in-context',
  ])
})

test('the press on the button lasts until the pane is opened, so the open is an asked one', async ($, on) => {
  const order: string[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => {
    order.push('opened')

    return { value: { isPlaced: true } }
  })
  on('ui.press', async (_, e, next) => {
    const pressed = await next(e)
    order.push('settled')

    return pressed
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'toggle' })
  await ui.unmount()

  expect(order).toEqual(['opened', 'settled'])
})

test('a context reading draws the fill in the pane and on the button', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { tokens: 50_000, window: 200_000, percent: 25 },
    rateLimits: [],
    changed: ['context'],
  })

  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /50\.0k \/ 200\.0k\s+25%/ })).toBeDefined()
  await ui.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ key: 'toggle' }))?.text).toMatch(/Context 50\.0k · 25%/)
  await band.unmount()
})
