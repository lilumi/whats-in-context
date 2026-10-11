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

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest. |
| `.claude-plugin/marketplace.json` | Makes this folder a marketplace of one plugin, so it can be installed from here. |
| `hooks/hooks.json` | Names the hooks module. |
| `hooks/register.tsx` | The mod: every hook and the two drawings. |
| `types/index.d.ts` | The contract for the values kept in `$.state`. |
| `tests/pane.test.ts` | Tests, run against the engine. |
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
| `prompt.submit`, `prompt.mention`, `tool.call`, `session.compact` | Record one entry each, with its content. Subagent calls are left out: they fill their own window. |
| `session.measure` | Records the window's fill after each response. |
| `turn.complete` | Refreshes the breakdown by category. |
| `session.end` | Empties the lists on `/clear`. |
| `ui.render` on `AbovePrompt` | Draws the button. |
| `ui.render` on `Pane` | Draws the sidebar. |

Things to know before changing it:

- **Sizes are estimates** (characters / 4). Only the fill and the sparkline are real API figures.
- **Nothing recorded is dropped.** One drawing can hold only so much text (100,000 characters), so the timeline draws 200 rows at a time, an opened entry 8,000 characters at a time, and 8 entries stay open at once: opening a ninth closes the one opened first.
- **The `j` and `k` keys turn the parts of one entry**: the one opened last among those long enough to have parts. The others are turned by their own `‹ Earlier` and `Later ›`.
- **Content is kept per entry** in a `$.state` family (`bodies`), keyed by the entry's id. An entry from before the mod loaded has none, and is read back from the transcript when its row is opened.
- **Text is cleaned before it is drawn**: a tree with a control character in it is refused, so escape sequences and control characters are stripped.
- **A row's title is cut to the pane's width** in code, not by the surface, because a `Button` takes no `wrap`.
- **The button's `onPress` returns `toggle`'s promise**, so the press lasts until the pane is opened. Claude Code draws a pane the person asked for at any width (a sidebar from 110 columns, above the prompt under that), and one opened on the mod's own only from 144. An open made after the press has settled counts as the mod's own, and on a narrower terminal the click then shows nothing.
