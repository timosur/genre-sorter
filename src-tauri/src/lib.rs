use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::{Accessor, ItemKey};
use lofty::probe::Probe;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use chrono::{Datelike, Local, TimeZone};

const INCOMING_CANDIDATES: [&str; 2] = ["00 New", "00_NEW_IN"];
const SKIP_TOP_LEVEL: [&str; 6] = ["00 New", "00_NEW_IN", "01 App", "_REKORDBOX_M3U", "_BACKUP_ORGANIZE", "genre-sorter"];
const MEDIA_EXTENSIONS: [&str; 6] = ["mp3", "m4a", "wav", "aiff", "flac", "ogg"];

#[derive(Serialize)]
struct LibraryRoot {
    root: String,
    incoming_dir_name: String,
}

#[derive(Serialize)]
struct TagField {
    key: String,
    value: String,
}

#[derive(Serialize)]
struct TrackInfo {
    path: String,
    file_name: String,
    extension: String,
    size_bytes: u64,
    created_epoch: i64,
    modified_epoch: i64,
    duration_seconds: Option<f64>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<String>,
    bpm: Option<String>,
    musical_key: Option<String>,
    tags: Vec<TagField>,
}

#[derive(Serialize)]
struct ScanResult {
    tracks: Vec<TrackInfo>,
    genres: Vec<String>,
    incoming_path: String,
}

#[derive(Deserialize)]
struct ScanRequest {
    root: String,
}

#[derive(Deserialize)]
struct GenreRequest {
    root: String,
    genre: String,
}

#[derive(Deserialize)]
struct MovePlanRequest {
    root: String,
    source_path: String,
    target_genre: String,
}

#[derive(Serialize)]
struct MovePlan {
    target_dir: String,
    target_path: String,
    rename_candidate: String,
    conflict: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ConflictDecision {
    Skip,
    Overwrite,
    Rename,
}

#[derive(Deserialize)]
struct ExecuteMoveRequest {
    source_path: String,
    target_path: String,
    rename_candidate: String,
    conflict: bool,
    decision: Option<ConflictDecision>,
}

#[derive(Serialize)]
struct MoveResult {
    status: String,
    moved_to: Option<String>,
}

#[derive(Deserialize)]
struct UndoMoveRequest {
    from_path: String,
    to_path: String,
}

#[derive(Deserialize)]
struct DeleteTrackRequest {
    root: String,
    path: String,
}

#[derive(Serialize)]
struct DeleteTrackResult {
    status: String,
    moved_to: Option<String>,
}

#[derive(Deserialize)]
struct ExportXmlRequest {
    root: String,
    output_path: String,
}

#[derive(Serialize)]
struct ExportXmlResult {
    folder_count: usize,
    playlist_count: usize,
    track_count: usize,
    output_path: String,
}

#[tauri::command]
fn detect_library_root() -> Result<LibraryRoot, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut candidates = vec![cwd.clone()];
    if let Some(parent) = cwd.parent() {
        candidates.push(parent.to_path_buf());
    }
    if let Some(parent) = cwd.parent().and_then(|p| p.parent()) {
        candidates.push(parent.to_path_buf());
    }

    for candidate in candidates {
        if let Some(incoming_dir) = INCOMING_CANDIDATES
            .iter()
            .map(|d| candidate.join(d))
            .find(|p| p.is_dir())
        {
            return Ok(LibraryRoot {
                root: candidate.to_string_lossy().to_string(),
                incoming_dir_name: incoming_dir
                    .file_name()
                    .map(|v| v.to_string_lossy().to_string())
                    .unwrap_or_else(|| "00 New".to_string()),
            });
        }
    }

    Err("No library root detected. Place the app inside your music library or choose a valid root.".to_string())
}

