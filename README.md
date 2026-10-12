# What's in context

A Claude Code mod (a plugin with a hooks module) that shows what Claude has read into its context window this session, and how the window filled up.

## What it draws

- **A button above the prompt**, `◧ Context 82.1k · 41%`: the live fill, and a click opens or closes the sidebar. Mods cannot add a button to the desktop app's top toolbar (where Terminal and Changes sit), so this row is the nearest place.
- **A sidebar pane**, also opened by `/whats-in-context`, with the fill, a sparkline of the fill after each model response, and four tabs:
  - **Timeline**: every prompt, file read, `@`-mention, tool call and compaction, in order, with how much each added.
  - **Files**: the instruction and memory files loaded, then every file read, with read counts.
  - **Prompts**: each prompt.
  - **Now**: the window by category, as `/context` breaks it down.
- **Click a row** to open it in place: a tool call's input and result, a file's content with line numbers, a prompt's whole text, a compaction's summary. Long content is drawn a part at a time.
- **Several rows stay open at once**, up to 8. Another click on a row, or its `▴ Close`, closes that one; `▴ Close all` under the tabs, or a change of tab, closes them all.
- **Search**, in the field under the tabs: type some text and press Enter, and the Timeline, Files and Prompts tabs list only the entries that hold it, in their title or in what they put into the context. The text is sought as it is typed, in any letter case, never as a pattern; a space in it stands for any run of white space within a line (spaces, tabs, a no-break space).
  - A line says how many of the tab's rows match, and how many of them could be searched by their title only. `✕ Clear` beside it, or an empty Enter, brings every row back.
  - A row shows where it holds the text: marked in its title, or on a line under it. A long entry opens at the part that holds it.
  - `s` moves to the field while the pane has the keyboard, and `/whats-in-context some text` opens the pane with that search set.

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest. |
| `.claude-plugin/marketplace.json` | Makes this folder a marketplace of one plugin, so it can be installed from here. |
| `hooks/hooks.json` | Names the hooks module. |
| `hooks/register.tsx` | The mod: every hook and the two drawings. |
| `types/index.d.ts` | The contract for the values kept in `$.state`. |
| `tests/pane.test.ts`, `tests/search.test.ts` | Tests, run against the engine. |
| `.claude-plugin/types/` | The API's type declarations, written by Claude Code. Not edited, not committed. |

## Run it

For one terminal session, reloading when a file is saved:

```bash
claude --plugin-dir E:\projects\whats-in-context
```

In every session, read from this folder (an edit is picked up by `/reload-plugins` or the next session):

```bash
claude plugin marketplace add E:\projects\whats-in-context
claude plugin install whats-in-context@whats-in-context --scope user
```

## Check a change

```bash
claude plugin validate .
claude plugin test .
npx -y -p typescript tsc -p .
```

`tsc` reads the declarations in `.claude-plugin/types/`. Claude Code rewrites them whenever it loads the mod with `--plugin-dir`, so run it that way once after an update to refresh them.

## How it works

| Hook | What it does |
| --- | --- |
| `session.start` | Registers the command, opens the pane, and lists what the transcript already holds. |
| `command.run` | Opens the pane, and searches for the text given after the command. |
| `prompt.submit`, `prompt.mention`, `tool.call`, `session.compact` | Record one entry each, with its content. Subagent calls are left out: they fill their own window. |
| `session.measure` | Records the window's fill after each response. |
| `turn.complete` | Refreshes the breakdown by category. |
| `session.end` | Empties the lists on `/clear`. |
| `ui.render` on `AbovePrompt` | Draws the button. |
| `ui.render` on `Pane` | Draws the sidebar. |

Things to know before changing it:

- **Sizes are estimates** (characters / 4). Only the fill and the sparkline are real API figures.
- **Nothing recorded is dropped.** One drawing can hold only so much text (100,000 characters), so the timeline draws 200 rows at a time, an opened entry 8,000 characters at a time, and 8 entries stay open at once: opening a ninth closes the one opened first. Under a search the timeline draws 100 rows at a time, because a match may have a line of up to 100 characters under it. The Files and Prompts lists are drawn whole, so one of more than 100 rows is drawn without those lines: a search never makes a long list longer than it is without one.
- **The `j` and `k` keys turn the parts of one entry**: the one opened last among those long enough to have parts. The others are turned by their own `‹ Earlier` and `Later ›`.
- **A search runs on Enter, not as the person types.** `seek` reads every entry once and keeps what it found in `$.state` (`search`): the text, and for each entry that holds it either `''` (its title does) or the line of its content the text is on. The drawing only filters by that. A render hook cannot write state, and a body read while drawing would subscribe the pane to it.
- **What is searched** is what names an entry and what it put into the context. Its names (`namesOf`) are its title as a row would draw it with all the room, its `label` and `detail` in full, and for a file its path spelled with the forward slash it is drawn with, so that `src\auth.ts` and `src/auth.ts` both find it. Its content is what is drawn once it is opened: a tool call's input and result, a file's text. A file's input is left out: it is the path, which the title already is.
- **Content that was not kept is read back for a search, and not kept by it**: the transcript once per search for the calls made before the mod loaded, an instruction file from disk. In a resumed session every entry is one of those, so every search there reads the transcript. A call the transcript no longer holds (a compaction took it, or it is past what `$.session.messages` returns) can be searched by its title only: the search keeps the ids of those (`unread`), and the line that counts the matches says how many of the rows the tab lists they are.
- **A search does not go stale.** `add` tries each new entry against the search that is set, `keep` each instruction file loaded since, and `seek` ends by trying what was recorded or loaded while it read. What joins a search this way is kept beside it (`joined`), not in it: one more match then rewrites those few, not every match there is.
- **Of two searches under way at once, the one asked for last stands.** A module counter (`seeks`) tells each write of an older one, at the write itself, to leave things be; `/clear` counts as a newer one.
- **A search closes the open entries it hides.** Taking it away leaves the others open, so a match can be found, opened, and then read among its neighbours.
- **On the Files tab a search counts and opens a file by the reads that hold the text**, not by its latest read.
- **While the field has the focus every key goes to it**, so `1` to `4`, `j`, `k`, `u`, `d` and `s` do nothing until Tab or Esc leaves it. Esc hands the keyboard back to the prompt, and what was typed and not sent stays in the field until the next search or Clear.
- **The mobile app draws no field.** The pane draws there as it did before; a search is set by the command, and the line that counts the matches then names the text.
- **Content is kept per entry** in a `$.state` family (`bodies`), keyed by the entry's id. An entry from before the mod loaded has none, and is read back from the transcript when its row is opened.
- **Text is cleaned before it is drawn**: a tree with a control character in it is refused, so escape sequences and control characters are stripped.
- **A row's title is cut to the pane's width** in code, not by the surface, because a `Button` takes no `wrap`.
- **The button's `onPress` returns `toggle`'s promise**, so the press lasts until the pane is opened. Claude Code draws a pane the person asked for at any width (a sidebar from 110 columns, above the prompt under that), and one opened on the mod's own only from 144. An open made after the press has settled counts as the mod's own, and on a narrower terminal the click then shows nothing.
