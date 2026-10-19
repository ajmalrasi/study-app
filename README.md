# Study Notes

Take notes while watching course videos (built for DeepLearning.AI), with timestamps,
screenshots and Excalidraw drawings. Your local LLM on the Jetson then turns them into study notes
and flashcards.

```
Chrome extension (Mac/Linux)  ──►  Raspberry Pi :8765 (server, data, review page, Excalidraw)
                                          │
                                          ▼
                               Jetson :11434 (LLM, OpenAI API)
```

- **Server**: `http://192.168.3.20:8765` (review page, works on your phone over home Wi-Fi)
- **LLM**: `http://192.168.3.30:11434/v1/chat/completions`, model `openclaw` (only called, never modified)
- Design and decisions: [docs/DESIGN.md](docs/DESIGN.md)

## Install the Chrome extension (once per computer)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/` folder of this repo.
3. Pin it from the puzzle-piece menu. Clicking the icon opens the side panel.
4. Optional: change hotkeys at `chrome://extensions/shortcuts`.

On Linux, copy or clone the repo there and load the same `extension/` folder.

## While watching

| Key (Mac: Option) | What it does |
|---|---|
| `Alt+N` | Note box over the video at the current time (video pauses, Enter saves and resumes, tick ⭐ for important) |
| `Alt+S` | Screenshot of the video, saved as a note |
| `Alt+D` | Screenshot, then opens Excalidraw to draw on it |
| `Alt+B` | Bookmark the moment as important |
| *(set a key)* | Save quote: saves what's being said right now. Assign a key at `chrome://extensions/shortcuts` |

Side panel: type notes (timestamped when you *start* typing), click a timestamp to jump the
video, click a note to edit it, use **🖊 Sketch** for a blank drawing, and **✨ Process lesson**
when you finish.

**Transcripts:** every lesson video you open has its transcript saved automatically, even
without notes (turn off in ⚙). The side panel's **Transcript** tab follows the video: the
current line is highlighted, clicking a line jumps there, and selecting text gives
**💬 Save as note**. The **💬 Quote** button saves the last few seconds of what was said.

If the Pi is unreachable, notes are kept in the browser and sync automatically later
("⏳ N changes waiting to sync").

## After the lesson

**✨ Process lesson** sends your notes plus the lesson transcript (fetched automatically from
the video's subtitles) to the Jetson LLM and produces:
- study notes: summary, key concepts with timestamps, "what I might have missed", questions
- 6–10 flashcards linked to the moment in the video

Lessons you only watched can be processed too (summary + flashcards from the transcript).

Open `http://192.168.3.20:8765` to:
- **Search** every saved transcript and your notes, with results linking to the exact moment
- **✨ Ask** a question: the Jetson answers from your lessons with cited sources
- read each lesson's **Transcript** with your notes and drawings placed where you took them
- edit drawings and review flashcards (spaced repetition)

Timestamps everywhere open the lesson video at that point.

## Data

On the Pi under `~/apps/study_notes/data/`:
- `notes.db`: SQLite
- `files/`: screenshots, drawing PNGs and `.excalidraw` scenes
- `markdown/<course>/`: a plain markdown copy of every lesson (Obsidian-friendly)

Snapshot nightly at 03:30 to `~/backups/study_notes/` (14 days kept).

## Develop & deploy

```bash
deploy/deploy.sh            # build Excalidraw editor, rsync to the Pi, restart the service
deploy/push-extension.sh    # copy the extension to 192.168.3.210:/home/ajmalrasi/tgs/study
```

Local dev: `cd server && NOTES_DATA=/tmp/study-notes-dev uvicorn app:app --port 8765 --reload`
and set the extension's server URL (⚙ in the side panel) to `http://localhost:8765`.
The editor is in `draw/` (`npm run build` writes to `server/static/draw/`).

On the Pi: `systemctl --user status study-notes` · logs: `journalctl --user -u study-notes -f`.
LLM settings: `~/.config/study-notes.env` (`LLM_URL`, `LLM_MODEL`).
