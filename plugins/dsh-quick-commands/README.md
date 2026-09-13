# dsh-quick-commands

Reusable prompt shortcuts for the DeepSeek Harness composer.

A lightning button sits in the composer tool row. It opens a panel that lists
your quick commands (pinned first); clicking one **appends** it to the input.
You can add the current draft as a command, edit, delete, pin/unpin, drag to
reorder (within the pinned / plain regions), and import/export a JSON file.

The inline `/` filter (↑↓ select · Enter insert · Esc close) is **disabled**.
The Harness slash pipeline only binds `/` and `@`, so the built-in 命令 palette
opens on any `/`-leading draft; a plugin overlay on that same keystroke covered
the palette. The composer button is the entry point. Flip
`SLASH_FILTER_ENABLED` in `src/client.tsx` to `true` to bring the filter back.

## Shared store

Commands are persisted to the **same file** the sibling "Pchat 助手"
(codex-desktop) app uses, so an edit in either app shows up in the other:

```
<appData>/codex-desktop/codex/quick_commands.json
```

The path is resolved through codex-desktop's own `data-location.json` pointer,
so if you relocate that app's data directory, the sharing follows. Set
`DSH_QUICK_COMMANDS_FILE` (absolute path) to override. File shape:

```json
{ "version": 1, "commands": [{ "id": "qc_…", "text": "…", "pinned": true }] }
```

Every mutation re-reads the file, applies the change, and writes atomically
(temp + rename) on a serial queue, so the two apps never clobber each other's
table wholesale.

## Layout

- `src/index.mjs` — Host half: the store + an HTTP route at `/dsh-quick-commands`.
- `src/quick-commands-core.mjs` — pure domain logic (seed / pin / reorder / import).
- `src/shared-path.mjs` — resolves the shared file via the data-location pointer.
- `src/client.tsx` — Browser half: the composer button and panel (inline `/` filter off by default).

## License

MIT
