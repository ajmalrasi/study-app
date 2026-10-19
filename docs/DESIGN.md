# Study Notes — Design (draft v0.1)

Status: **v0.1 implemented and deployed** (server on the Pi, extension loaded unpacked).
Last updated: 2026-10-15

## 1. Goal

Take notes while watching online course videos (first target: DeepLearning.AI *Agentic AI*),
including quick sketches/annotations, then use the local LLM on the Jetson to turn rough notes
into study material that helps me *remember* (summary, gap-filling, flashcards, Q&A).

### Usage context
- Watching in **Chrome** on a PC (macOS or Linux). Phone is rare → phone only needs *review*.
- Input devices: keyboard + mouse/trackpad (no stylus assumed).
- Home network; Jetson at `192.168.3.30`.

### Principles
1. **Capture must be instant and never break focus.** No LLM in the capture path.
2. **AI runs after the lesson**, in the background.
3. **I own the data**: plain markdown + image files mirror everything in the DB.
4. **Never lose a note**: capture works even if the Jetson is down.

## 2. Verified findings

### DeepLearning.AI lesson page (checked 2026-10-15)
| Item | Finding | Design consequence |
|---|---|---|
| Player | Native `<video>` in the **top frame** (not an iframe), source is `blob:` (MSE/HLS) | Read/seek `video.currentTime` directly from a content script. |
| Subtitles | Logged in: **HLS master playlist** (`…-master.m3u8` on `video.deeplearning.ai`) lists `TYPE=SUBTITLES` renditions in 7 languages; EN → `subtitle/eng/*.m3u8` → **one `.vtt` file**. (Logged-out preview exposed them as `<track>` elements instead.) Verified: 2-min lesson = 21 cues, 2.7 KB, clean sentences with `00:00:02.605 -->` timing. Fetchable from the page context. | Transcript is fetched **automatically** with timestamps, no pasting. Adapter tries `<track>` first, then the master playlist found in `performance` resource entries. ~1.4 KB/min → a 10-min lesson ≈ 3k tokens, which fits the LLM in one pass. |
| Course structure | ~50 lesson links in the syllabus (videos plus some labs/quizzes); module shown in breadcrumb ("Module 1") | Group lesson → module → course. Non-video items (labs) still allow notes, just without a timestamp. |
| Layout | The `<video>` element's own rect can report 0 height; the visible player is its container | Crop screenshots to the **player container**, with fallback to the full tab. |
| Transcript UI | Page also has a "Show Transcript" button | Fallback source if track fetch fails. |
| URL shape | `/courses/<course>/lesson/<lessonId>/<slug>` | Natural key for course → lesson grouping. |
| Auth | Lessons require login (redirects to `auth.deeplearning.ai`) | Extension runs inside my logged-in tab, so that's fine; the server never touches DLAI. |
| Video rect | Known via `getBoundingClientRect()`; devicePixelRatio 2 on Mac | Crop screenshots to the video area. |

### Jetson LLM (`http://192.168.3.30:11434`)
| Item | Finding |
|---|---|
| Server | TensorRT Edge-LLM 0.10.1, **OpenAI-compatible** (`/v1/chat/completions`, also `/v1/messages`) |
| Model | alias `openclaw` (self-reports Qwen 3.5) |
| Limits | `max_model_len` 8192, **`max_input_len` 6144**, batch 2 |
| Modalities | **Text only** (image input rejected) |
| Speech | `/v1/audio/transcriptions` route exists but `transcription: false` in `/health` |
| Latency | ~1.4 s for a short answer |
| Ownership | Deployed by **OpenClaw**; LifeOS (port 8000) is its main consumer. **Study Notes is a separate app**: it only calls the OpenAI-compatible API and never touches OpenClaw or LifeOS code. Port **8765**. |
| Concurrency | `max_batch_size` 2, shared with LifeOS → this app sends **one request at a time** from a queue, backs off on errors/busy, and never runs jobs in the capture path. |

Consequences:
- The LLM **cannot see screenshots or sketches**. Each image instead gets text from the
  transcript cues around its timestamp (see §5), and the note text I type.
- Inputs over ~6k tokens must be chunked. Typical DLAI lesson (5–15 min ≈ 750–2,250 words ≈
  1–3k tokens) fits in one pass; chunking is only a fallback.
- Voice notes are not possible yet (STT disabled).

## 3. Architecture

