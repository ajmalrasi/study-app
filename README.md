# Study Notes

Take notes while watching course videos (DeepLearning.AI and Udemy lecture pages), with timestamps,
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

```bash
git clone https://github.com/ajmalrasi/study-app.git ~/tgs/study-app
```

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick `~/tgs/study-app/extension`.
3. Pin it from the puzzle-piece menu. Clicking the icon opens the side panel.
4. Optional: change hotkeys at `chrome://extensions/shortcuts`.

**Update:** `git -C ~/tgs/study-app pull`, then click ↻ on Study Notes in `chrome://extensions`.

## Udemy

Open an enrolled lecture (`/course/<course>/learn/lecture/<id>`), then open Study Notes.
Course landing pages and their promotional previews are not lecture pages. Notes are grouped
by course and lecture; coupon and playback query parameters are removed from saved links.
Automatic transcripts read the current lecture's captions through your signed-in Udemy
session, including players that do not expose native subtitle tracks. Availability depends
on captions being provided for that lecture; English is preferred when available.

## While watching

Study Notes is available only on Udemy and `learn.deeplearning.ai`. Open it with
the toolbar icon on your lesson. It hides on other sites and returns when you
switch back to a lesson where it was open. Notes-server pages remain accessible
through Open and Search / Ask, but do not activate the extension panel.

With **Save every lesson's transcript automatically** enabled, loading a lesson
in a background tab can save its available subtitles even while the panel is
hidden. This does not crawl a course, record audio or video, or take automatic
screenshots. Turn that setting off to stop automatic transcript saving.

The extension has required website access only to the two learning sites and
the default local notes server. A custom server requests access to that server
when you save its address. Screenshots use temporary access granted by clicking
the toolbar icon on the lesson or pressing the screenshot shortcut.

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

Video links open the lesson at the selected moment.

The review workspace includes course/module navigation, a resume-reading overview, scoped
search, and short flashcard sessions with real next-review intervals and undo. Study-note
timestamps reveal the source passage; you can then read it in the transcript or open the
video. Captures open in a zoomable preview, with a separate action to edit their drawings.
Paper, Evening, and System appearances and a comfortable reading size are available in
**Reading & appearance**. Reading positions and answer drafts are saved in that browser.

## Quizzes across lessons

Open **Quizzes** in the notes website to create a saved quiz with 1–100 written-answer or
multiple-choice questions. Choose a whole course, one or more sections, or an explicit set
of saved lessons. Quizzes and every attempt are stored on the server, including draft answers,
feedback, results, and the original transcript evidence. You can resume an attempt, retake a
quiz, or practise questions you missed without replacing earlier results.

For Udemy sections or DeepLearning.AI modules:

1. Open the signed-in course in Chrome, with Study Notes 0.5.0 or later loaded.
2. Open the extension and click **Sync course sections**. Every Udemy curriculum page is
   checked; DeepLearning.AI's complete lesson inventory is checked against every module's
   contents. Existing lessons are grouped using their stable lesson IDs.
3. On **Quizzes**, select the course and sections. The page lists available and missing video
   transcripts separately from articles, quizzes, and other items.
4. Click **Fetch missing transcripts**, keeping that course tab open. The extension
   checks the queue within a minute and fetches captions through the signed-in browser without
   playing the lessons. Refresh coverage after the import finishes. Sign-in errors and videos
   without captions remain listed; another import retries missing items.
5. Choose the question count and format, then create the quiz. Missing transcripts block
   creation unless you explicitly allow a partial quiz.

Generation runs in the background and resumes saved work after a restart. It processes
**every included transcript chunk**, plans questions across lessons, retrieves related evidence
within the selection, and asks the model to verify each batch. A quiz is labelled **Partial
coverage** if transcripts are missing, lessons have no questions, or fewer supported questions
were generated than requested. A small question count cannot guarantee every lesson is tested.
The coverage view shows exactly which lessons are represented.

Retrieval currently uses keyword search over the quiz's source snapshots. Semantic embeddings
are not required. Updating or deleting a lesson does not change an existing quiz's evidence;
the coverage view flags source changes. Create a new quiz to use updated transcripts.

DeepLearning.AI videos are imported from each lesson's caption metadata without playing the
video. Readings, labs, and existing quizzes are listed as non-video items. A changed lesson
title or URL slug retains the saved lesson and notes through its stable ID. Course formats
that cannot be completely verified fail explicitly rather than saving an incomplete outline.
Quiz data is included in the existing SQLite backups.

Verification: `python3 -m unittest discover -s tests -p 'test*.py'` and
`node tests/udemy_curriculum.mjs`, `node tests/dlai_curriculum.mjs`, in addition to the
existing extension checks.

## Data

On the Pi under `~/apps/study_notes/data/`:
- `notes.db`: SQLite
- `files/`: screenshots, drawing PNGs and `.excalidraw` scenes
- `markdown/<course>/`: a plain markdown copy of every lesson (Obsidian-friendly)

Snapshot nightly at 03:30 to `~/backups/study_notes/` (14 days kept).

## Develop & deploy

```bash
deploy/deploy.sh            # build Excalidraw editor, rsync to the Pi, restart the service
deploy/push-extension.sh    # alternative to git: rsync the extension to 192.168.3.210 over SSH
```

Local dev: `cd server && NOTES_DATA=/tmp/study-notes-dev uvicorn app:app --port 8765 --reload`
and set the extension's server URL (⚙ in the side panel) to `http://localhost:8765`.
The editor is in `draw/` (`npm run build` writes to `server/static/draw/`).

On the Pi: `systemctl --user status study-notes` · logs: `journalctl --user -u study-notes -f`.
LLM settings: `~/.config/study-notes.env` (`LLM_URL`, `LLM_MODEL`).

The review UI is plain HTML, CSS, and JavaScript in `server/static/ui/`, with locally served
SVG icons and favicons. Design and behavior: [docs/UI_DESIGN.md](docs/UI_DESIGN.md).

API checks (use an isolated temporary database automatically):

```bash
python3 -m pip install -r server/requirements-dev.txt
python3 -m unittest discover -s tests -v
```

### Generate a whole course

In Library, each course has **Generate all · N** for saved lessons with notes or a
transcript that still need study material. It queues summaries and flashcards using
the existing one-at-a-time worker. Completed lessons and active jobs are skipped;
failed unprocessed lessons can be retried. Repeated clicks do not duplicate jobs.
You can leave the page while generation runs. Use **Refresh** beside the generating
count to update statuses.

Validation: 12 API tests, including course scoping, skipping completed/active/empty/
draft-only lessons, failed-job retry and concurrent duplicate submissions. Live
browser verification confirmed the course button and eligible count.
