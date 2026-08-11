# Genre Sorter

Keyboard-first Tauri app to sort tracks from `00 New`/`00_NEW_IN` into `Genre/Year` folders.

## Features (MVP)

- Waveform preview with manual play/pause (`Space`)
- Queue from incoming folder with sorting/filtering
- Metadata panel (core fields + all discovered tag items)
- Genre target via fuzzy search + genre tag suggestion
- Move directly into `Genre/Year` where `Year` comes from filesystem timestamp
- Conflict handling per track: skip / rename / overwrite
- Quick genre slots (`1`-`9`) and undo (`Cmd/Ctrl+Z`)
- Optional Rekordbox XML export button

## Start

```bash
npm install
npm run tauri dev
```

If the app does not start, verify your Rust toolchain is recent enough for the current Tauri dependency graph.

## Hotkeys

- `Space`: play/pause selected track
- `N` / `P`: next/previous track
- `Enter`: move selected track into current target genre
- `1..9`: move selected track into assigned slot genre
- `Cmd/Ctrl+Z`: undo last move

## Notes

- Existing top-level folder structure is preserved.
- New genres can be created from the move flow.
- XML export writes to `<library_root>/rekordbox.xml`.