```
┌──────────── Chrome (Mac/Linux) ─────────────┐
│ Lesson tab ── content script                │
│   • read/seek video time, pause/resume      │
│   • fetch subtitle track (.m3u8 → .vtt)     │
│   • quick-note overlay (Alt+N)              │
│ Service worker                              │
│   • hotkeys, captureVisibleTab + crop       │
│   • offline queue → sync to server          │
│ Side panel: timeline of notes, edit, jump,  │
│   "Process lesson", status                  │
│ Annotator window: draw on screenshot/blank  │
└───────────────┬─────────────────────────────┘
                │ HTTP JSON on LAN (port 8765)
┌───────────────▼─────────────────────────────┐
│ Raspberry Pi: Study Notes server (FastAPI)  │
│   SQLite + /images + /markdown mirror       │
│   job: process lesson → LLM                 │
│   review web app (phone/desktop)            │
└───────────────┬─────────────────────────────┘
                │ OpenAI API (localhost or LAN)
┌───────────────▼─────────────────────────────┐
│ Edge-LLM :11434  (openclaw)                 │
└─────────────────────────────────────────────┘
```

The server runs on the **Raspberry Pi** (192.168.3.20); the Jetson only serves the LLM.

## 4. Capture UX (while watching)

| Hotkey | Action | Focus behaviour |
|---|---|---|
| `Alt+N` | Floating note box over the video at current time; video pauses (configurable); `Enter` saves + resumes, `Esc` cancels | Stays on the page |
| `Alt+S` | Screenshot of the video area → note with image; toast "saved" | No interruption |
| `Alt+D` | Screenshot + open the **annotator** to draw on it | Opens a window |
| `Alt+B` | Bookmark "important" at current time, no typing | No interruption |

Hotkeys are rebindable at `chrome://extensions/shortcuts`. (On macOS `Alt` = `Option`.)

Side panel (open next to the video): chronological timeline; click a timestamp → seek;
edit/delete; re-annotate an image; "blank sketch" button; "Process lesson" button.

### Drawing: Excalidraw (decided)
- The extension includes an **Excalidraw editor page**, opened in its own Chrome window
  (side panel is too narrow to draw in).
- **Screenshot annotation** = Excalidraw scene with the captured frame inserted as a locked
  image element; I draw arrows/boxes/text on top. **Blank sketch** = empty scene.
- Shapes stay editable: reopen any sketch later and keep editing.
- Each save stores **two files**: `*.excalidraw` (scene JSON, source of truth) and `*.png`
  (rendered export for the timeline, review page and markdown).
  The `.excalidraw` files also open in Obsidian's Excalidraw plugin.
- Implementation consequences:
  - Needs a **build step** (Vite + React) for that one page. The rest of the extension stays
    plain JS.
  - MV3 forbids remote code, so Excalidraw and its **fonts/assets are bundled locally**
    (set `EXCALIDRAW_ASSET_PATH` to the extension). Expect a few MB of extension size.
  - Library items (reusable shapes, e.g. "LLM", "tool", "agent loop" boxes) can be saved
    and reused across lessons.

## 5. Data model

```
course   (id, slug, title, source_site)
lesson   (id, course_id, url_key, title, duration, transcript_vtt, processed_at)
note     (id, lesson_id, t, kind[text|bookmark|shot|sketch], text, image_png, scene_file, context, created, updated)
artifact (lesson_id, study_notes_md, model, prompt_version, created)   -- AI output, regenerable
card     (id, lesson_id, note_id?, t?, q, a, box, due, suspended)        -- spaced repetition
```

- `url_key` = URL without query/hash, so revisiting a lesson reopens its notes.
- `context` = transcript text from **t−20 s … t+5 s** saved with each note. This gives the
  text-only LLM (and future me) what was being said when I took a screenshot or bookmark.
- Edits to notes never get overwritten by AI; AI output is stored separately and can be
  regenerated.
- Markdown mirror: `markdown/<course>/<NN>-<lesson>.md` + `images/`, so it opens in Obsidian.

## 6. AI pipeline ("Process lesson")

Runs as a background job on the server; the side panel shows progress.

1. **Inputs**: my notes (with timestamps + `context`), full transcript (from VTT).
2. **Budget**: if transcript + notes < ~4.5k tokens → single pass; else map-reduce over
   transcript chunks (~3k tokens each) into key points first.
3. **Outputs** (separate prompts, each small):
   - *Study notes*: summary, key concepts (keeping my timestamps), "what I missed"
     (in transcript but not in my notes), questions to think about.
   - *Flashcards*: 6–10 Q/A as JSON, each linked to a timestamp for "watch again".
4. **Strip `<think>` blocks**, validate JSON, retry once on parse failure.
5. Store with `model` + `prompt_version` so results can be compared/regenerated.

