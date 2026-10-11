import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useMemo, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import './App.css'

type TagField = { key: string; value: string }

type TrackInfo = {
  path: string
  file_name: string
  extension: string
  size_bytes: number
  created_epoch: number
  modified_epoch: number
  duration_seconds?: number
  bitrate_kbps?: number
  title?: string
  artist?: string
  album?: string
  genre?: string
  year?: string
  bpm?: string
  musical_key?: string
  tags: TagField[]
}

type ScanResult = {
  tracks: TrackInfo[]
  genres: string[]
  incoming_path: string
}

type MovePlan = {
  target_dir: string
  target_path: string
  rename_candidate: string
  conflict: boolean
}

type ReleaseMatch = {
  title: string
  artist: string
  year: string
  score: string
}

type MoveAction = {
  from_path: string
  to_path: string
}

type ActionEntry = {
  id: number
  label: string
  detail?: string
  trackPath?: string
  trackName?: string
  at: number
}

const SLOT_COUNT = 9

function formatDuration(seconds?: number) {
  if (!seconds || seconds < 0) return '-'
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function App() {
  const waveRef = useRef<HTMLDivElement | null>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [root, setRoot] = useState('')
  const [incomingName, setIncomingName] = useState('00 New')
  const [tracks, setTracks] = useState<TrackInfo[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [search, setSearch] = useState('')
  const [newGenreName, setNewGenreName] = useState('')
  const [sortMode, setSortMode] = useState<'name' | 'genre' | 'created' | 'modified'>('name')
  const [status, setStatus] = useState('Ready')
  const [isLoading, setIsLoading] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioReady, setAudioReady] = useState(false)
  const [undoStack, setUndoStack] = useState<MoveAction[]>([])
  const [actionLog, setActionLog] = useState<ActionEntry[]>([])
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const [releaseMatches, setReleaseMatches] = useState<ReleaseMatch[]>([])
  const [manualMoveYear, setManualMoveYear] = useState<string | undefined>()
  const [isLookingUpRelease, setIsLookingUpRelease] = useState(false)

  const filteredTracks = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = tracks.filter((track) => {
      if (!q) return true
      const hay = [
        track.file_name,
        track.title,
        track.artist,
        track.genre,
        track.album,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })

    return list.sort((a, b) => {
      if (sortMode === 'genre') {
        return (a.genre ?? '').localeCompare(b.genre ?? '') || a.file_name.localeCompare(b.file_name)
      }
      if (sortMode === 'created') return b.created_epoch - a.created_epoch || a.file_name.localeCompare(b.file_name)
      if (sortMode === 'modified') return b.modified_epoch - a.modified_epoch || a.file_name.localeCompare(b.file_name)
      return a.file_name.localeCompare(b.file_name)
    })
  }, [tracks, search, sortMode])

  const selectedTrack = filteredTracks[Math.min(selectedIndex, Math.max(filteredTracks.length - 1, 0))]
  const quickSlots = useMemo(
    () => [...genres].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).slice(0, SLOT_COUNT),
    [genres],
  )
  const recentActionByTrack = useMemo(() => {
    const byPath = new Map<string, ActionEntry>()
    for (const entry of actionLog) {
      if (!entry.trackPath) continue
      if (!byPath.has(entry.trackPath)) {
        byPath.set(entry.trackPath, entry)
      }
    }
    return byPath
  }, [actionLog])

  const selectedTrackBadge = selectedTrack ? recentActionByTrack.get(selectedTrack.path) : undefined
  const tagYear = selectedTrack?.year && /^\d{4}$/.test(selectedTrack.year) ? selectedTrack.year : undefined
  const moveYear = tagYear || (manualMoveYear && /^\d{4}$/.test(manualMoveYear) ? manualMoveYear : undefined)

  const appendAction = (entry: Omit<ActionEntry, 'id' | 'at'>) => {
    setActionLog((current) => [{ ...entry, id: Date.now() + Math.random(), at: Date.now() }, ...current].slice(0, 80))
  }

  const showToast = (message: string) => {
    setToast({ id: Date.now() + Math.random(), message })
  }

  const fileNameFromPath = (path: string) => path.split('/').pop() || path

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4800)
    return () => window.clearTimeout(timer)
  }, [toast?.id])

  useEffect(() => {
    const load = async () => {
      try {
        setIsLoading(true)
        const detected = await invoke<{ root: string; incoming_dir_name: string }>('detect_library_root')
        setRoot(detected.root)
        setIncomingName(detected.incoming_dir_name)
        await refresh(detected.root)
      } catch (error) {
        setStatus(String(error))
      } finally {
        setIsLoading(false)
      }
    }
    void load()
  }, [])

  useEffect(() => {
    if (!waveRef.current || !selectedTrack) {
      wsRef.current?.destroy()
      wsRef.current = null
      setAudioReady(false)
      return
    }

    const src = convertFileSrc(selectedTrack.path)
    setAudioReady(false)
    setStatus(`Loading audio: ${selectedTrack.file_name}`)

    const ws = WaveSurfer.create({
      container: waveRef.current,
      height: 124,
      waveColor: '#84a59d',
      progressColor: '#f28482',
      cursorColor: '#2f3e46',
      url: src,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      barRadius: 3,
    })

    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))
    ws.on('finish', () => setIsPlaying(false))
    ws.on('ready', () => {
      setAudioReady(true)
      setStatus(`Loaded: ${selectedTrack.file_name} (autoplay)`)
      void Promise.resolve(ws.play()).catch((error) => {
        setStatus(`Loaded: ${selectedTrack.file_name}. Autoplay blocked: ${String(error)}`)
      })
    })
    ws.on('error', (message) => {
      setAudioReady(false)
      setStatus(
        `Playback failed for ${selectedTrack.file_name}. Check tauri asset protocol scope and file format. ${String(message)}`,
      )
    })

    wsRef.current = ws
    setIsPlaying(false)

    return () => {
      ws.destroy()
      wsRef.current = null
      setAudioReady(false)
    }
  }, [selectedTrack?.path])

  useEffect(() => {
    setReleaseMatches([])
    setManualMoveYear(undefined)
  }, [selectedTrack?.path])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      if (event.key === ' ') {
        event.preventDefault()
        wsRef.current?.playPause()
      }

      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setSelectedIndex((idx) => Math.min(idx + 1, Math.max(filteredTracks.length - 1, 0)))
      }

      if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setSelectedIndex((idx) => Math.max(idx - 1, 0))
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        const genre = quickSlots[0]
        if (genre) {
          void moveSelected(genre)
        }
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        void deleteSelected()
      }

      const parsed = Number(event.key)
      if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 9) {
        event.preventDefault()
        const genre = quickSlots[parsed - 1]
        if (genre) {
          void moveSelected(genre)
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void undoLastMove()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [filteredTracks.length, quickSlots, selectedTrack, undoStack, moveYear])

  const refresh = async (rootPath = root) => {
    const result = await invoke<ScanResult>('scan_library', { request: { root: rootPath } })
    setTracks(result.tracks)
    setGenres(result.genres)
    setSelectedIndex(0)
    setStatus(`Loaded ${result.tracks.length} tracks from ${result.incoming_path}`)
  }

  const moveSelected = async (targetGenre: string) => {
    if (!selectedTrack) return
    const genre = targetGenre.trim()
    if (!genre) {
      setStatus('Choose a target genre first.')
      return
    }
    if (!moveYear) {
      setStatus('A four-digit move year is required to move this track.')
      return
    }

    try {
      if (!genres.some((entry) => entry.toLowerCase() === genre.toLowerCase())) {
        setStatus(`Genre does not exist: ${genre}. Use Create Genre first.`)
        return
      }

      const plan = await invoke<MovePlan>('plan_move', {
        request: {
          root,
          source_path: selectedTrack.path,
          target_genre: genre,
          year: moveYear,
        },
      })

      let decision: 'skip' | 'overwrite' | 'rename' | undefined
      if (plan.conflict) {
        const answer = window.prompt(
          `Konflikt fuer ${selectedTrack.file_name}\n[s]kip | [r]ename | [o]verwrite`,
          'r',
        )
        const normalized = (answer ?? 's').trim().toLowerCase()
        if (normalized.startsWith('o')) decision = 'overwrite'
        else if (normalized.startsWith('r')) decision = 'rename'
        else decision = 'skip'
      }

      const result = await invoke<{ status: string; moved_to?: string }>('execute_move', {
        request: {
          source_path: selectedTrack.path,
          target_path: plan.target_path,
          rename_candidate: plan.rename_candidate,
          conflict: plan.conflict,
          decision,
        },
      })

      if (result.status === 'skipped') {
        appendAction({
          label: 'Skipped',
          trackPath: selectedTrack.path,
          trackName: selectedTrack.file_name,
        })
        showToast(`Skipped: ${selectedTrack.file_name}`)
        setStatus(`Skipped: ${selectedTrack.file_name}`)
        return
      }

      if (result.moved_to) {
        const movedTo = result.moved_to
        setUndoStack((stack) => [{ from_path: movedTo, to_path: selectedTrack.path }, ...stack].slice(0, 100))
      }

      appendAction({
        label: 'Moved to Genre',
        detail: genre,
        trackPath: selectedTrack.path,
        trackName: selectedTrack.file_name,
      })
      showToast(`Moved: ${selectedTrack.file_name} -> ${genre}`)
      setTracks((current) => current.filter((track) => track.path !== selectedTrack.path))
      setStatus(`Moved: ${selectedTrack.file_name} -> ${genre}`)
    } catch (error) {
      setStatus(String(error))
    }
  }

  const lookupReleaseYear = async () => {
    if (!selectedTrack) return
    try {
      setIsLookingUpRelease(true)
      setReleaseMatches([])
      const matches = await invoke<ReleaseMatch[]>('lookup_release_year', {
        request: { artist: selectedTrack.artist || '', title: selectedTrack.title || '' },
      })
      setReleaseMatches(matches)
      if (!matches.length) {
        const query = `${selectedTrack.artist || 'Unknown artist'} - ${selectedTrack.title || selectedTrack.file_name} release year`
        await openUrl(`https://www.google.com/search?q=${encodeURIComponent(query)}`)
      }
      setStatus(matches.length ? `Found ${matches.length} MusicBrainz matches. Choose one.` : 'No dated MusicBrainz matches found. Opened Google search.')
    } catch (error) {
      setStatus(`Release lookup failed: ${String(error)}`)
    } finally {
      setIsLookingUpRelease(false)
    }
  }

  const undoLastMove = async () => {
    const [last, ...rest] = undoStack
    if (!last) {
      setStatus('Nothing to undo.')
      return
    }
    try {
      const restoredName = fileNameFromPath(last.to_path)
      await invoke('undo_move', { request: last })
      setUndoStack(rest)
      await refresh()
      appendAction({
        label: 'Undone',
        detail: 'restored to incoming',
        trackPath: last.to_path,
        trackName: restoredName,
      })
      showToast(`Undo: ${restoredName}`)
      setStatus('Last move undone.')
    } catch (error) {
      setStatus(String(error))
    }
  }

  const deleteSelected = async () => {
    if (!selectedTrack) return

    try {
      wsRef.current?.pause()
      wsRef.current?.destroy()
      wsRef.current = null
      setIsPlaying(false)
      setAudioReady(false)

      const dotIndex = selectedTrack.file_name.lastIndexOf('.')
      const uniqueName =
        dotIndex > 0
          ? `${selectedTrack.file_name.slice(0, dotIndex)} (${Date.now()})${selectedTrack.file_name.slice(dotIndex)}`
          : `${selectedTrack.file_name} (${Date.now()})`
      const trashTarget = `${root}/_BACKUP_ORGANIZE/_TRASH/${uniqueName}`

      showToast(`Moving to trash: ${selectedTrack.file_name}`)
      const result = await invoke<{ status: string; moved_to?: string }>('execute_move', {
        request: {
          source_path: selectedTrack.path,
          target_path: trashTarget,
          rename_candidate: trashTarget,
          conflict: false,
        },
      })

      if (result.status !== 'moved') {
        throw new Error(`Trash move returned: ${result.status}`)
      }
      const movedTo = result.moved_to
      if (movedTo) {
        setUndoStack((stack) => [{ from_path: movedTo, to_path: selectedTrack.path }, ...stack].slice(0, 100))
      }

      appendAction({
        label: 'Moved to Trash',
        detail: result.moved_to || 'via delete action',
        trackPath: selectedTrack.path,
        trackName: selectedTrack.file_name,
      })
      showToast(`Moved to trash: ${selectedTrack.file_name}`)
      setTracks((current) => current.filter((track) => track.path !== selectedTrack.path))
      setStatus(`Moved to trash: ${selectedTrack.file_name}`)
    } catch (error) {
      const message = `Delete failed: ${String(error)}`
      showToast(message)
      setStatus(message)
    }
  }

  const createGenreFromInput = async () => {
    const genre = newGenreName.trim()
    if (!genre) {
      setStatus('Type a new genre name first.')
      return
    }

    if (genres.some((entry) => entry.toLowerCase() === genre.toLowerCase())) {
      setStatus(`Genre already exists: ${genre}`)
      return
    }

    try {
      await invoke('create_genre', { request: { root, genre } })
      setGenres((current) => [...current, genre].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })))
      appendAction({ label: 'Genre created', detail: genre })
      showToast(`Created genre: ${genre}`)
      setNewGenreName('')
      setStatus(`Created genre: ${genre}`)
    } catch (error) {
      setStatus(String(error))
    }
  }

  const exportXml = async () => {
    try {
      const outputPath = `${root}/rekordbox.xml`
      const result = await invoke<{ folder_count: number; playlist_count: number; track_count: number; output_path: string }>(
        'export_rekordbox_xml',
        {
          request: { root, output_path: outputPath },
        },
      )
      setStatus(
        `XML exported: ${result.output_path} (${result.folder_count} folders, ${result.playlist_count} playlists, ${result.track_count} tracks)`,
      )
    } catch (error) {
      setStatus(String(error))
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Genre Sorter</h1>
          <p>
            Root: <code>{root || '...'}</code> | Source: <code>{incomingName}</code>
          </p>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => void refresh()} disabled={isLoading}>
            Rescan
          </button>
          <button type="button" onClick={() => void exportXml()}>
            Export Rekordbox XML
          </button>
        </div>
      </header>

      <section className="grid">
        <aside className="panel list-panel">
          <div className="row">
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setSelectedIndex(0)
              }}
              placeholder="Filter tracks (name/tag)"
            />
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}>
              <option value="name">Sort: Name</option>
              <option value="genre">Sort: Genre</option>
              <option value="created">Sort: Created (newest)</option>
              <option value="modified">Sort: Modified (newest)</option>
            </select>
          </div>
          <div className="count">Queue: {filteredTracks.length}</div>
          <ul className="track-list">
            {filteredTracks.map((track, idx) => (
              <li
                key={track.path}
                className={idx === selectedIndex ? 'selected' : ''}
                onClick={() => setSelectedIndex(idx)}
              >
                <div className="track-main">
                  <strong>{track.title || track.file_name}</strong>
                  {recentActionByTrack.get(track.path) && (
                    <span className="action-badge">{recentActionByTrack.get(track.path)?.label}</span>
                  )}
                </div>
                <span>{track.artist || 'Unknown Artist'}</span>
                <span>{track.genre || '-'} · {formatDuration(track.duration_seconds)} · {track.bitrate_kbps ? `${track.bitrate_kbps} kbps` : '-'}</span>
              </li>
            ))}
          </ul>
        </aside>

        <section className="panel player-panel">
          <div className="track-header">
            <h2>
              {selectedTrack ? selectedTrack.file_name : 'No track selected'}
              {selectedTrackBadge && <span className="action-badge">{selectedTrackBadge.label}</span>}
            </h2>
            <p>Hotkeys: Space play, N/P nav, 1-9 quick move, Enter move to slot 1, Del trash, Cmd/Ctrl+Z undo</p>
          </div>
          <div ref={waveRef} className="wave" />
          <div className="player-actions">
            <button type="button" onClick={() => wsRef.current?.playPause()} disabled={!selectedTrack || !audioReady}>
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button type="button" onClick={() => setSelectedIndex((idx) => Math.max(idx - 1, 0))}>
              Prev (P)
            </button>
            <button
              type="button"
              onClick={() => setSelectedIndex((idx) => Math.min(idx + 1, Math.max(filteredTracks.length - 1, 0)))}
            >
              Next (N)
            </button>
          </div>

          <div className="move-box">
            <h3>Quick Move</h3>
            <div className="move-actions">
              <button type="button" onClick={() => void undoLastMove()}>
                Undo (Cmd/Ctrl+Z)
              </button>
              <button type="button" onClick={() => void deleteSelected()} disabled={!selectedTrack}>
                Trash (Del)
              </button>
            </div>
            <div className="slot-help">Press 1-9 to move to that genre slot, or click a slot.</div>
            <div className="slot-grid">
              {Array.from({ length: SLOT_COUNT }, (_, idx) => quickSlots[idx] ?? '').map((slot, idx) => (
                <button
                  key={`slot-${idx}`}
                  type="button"
                  className="slot-pill"
                  onClick={() => void moveSelected(slot)}
                  disabled={!slot || !selectedTrack || !moveYear}
                >
                  <span className="slot-key">{idx + 1}</span>
                  <span>{slot || 'Unassigned'}</span>
                </button>
              ))}
            </div>
            <div className="new-genre-box">
              <h4>Add New Genre</h4>
              <div className="new-genre-row">
                <input
                  value={newGenreName}
                  onChange={(event) => setNewGenreName(event.target.value)}
                  placeholder="Type new genre name"
                />
                <button type="button" onClick={() => void createGenreFromInput()} disabled={!newGenreName.trim()}>
                  Create
                </button>
              </div>
            </div>
            <div className="changelog-box">
              <h4>Recent Actions</h4>
              {actionLog.length === 0 && <p className="changelog-empty">No actions yet.</p>}
              {actionLog.length > 0 && (
                <ul className="changelog-list">
                  {actionLog.slice(0, 8).map((entry) => (
                    <li key={entry.id}>
                      <span className="log-label">{entry.label}</span>
                      <span className="log-main">
                        {entry.trackName && entry.detail
                          ? `${entry.trackName} (${entry.detail})`
                          : entry.trackName || entry.detail || '-'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        <aside className="panel meta-panel">
          <h3>Metadata</h3>
          {!selectedTrack && <p>No track selected.</p>}
          {selectedTrack && (
            <>
              <div className="meta-grid">
                <div>Title</div>
                <div>{selectedTrack.title || '-'}</div>
                <div>Artist</div>
                <div>{selectedTrack.artist || '-'}</div>
                <div>Album</div>
                <div>{selectedTrack.album || '-'}</div>
                <div>Genre</div>
                <div>{selectedTrack.genre || '-'}</div>
                <div>BPM</div>
                <div>{selectedTrack.bpm || '-'}</div>
                <div>Key</div>
                <div>{selectedTrack.musical_key || '-'}</div>
                <div>Length</div>
                <div>{formatDuration(selectedTrack.duration_seconds)}</div>
                <div>Bitrate</div>
                <div>{selectedTrack.bitrate_kbps ? `${selectedTrack.bitrate_kbps} kbps` : '-'}</div>
                <div>Tag Year</div>
                <div>{selectedTrack.year || '-'}</div>
                <div>Move Year</div>
                {tagYear ? (
                  <div>{tagYear} (tag)</div>
                ) : (
                  <input
                    aria-label="Move year"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="YYYY"
                    value={manualMoveYear ?? ''}
                    onChange={(event) => {
                      const year = event.target.value
                      if (/^\d{0,4}$/.test(year)) setManualMoveYear(year || undefined)
                    }}
                  />
                )}
                <div>File</div>
                <div>{selectedTrack.path}</div>
              </div>
              {!tagYear && (
                <div className="release-lookup">
                  <button type="button" onClick={() => void lookupReleaseYear()} disabled={isLookingUpRelease}>
                    {isLookingUpRelease ? 'Looking up…' : 'Find Release Year'}
                  </button>
                  {releaseMatches.map((match) => (
                    <button
                      key={`${match.year}-${match.artist}-${match.title}`}
                      type="button"
                      onClick={() => setManualMoveYear(match.year)}
                    >
                      {match.year} — {match.artist || 'Unknown artist'} — {match.title} {match.score && `(${match.score}%)`}
                    </button>
                  ))}
                </div>
              )}
              <h4>All Tag Fields ({selectedTrack.tags.length})</h4>
              <ul className="tag-list">
                {selectedTrack.tags.map((tag) => (
                  <li key={`${tag.key}-${tag.value}`}>
                    <strong>{tag.key}</strong>: {tag.value}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </section>
      <footer className="status">{status}</footer>
      {toast && <div className="toast">{toast.message}</div>}
    </main>
  )
}

export default App