#[tauri::command]
fn scan_library(request: ScanRequest) -> Result<ScanResult, String> {
    let root = PathBuf::from(&request.root);
    let incoming_path = find_incoming_dir(&root)?;

    let tracks = WalkDir::new(&incoming_path)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| is_supported_media(entry.path()))
        .map(|entry| track_info_from_path(entry.path()))
        .collect::<Vec<_>>();

    let mut genres = discover_genres(&root)?;
    genres.sort();

    Ok(ScanResult {
        tracks,
        genres,
        incoming_path: incoming_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn create_genre(request: GenreRequest) -> Result<String, String> {
    let genre_name = request.genre.trim();
    if genre_name.is_empty() {
        return Err("Genre name cannot be empty.".to_string());
    }
    let path = PathBuf::from(request.root).join(genre_name);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn plan_move(request: MovePlanRequest) -> Result<MovePlan, String> {
    let source_path = PathBuf::from(&request.source_path);
    if !source_path.is_file() {
        return Err("Source file no longer exists.".to_string());
    }

    let target_genre = request.target_genre.trim();
    if target_genre.is_empty() {
        return Err("Choose a target genre first.".to_string());
    }

    let year = file_year(&source_path)?;
    let file_name = source_path
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid source file name.".to_string())?;

    let target_dir = PathBuf::from(&request.root).join(target_genre).join(year);
    let target_path = target_dir.join(file_name);
    let rename_candidate = unique_candidate(&target_path);
    let conflict = target_path.exists() && source_path != target_path;

    Ok(MovePlan {
        target_dir: target_dir.to_string_lossy().to_string(),
        target_path: target_path.to_string_lossy().to_string(),
        rename_candidate: rename_candidate.to_string_lossy().to_string(),
        conflict,
    })
}

#[tauri::command]
fn execute_move(request: ExecuteMoveRequest) -> Result<MoveResult, String> {
    let source_path = PathBuf::from(&request.source_path);
    if !source_path.exists() {
        return Err("Source file no longer exists.".to_string());
    }

    let mut final_target = PathBuf::from(&request.target_path);
    if request.conflict {
        match request.decision {
            Some(ConflictDecision::Skip) => {
                return Ok(MoveResult {
                    status: "skipped".to_string(),
                    moved_to: None,
                })
            }
            Some(ConflictDecision::Overwrite) => {
                if final_target.exists() {
                    fs::remove_file(&final_target).map_err(|e| e.to_string())?;
                }
            }
            Some(ConflictDecision::Rename) => {
                final_target = PathBuf::from(&request.rename_candidate);
            }
            None => return Err("Conflict decision is required.".to_string()),
        }
    }

    if let Some(parent) = final_target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::rename(&source_path, &final_target).map_err(|e| e.to_string())?;
    Ok(MoveResult {
        status: "moved".to_string(),
        moved_to: Some(final_target.to_string_lossy().to_string()),
    })
}

#[tauri::command]
fn undo_move(request: UndoMoveRequest) -> Result<(), String> {
    let from = PathBuf::from(&request.from_path);
    let to = PathBuf::from(&request.to_path);
    if !from.exists() {
        return Err("Undo source does not exist anymore.".to_string());
    }
    if to.exists() {
        return Err("Original path already exists. Undo aborted.".to_string());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_track(request: DeleteTrackRequest) -> Result<DeleteTrackResult, String> {
    let root = PathBuf::from(&request.root);
    let path = PathBuf::from(&request.path);
    if !path.exists() {
        return Err("File no longer exists.".to_string());
    }
    if !path.is_file() {
        return Err("Path is not a file.".to_string());
    }

    let mut last_error = String::new();
    for attempt in 0..6 {
        match fs::remove_file(&path) {
            Ok(_) => {
                return Ok(DeleteTrackResult {
                    status: "deleted".to_string(),
                    moved_to: None,
                })
            }
            Err(err) => {
                last_error = err.to_string();
                if err.kind() != ErrorKind::PermissionDenied && err.kind() != ErrorKind::Other {
                    break;
                }

                if attempt < 5 {
                    thread::sleep(std::time::Duration::from_millis(120));
                }
            }
        }
    }

    let trash_dir = root.join("_BACKUP_ORGANIZE").join("_TRASH");
    fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Invalid file name for delete operation.".to_string())?;
    let trash_target = unique_candidate(&trash_dir.join(file_name));

    match fs::rename(&path, &trash_target) {
        Ok(_) => Ok(DeleteTrackResult {
            status: "trashed".to_string(),
            moved_to: Some(trash_target.to_string_lossy().to_string()),
        }),
        Err(trash_error) => Err(format!(
            "Could not delete file '{}': {}. Also failed to move to trash: {}",
            path.to_string_lossy(),
            last_error,
            trash_error
        )),
    }
}

#[tauri::command]
fn export_rekordbox_xml(request: ExportXmlRequest) -> Result<ExportXmlResult, String> {
    let root = PathBuf::from(&request.root);
    let mut genres = discover_genres(&root)?;
    genres.sort();

    let mut known_tracks: Vec<String> = Vec::new();
    let mut playlists: Vec<(String, String, Vec<usize>)> = Vec::new();

    for genre in &genres {
        let genre_path = root.join(genre);
        if !genre_path.is_dir() {
            continue;
        }

        let year_dirs = fs::read_dir(&genre_path)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.len() == 4 && name.chars().all(|ch| ch.is_ascii_digit()) {
                    Some((name, e.path()))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        for (year, year_path) in year_dirs {
            let mut track_ids = Vec::new();
            for entry in WalkDir::new(year_path)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .filter(|entry| is_supported_media(entry.path()))
            {
                let path = entry.path().to_string_lossy().to_string();
                let id = if let Some(pos) = known_tracks.iter().position(|v| v == &path) {
                    pos + 1
                } else {
                    known_tracks.push(path);
                    known_tracks.len()
                };
                track_ids.push(id);
            }
            if !track_ids.is_empty() {
                playlists.push((genre.clone(), year, track_ids));
            }
        }
    }

    let xml = build_rekordbox_xml(&known_tracks, &playlists);
    fs::write(&request.output_path, xml).map_err(|e| e.to_string())?;

    let folder_count = playlists
        .iter()
        .map(|(genre, _, _)| genre.clone())
        .collect::<HashSet<_>>()
        .len();

    Ok(ExportXmlResult {
        folder_count,
        playlist_count: playlists.len(),
        track_count: known_tracks.len(),
        output_path: request.output_path,
    })
}

fn build_rekordbox_xml(known_tracks: &[String], playlists: &[(String, String, Vec<usize>)]) -> String {
    let mut output = String::new();
    output.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    output.push_str("<DJ_PLAYLISTS Version=\"1.0.0\">\n");
    output.push_str("  <PRODUCT Name=\"Genre Sorter\" Version=\"0.1.0\"/>\n");
    output.push_str("  <COLLECTION Entries=\"");
    output.push_str(&known_tracks.len().to_string());
    output.push_str("\">\n");

    for (idx, path) in known_tracks.iter().enumerate() {
        let location = format!("file://localhost{}", escape_xml(path));
        output.push_str("    <TRACK TrackID=\"");
        output.push_str(&(idx + 1).to_string());
        output.push_str("\" Name=\"");
        let name = Path::new(path)
            .file_stem()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        output.push_str(&escape_xml(&name));
        output.push_str("\" Location=\"");
        output.push_str(&location);
        output.push_str("\"/>\n");
    }

    output.push_str("  </COLLECTION>\n");
    output.push_str("  <PLAYLISTS>\n");
    output.push_str("    <NODE Type=\"0\" Name=\"ROOT\" Count=\"");

    let genre_count = playlists
        .iter()
        .map(|(genre, _, _)| genre.clone())
        .collect::<HashSet<_>>()
        .len();
    output.push_str(&genre_count.to_string());
    output.push_str("\">\n");

    let mut by_genre: Vec<(String, Vec<(String, Vec<usize>)>)> = Vec::new();
    for (genre, year, ids) in playlists {
        if let Some((_, existing)) = by_genre.iter_mut().find(|(g, _)| g == genre) {
            existing.push((year.clone(), ids.clone()));
        } else {
            by_genre.push((genre.clone(), vec![(year.clone(), ids.clone())]));
        }
    }

    for (genre, year_playlists) in by_genre {
        output.push_str("      <NODE Type=\"0\" Name=\"");
        output.push_str(&escape_xml(&genre));
        output.push_str("\" Count=\"");
        output.push_str(&year_playlists.len().to_string());
        output.push_str("\">\n");

        for (year, ids) in year_playlists {
            output.push_str("        <NODE Type=\"1\" Name=\"");
            output.push_str(&escape_xml(&year));
            output.push_str("\" KeyType=\"0\" Entries=\"");
            output.push_str(&ids.len().to_string());
            output.push_str("\">\n");
            for id in ids {
                output.push_str("          <TRACK Key=\"");
                output.push_str(&id.to_string());
                output.push_str("\"/>\n");
            }
            output.push_str("        </NODE>\n");
        }
        output.push_str("      </NODE>\n");
    }

    output.push_str("    </NODE>\n");
    output.push_str("  </PLAYLISTS>\n");
    output.push_str("</DJ_PLAYLISTS>\n");

    output
}

fn find_incoming_dir(root: &Path) -> Result<PathBuf, String> {
    for candidate in INCOMING_CANDIDATES {
        let path = root.join(candidate);
        if path.is_dir() {
            return Ok(path);
        }
    }
    Err("No incoming folder found. Expected 00 New or 00_NEW_IN.".to_string())
}

fn discover_genres(root: &Path) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(root).map_err(|e| e.to_string())?;
    let mut genres = Vec::new();

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SKIP_TOP_LEVEL.contains(&name.as_str()) {
            continue;
        }
        if name.starts_with('_') {
            continue;
        }
        if is_app_workspace_dir(&path) {
            continue;
        }
        genres.push(name);
    }
    Ok(genres)
}

fn is_app_workspace_dir(path: &Path) -> bool {
    path.join("src-tauri").is_dir()
}

fn track_info_from_path(path: &Path) -> TrackInfo {
    let metadata = fs::metadata(path).ok();
    let created_epoch = metadata
        .as_ref()
        .and_then(|m| m.created().ok())
        .or_else(|| metadata.as_ref().and_then(|m| m.modified().ok()))
        .and_then(systemtime_to_epoch)
        .unwrap_or(0);
    let modified_epoch = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(systemtime_to_epoch)
        .unwrap_or(0);

    let file_name = path
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let extension = path
        .extension()
        .map(|v| v.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let mut info = TrackInfo {
        path: path.to_string_lossy().to_string(),
        file_name,
        extension,
        size_bytes: metadata.map(|m| m.len()).unwrap_or(0),
        created_epoch,
        modified_epoch,
        duration_seconds: None,
        title: None,
        artist: None,
        album: None,
        genre: None,
        year: None,
        bpm: None,
        musical_key: None,
        tags: Vec::new(),
    };

    if let Ok(tagged_file) = Probe::open(path).and_then(|probe| probe.read()) {
        info.duration_seconds = Some(tagged_file.properties().duration().as_secs_f64());

        for tag in tagged_file.tags() {
            if info.title.is_none() {
                info.title = tag.title().map(|v| v.to_string());
            }
            if info.artist.is_none() {
                info.artist = tag.artist().map(|v| v.to_string());
            }
            if info.album.is_none() {
                info.album = tag.album().map(|v| v.to_string());
            }
            if info.genre.is_none() {
                info.genre = tag.genre().map(|v| v.to_string());
            }
            if info.year.is_none() {
                info.year = tag.year().map(|v| v.to_string());
            }

            if info.bpm.is_none() {
                info.bpm = tag.get_string(&ItemKey::Bpm).map(|v| v.to_string());
            }
            if info.musical_key.is_none() {
                info.musical_key = tag.get_string(&ItemKey::InitialKey).map(|v| v.to_string());
            }

            for item in tag.items() {
                let key = format!("{:?}", item.key());
                let value = item
                    .value()
                    .text()
                    .or_else(|| item.value().locator())
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                if value.trim().is_empty() {
                    continue;
                }
                info.tags.push(TagField { key, value });
            }
        }
    }

    info
}

fn file_year(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let ts = metadata
        .created()
        .ok()
        .or_else(|| metadata.modified().ok())
        .and_then(systemtime_to_epoch)
        .ok_or_else(|| "Could not read file timestamp.".to_string())?;

    let dt = Local
        .timestamp_opt(ts, 0)
        .single()
        .ok_or_else(|| "Invalid timestamp".to_string())?;
    Ok(dt.year().to_string())
}

fn unique_candidate(target_path: &Path) -> PathBuf {
    if !target_path.exists() {
        return target_path.to_path_buf();
    }

    let parent = target_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    let stem = target_path
        .file_stem()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "track".to_string());
    let ext = target_path
        .extension()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut idx = 1;
    loop {
        let candidate = if ext.is_empty() {
            parent.join(format!("{} ({})", stem, idx))
        } else {
            parent.join(format!("{} ({}).{}", stem, idx, ext))
        };

        if !candidate.exists() {
            return candidate;
        }
        idx += 1;
    }
}

fn is_supported_media(path: &Path) -> bool {
    path.extension()
        .map(|ext| {
            let lower = ext.to_string_lossy().to_lowercase();
            MEDIA_EXTENSIONS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn systemtime_to_epoch(ts: SystemTime) -> Option<i64> {
    ts.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_library_root,
            scan_library,
            create_genre,
            plan_move,
            execute_move,
            undo_move,
            delete_track,
            export_rekordbox_xml
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
