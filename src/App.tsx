import { convertFileSrc, invoke } from '@tauri-apps/api/core'
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

type MoveAction = {
  from_path: string
  to_path: string
}

const SLOT_COUNT = 9

function App() {
  const waveRef = useRef<HTMLDivElement | null>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [root, setRoot] = useState('')
  const [incomingName, setIncomingName] = useState('00 New')
  const [tracks, setTracks] = useState<TrackInfo[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [search, setSearch] = useState('')
  const [targetQuery, setTargetQuery] = useState('')
  const [sortMode, setSortMode] = useState<'name' | 'genre'>('name')
  const [status, setStatus] = useState('Ready')
  const [isLoading, setIsLoading] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [slots, setSlots] = useState<string[]>(() => {
    const stored = localStorage.getItem('genre-slots')
    if (!stored) return Array.from({ length: SLOT_COUNT }, () => '')
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return Array.from({ length: SLOT_COUNT }, () => '')
      return Array.from({ length: SLOT_COUNT }, (_, idx) => parsed[idx] ?? '')
    } catch {
      return Array.from({ length: SLOT_COUNT }, () => '')
    }
  })
  const [undoStack, setUndoStack] = useState<MoveAction[]>([])

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
      return a.file_name.localeCompare(b.file_name)
    })
  }, [tracks, search, sortMode])

  const selectedTrack = filteredTracks[Math.min(selectedIndex, Math.max(filteredTracks.length - 1, 0))]

  const suggestedGenres = useMemo(() => {
    const suggestions: string[] = []
    const tagGenre = selectedTrack?.genre?.trim()
    if (tagGenre && genres.some((genre) => genre.toLowerCase() === tagGenre.toLowerCase())) {
      suggestions.push(genres.find((genre) => genre.toLowerCase() === tagGenre.toLowerCase()) ?? tagGenre)
    }
    const q = targetQuery.trim().toLowerCase()
    const fuzzy = genres
      .filter((genre) => {
        if (!q) return true
        const lower = genre.toLowerCase()
        return lower.includes(q) || lower.startsWith(q)
      })
      .slice(0, 12)
    for (const genre of fuzzy) {
      if (!suggestions.includes(genre)) suggestions.push(genre)
    }
    return suggestions
  }, [genres, targetQuery, selectedTrack])

  useEffect(() => {
    localStorage.setItem('genre-slots', JSON.stringify(slots))
  }, [slots])

  useEffect(() => {
    if (genres.length === 0) return
    if (slots.some((slot) => slot.trim() !== '')) return
    setSlots((current) =>
      current.map((slot, idx) => {
        if (slot) return slot
        return genres[idx] ?? ''
      }),
    )
  }, [genres])

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
      return
    }

    const src = convertFileSrc(selectedTrack.path)
    const ws = WaveSurfer.create({
      container: waveRef.current,
      height: 116,
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

    wsRef.current = ws
    setIsPlaying(false)
    setStatus(`Loaded: ${selectedTrack.file_name}`)

    return () => {
      ws.destroy()
      wsRef.current = null
    }
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
        void moveSelected(resolveTargetGenre())
      }

      const parsed = Number(event.key)
      if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 9) {
        event.preventDefault()
        const genre = slots[parsed - 1]
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
  }, [filteredTracks.length, slots, selectedTrack, targetQuery, genres, undoStack])

  const refresh = async (rootPath = root) => {
    const result = await invoke<ScanResult>('scan_library', { request: { root: rootPath } })
    setTracks(result.tracks)
    setGenres(result.genres)
    setSelectedIndex(0)
    setStatus(`Loaded ${result.tracks.length} tracks from ${result.incoming_path}`)
  }

  const resolveTargetGenre = () => {
    const q = targetQuery.trim()
    if (!q) return suggestedGenres[0] ?? ''
    const exact = genres.find((genre) => genre.toLowerCase() === q.toLowerCase())
    if (exact) return exact
    const fuzzy = genres.find((genre) => genre.toLowerCase().includes(q.toLowerCase()))
    return fuzzy ?? q
  }

  const moveSelected = async (targetGenre: string) => {
    if (!selectedTrack) return
    const genre = targetGenre.trim()
    if (!genre) {
      setStatus('Choose a target genre first.')
      return
    }

    try {
      if (!genres.some((entry) => entry.toLowerCase() === genre.toLowerCase())) {
        const shouldCreate = window.confirm(`Genre "${genre}" existiert nicht. Neu anlegen?`)
        if (!shouldCreate) return
        await invoke('create_genre', { request: { root, genre } })
      }

      const plan = await invoke<MovePlan>('plan_move', {
        request: { root, source_path: selectedTrack.path, target_genre: genre },
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
        setStatus(`Skipped: ${selectedTrack.file_name}`)
        return
      }

      if (result.moved_to) {
        const movedTo = result.moved_to
        setUndoStack((stack) => [{ from_path: movedTo, to_path: selectedTrack.path }, ...stack].slice(0, 100))
      }

      setTracks((current) => current.filter((track) => track.path !== selectedTrack.path))
      setStatus(`Moved: ${selectedTrack.file_name} -> ${genre}`)
    } catch (error) {
      setStatus(String(error))
    }
  }

  const undoLastMove = async () => {
    const [last, ...rest] = undoStack
    if (!last) {
      setStatus('Nothing to undo.')
      return
    }
    try {
      await invoke('undo_move', { request: last })
      setUndoStack(rest)
      await refresh()
      setStatus('Last move undone.')
    } catch (error) {
      setStatus(String(error))
    }
  }

  const assignSlot = (slotIndex: number) => {
    const genre = resolveTargetGenre()
    if (!genre) return
    setSlots((current) => {
      const next = [...current]
      next[slotIndex] = genre
      return next
    })
    setStatus(`Assigned slot ${slotIndex + 1}: ${genre}`)
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
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as 'name' | 'genre')}>
              <option value="name">Sort: Name</option>
              <option value="genre">Sort: Genre</option>
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
                <strong>{track.title || track.file_name}</strong>
                <span>{track.artist || 'Unknown Artist'}</span>
                <span>{track.genre || '-'}</span>
              </li>
            ))}
          </ul>
        </aside>

        <section className="panel player-panel">
          <div className="track-header">
            <h2>{selectedTrack ? selectedTrack.file_name : 'No track selected'}</h2>
            <p>Hotkeys: Space play, N/P nav, Enter move, 1-9 slot move</p>
          </div>
          <div ref={waveRef} className="wave" />
          <div className="player-actions">
            <button type="button" onClick={() => wsRef.current?.playPause()} disabled={!selectedTrack}>
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
            <h3>Target Genre</h3>
            <input
              value={targetQuery}
              onChange={(event) => setTargetQuery(event.target.value)}
              placeholder="Type genre, fuzzy match enabled"
            />
            <div className="chips">
              {suggestedGenres.slice(0, 8).map((genre) => (
                <button key={genre} type="button" onClick={() => setTargetQuery(genre)}>
                  {genre}
                </button>
              ))}
            </div>
            <div className="move-actions">
              <button type="button" onClick={() => void moveSelected(resolveTargetGenre())} disabled={!selectedTrack}>
                Move (Enter)
              </button>
              <button type="button" onClick={() => void undoLastMove()}>
                Undo (Cmd/Ctrl+Z)
              </button>
            </div>
            <div className="slots">
              {slots.map((slot, idx) => (
                <div key={`slot-${idx}`} className="slot">
                  <button type="button" onClick={() => void moveSelected(slot)} disabled={!slot || !selectedTrack}>
                    {idx + 1}: {slot || 'Empty'}
                  </button>
                  <button type="button" onClick={() => assignSlot(idx)}>
                    Set
                  </button>
                </div>
              ))}
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
                <div>Tag Year</div>
                <div>{selectedTrack.year || '-'}</div>
                <div>File</div>
                <div>{selectedTrack.path}</div>
              </div>
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
    </main>
  )
}

export default App