Later (phase 3):
- **Ask my notes**: embeddings + retrieval across all lessons ("compare reflection vs. tool use").
  Needs an embedding model on the Jetson (Edge-LLM doesn't expose `/v1/embeddings` today).
- **Course-level summary** across lessons in a module.

## 7. Review

- Server-hosted web page (works on phone): lessons → my notes / study notes / cards; Export `.md`.
- Spaced repetition: Leitner boxes (0,1,3,7,14,30 days); "Didn't know" resets to 10 min.
- Option: export cards to Anki (CSV) instead of/in addition to built-in review.

## 8. Reliability & security

- **Offline queue**: notes/images go to `chrome.storage.local` first, then sync; the side
  panel shows "3 unsynced". Jetson reboot ≠ lost notes.
- **Network**: LAN only, no auth in v1. If phone access outside home is wanted → Tailscale
  rather than port-forwarding. Optional shared token header.
- **Backups**: nightly copy of `data/` (SQLite + images + markdown) off the Jetson.
- Extension permissions: `sidePanel`, `storage`, `scripting`, `tabs`, host access to
  `learn.deeplearning.ai`, `video.deeplearning.ai`, and the server URL (not `<all_urls>`,
  unless other sites are added).

## 9. Extensibility: site adapters

Keep DLAI-specific code in one adapter: `findVideo()`, `getTranscript()`, `lessonInfo()`.
A generic fallback (largest `<video>` on the page, no transcript) makes YouTube/Coursera
basically work; dedicated adapters can add their transcripts later.

## 10. Phased plan

| Phase | Scope | Done when |
|---|---|---|
| 0 | Design sign-off (this doc) | Open questions answered |
| 1 | Server on Jetson + extension capture (notes, bookmarks, screenshots, time-jump, offline queue) | I can take a full lesson's notes with hotkeys |
| 2 | Auto transcript + "Process lesson" + review page + flashcards | Study notes + cards for a lesson in < 1 min |
| 3 | Excalidraw editor (screenshot annotation + sketches) | Draw on a slide in < 3 clicks, reopen and edit later |
| 4 | Ask-my-notes (RAG), course-level summaries, other sites | — |

## 11. Risks

| Risk | Mitigation |
|---|---|
| DLAI changes their player/subtitle format | Adapter isolated; fallback to "Show Transcript" text or paste |
| `captureVisibleTab` rate limit (~2/s) | Fine for manual captures; debounce |
| Small model hallucinating in "what I missed" | Only allow points present in transcript; show source timestamp |
| 6k input limit | Chunking + per-note context windows instead of full transcript |
| Mac `Option+key` types special chars in text fields | Commands are global; video page has no focused input usually; rebindable |

## 12. Decisions

| # | Question | Decision (2026-10-15) |
|---|---|---|
| 1 | Drawing | **Excalidraw**: full editable diagrams, also used for screenshot annotation |
| 2 | Relation to LifeOS | **Separate app.** Only calls the LLM's OpenAI-compatible API; don't modify OpenClaw/LifeOS |
| 3 | Phone access | **Home Wi-Fi only**, no auth in v1 |
| 4 | Flashcards | **Built-in review page** with spaced repetition, linked to video timestamps |
| 5 | Server host | **Raspberry Pi 192.168.3.20:8765** (systemd user service). Jetson is used only for the LLM |
| 6 | Capture surface | Chrome extension (side panel + hotkeys + Excalidraw window) |

| 7 | Labs / quizzes | **Videos only** |
| 8 | Deployment | Python venv + systemd user unit on the Pi, same pattern as `lifeos-web`; `deploy/deploy.sh` |
| 9 | Pause on note | Yes by default (setting in the side panel) |
| 10 | Excalidraw hosting | **Served by the Pi server at `/draw/`**, not bundled in the extension: no MV3 remote-code limits, and drawings are editable from the review page too. Fonts self-hosted |
| 11 | Scope | All phases 1-3 built together |

## 13. Implementation notes (v0.1)

- Transcript: when the player uses hls.js (`blob:` src), the subtitle playlist is found in
  `performance` resource entries. The SPA keeps earlier lessons' entries, so the URL with the most
  words matching the lesson slug wins.
- Processing a 5-min lesson (notes + 61-cue transcript) took ~90 s on the Jetson, in two LLM
  calls (study notes, flashcards). Re-processing keeps review progress for unchanged cards.
- Offline queue uses client-generated note ids, so retries are idempotent.
- Not built yet: Ask-my-notes (RAG), course-level summaries, other sites' transcript adapters,
  off-device backup copy.
