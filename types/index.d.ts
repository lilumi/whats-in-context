export type EntryKind = 'prompt' | 'file' | 'mention' | 'tool' | 'compact' | 'memory'

/** One thing that entered (or, for a compaction, left) the main conversation's context. */
export type Entry = {
  id: string
  /** `$.clock.now()` when it was recorded; 0 for one read back from the transcript at load. */
  at: number
  kind: EntryKind
  /** A prompt's first words, a file's path, a tool's name. */
  label: string
  /** A tool's arguments in short, a compaction's before and after. */
  detail: string
  /** Estimated tokens added (characters / 4); negative for a compaction, 0 when unknown. */
  tokens: number
}

/** What one entry put into the context, kept whole for the view a click opens. */
export type Body = {
  /** A prompt's text, a tool's result as the model read it, a file's content. */
  text: string
  /** The number of `text`'s first line when it is a file's; 0 for no gutter. */
  startLine: number
  /** A tool call's arguments, one `key: value` each; '' when it has none. */
  input: string
  /** A line said above the content (where it came from, why there is none); '' for none. */
  note: string
}

/** One entry opened in place, and which part of its content is drawn, from 0. */
export type Opened = { id: string; page: number }

/**
 * The entries that hold a text, by their id. An entry's value is the line of its
 * content the text is on, kept short around it; '' when its title holds the text.
 */
export type Hits = Record<string, string>

/**
 * A search of the entries: the text sought, the entries found to hold it, and the
 * ids of those searched by their title alone, their content being out of reach.
 */
export type Search = { text: string; hits: Hits; unread: string[] }

/** What held a search's text after it was run: the entries recorded and the files loaded since. */
export type Joined = { text: string; hits: Hits }

/** The context window's fill as one API response reported it. */
export type Sample = { at: number; tokens: number; window: number }

export type BreakdownRow = { name: string; tokens: number; kind: string }

export type BreakdownFile = { path: string; type: string; tokens: number }

/** The window by category, as /context breaks it down, at the last turn's end. */
export type Breakdown = {
  rows: BreakdownRow[]
  total: number
  max: number
  percent: number
  model: string
  memoryFiles: BreakdownFile[]
}

export type Tab = 'timeline' | 'files' | 'prompts' | 'now'

declare module 'claude-code' {
  interface PluginState {
    'whats-in-context': {
      entries: Entry[]
      samples: Sample[]
      breakdown: Breakdown | null
      tab: Tab
      startedAt: number
      isSeeded: boolean
      /** The entries opened in place, the one opened last at the end; empty while none is. */
      opened: Opened[]
      /** The entry count the timeline's window ends at; -1 follows the newest. */
      listEnd: number
      /** The search that is set; null while none is. */
      search: Search | null
      /**
       * What has joined that search since, under the same text. Kept apart from it, so
       * that one more match does not rewrite every match there is; null while none is set.
       */
      joined: Joined | null
      /** Each entry's content, by the entry's id. */
      bodies: StateFamily<Body>
    }
  }
}
