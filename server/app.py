"""Study Notes server: stores lecture notes and turns them into study material with the Jetson LLM.

Run:  uvicorn app:app --host 0.0.0.0 --port 8765
"""
import base64
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

HERE = Path(__file__).parent
DATA = Path(os.environ.get("NOTES_DATA", HERE / "data"))
FILES = DATA / "files"
MARKDOWN = DATA / "markdown"
STATIC = HERE / "static"
LLM_URL = os.environ.get("LLM_URL", "http://192.168.3.30:11434/v1/chat/completions")
LLM_MODEL = os.environ.get("LLM_MODEL", "openclaw")
# The Edge-LLM server accepts 6144 input tokens (~4 chars/token). Keep each request's
# material under this many characters so prompt + material stays well inside the limit.
MATERIAL_CHARS = int(os.environ.get("MATERIAL_CHARS", "15000"))
PROMPT_VERSION = 1

for d in (FILES, MARKDOWN):
    d.mkdir(parents=True, exist_ok=True)

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE, title TEXT);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY, course_id INTEGER, url_key TEXT UNIQUE, title TEXT, module TEXT DEFAULT '',
  duration REAL, transcript TEXT DEFAULT '', transcript_src TEXT DEFAULT '',
  study_notes TEXT DEFAULT '', study_meta TEXT DEFAULT '', created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, lesson_id INTEGER, t REAL, kind TEXT, text TEXT DEFAULT '',
  image TEXT, drawing TEXT, scene TEXT, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY, lesson_id INTEGER, q TEXT, a TEXT, t REAL,
  box INTEGER DEFAULT 0, due REAL, created REAL);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, lesson_id INTEGER, status TEXT, step TEXT DEFAULT '', error TEXT DEFAULT '',
  created REAL, finished REAL);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY, lesson_id INTEGER, question TEXT, answer TEXT, feedback TEXT, created REAL);
CREATE TABLE IF NOT EXISTS card_reviews (
  id TEXT PRIMARY KEY, card_id INTEGER, correct INTEGER, previous_box INTEGER, previous_due REAL,
  box INTEGER, due REAL, version INTEGER, created REAL, undone INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS cards_lesson ON cards(lesson_id);
CREATE INDEX IF NOT EXISTS notes_lesson ON notes(lesson_id);
CREATE INDEX IF NOT EXISTS jobs_lesson ON jobs(lesson_id, id);
-- Full-text index over transcript paragraphs and my notes; rebuilt per lesson on every change.
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  text, lesson_id UNINDEXED, t UNINDEXED, kind UNINDEXED, tokenize='porter unicode61');
"""


def db():
    conn = sqlite3.connect(DATA / "notes.db", timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


with db() as _c:
    _c.executescript(SCHEMA)
    if "draft" not in [r[1] for r in _c.execute("PRAGMA table_info(notes)")]:
        _c.execute("ALTER TABLE notes ADD COLUMN draft INTEGER DEFAULT 0")
    if "review_version" not in [r[1] for r in _c.execute("PRAGMA table_info(cards)")]:
        _c.execute("ALTER TABLE cards ADD COLUMN review_version INTEGER DEFAULT 0")
    if "title_custom" not in [r[1] for r in _c.execute("PRAGMA table_info(courses)")]:
        _c.execute("ALTER TABLE courses ADD COLUMN title_custom INTEGER DEFAULT 0")
    # A restart kills any job that was running; mark it so the UI doesn't wait forever.
    _c.execute("UPDATE jobs SET status='error', error='server restarted' WHERE status IN ('queued','running')")

app = FastAPI(title="Study Notes")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---------- helpers ----------

def fmt_t(t):
    if t is None:
        return ""
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def slugify(s, n=60):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:n] or "untitled"


def course_title(title, slug):
    """Old DLAI captures used the platform name instead of the actual course."""
    if not title or re.fullmatch(r"DeepLearning\.?AI(?:\s*[-–—]\s*Learning Platform)?", title.strip(), re.I):
        return " ".join(w.upper() if w.lower() in ("ai", "llm", "llms", "api") else w.capitalize()
                        for w in (slug or "Other").replace("-", " ").split())
    return title


def course_out(row):
    d = dict(row)
    d["title"] = course_title(d["title"], d["slug"])
    return d


def save_data_url(data_url):
    m = re.match(r"data:image/(png|jpeg|webp);base64,(.*)", data_url or "", re.S)
    if not m:
        raise HTTPException(400, "image must be a png/jpeg/webp data URL")
    name = f"{uuid.uuid4().hex}.{'jpg' if m[1] == 'jpeg' else m[1]}"
    (FILES / name).write_bytes(base64.b64decode(m[2]))
    return name


def remove_file(name):
    if name:
        (FILES / name).unlink(missing_ok=True)


def parse_vtt(vtt):
    """WebVTT text -> [{s, e, text}] with times in seconds."""
    def secs(ts):
        parts = ts.replace(",", ".").split(":")
        return sum(float(p) * 60 ** i for i, p in enumerate(reversed(parts)))

    cues = []
    for block in re.split(r"\n\s*\n", vtt.replace("\r", "")):
        lines = block.strip().split("\n")
        for i, line in enumerate(lines):
            m = re.match(r"([\d:.,]+)\s+-->\s+([\d:.,]+)", line)
            if m:
                text = " ".join(re.sub(r"<[^>]+>", "", x) for x in lines[i + 1:]).strip()
                if text:
                    cues.append({"s": round(secs(m[1]), 2), "e": round(secs(m[2]), 2), "text": text})
                break
    return cues


def lesson_cues(les):
    return json.loads(les["transcript"]) if les["transcript"] else []


def context_at(cues, t, before=20, after=5):
    """What was being said around a timestamp, so screenshots/bookmarks carry meaning."""
    if t is None:
        return ""
    return " ".join(c["text"] for c in cues if c["e"] >= t - before and c["s"] <= t + after)


def transcript_chunks(cues, span=30):
    """Merge cues into ~30 s paragraphs: [{t, text}]."""
    out, start, buf = [], None, []
    for c in cues:
        if start is None:
            start = c["s"]
        buf.append(c["text"])
        if c["e"] - start >= span:
            out.append({"t": start, "text": " ".join(buf)})
            start, buf = None, []
    if buf:
        out.append({"t": start, "text": " ".join(buf)})
    return [{**p, "id": f"p-{round(p['t'] * 1000)}"} for p in out]


def transcript_paragraphs(cues, span=30):
    """Paragraphs prefixed with [m:ss] for the LLM."""
    return [f"[{fmt_t(p['t'])}] {p['text']}" for p in transcript_chunks(cues, span)]


def get_lesson(c, lesson_id):
    row = c.execute("SELECT * FROM lessons WHERE id=?", (lesson_id,)).fetchone()
    if not row:
        raise HTTPException(404, "lesson not found")
    return row


def get_note(c, note_id):
    row = c.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if not row:
        raise HTTPException(404, "note not found")
    return row


def note_out(n):
    d = dict(n)
    d.pop("scene", None)
    d["has_drawing"] = bool(n["scene"])
    return d


def lesson_out(c, lesson_id):
    les = get_lesson(c, lesson_id)
    d = dict(les)
    d["has_transcript"] = bool(d.pop("transcript"))
    d["study_meta"] = json.loads(les["study_meta"] or "{}")
    course = c.execute("SELECT * FROM courses WHERE id=?", (les["course_id"],)).fetchone()
    d["course"] = course_out(course) if course else None
    cues = lesson_cues(les)
    d["notes"] = [{**note_out(n), "context": context_at(cues, n["t"])} for n in c.execute(
        "SELECT * FROM notes WHERE lesson_id=? AND draft=0 ORDER BY t IS NULL, t, created", (lesson_id,))]
    d["cards"] = [dict(k) for k in c.execute("SELECT * FROM cards WHERE lesson_id=? ORDER BY t, id", (lesson_id,))]
    d["answers"] = [dict(a) for a in c.execute("SELECT * FROM answers WHERE lesson_id=? ORDER BY id", (lesson_id,))]
    job = c.execute("SELECT * FROM jobs WHERE lesson_id=? ORDER BY id DESC LIMIT 1", (lesson_id,)).fetchone()
    d["job"] = dict(job) if job else None
    return d


def touch(c, lesson_id):
    c.execute("UPDATE lessons SET updated=? WHERE id=?", (time.time(), lesson_id))


def lesson_markdown(c, lesson_id, img_prefix="../../files/"):
    les = get_lesson(c, lesson_id)
    course = c.execute("SELECT * FROM courses WHERE id=?", (les["course_id"],)).fetchone()
    cues = lesson_cues(les)
    out = [f"# {les['title']}", ""]
    out.append(f"{course['title'] + ' · ' if course else ''}{les['module'] + ' · ' if les['module'] else ''}"
               f"[source]({les['url_key']})")
    out.append("")
    if les["study_notes"]:
        out += ["## Study notes (AI)", "", les["study_notes"], ""]
    out += ["## My notes", ""]
    for n in c.execute("SELECT * FROM notes WHERE lesson_id=? AND draft=0 ORDER BY t IS NULL, t, created", (lesson_id,)):
        line = f"- **[{fmt_t(n['t'])}]**" if n["t"] is not None else "-"
        if n["kind"] == "bookmark":
            line += " ⭐ important"
        if n["text"]:
            line += f" 💬 “{n['text']}”" if n["kind"] == "quote" else f" {n['text']}"
        out.append(line)
        if n["kind"] in ("bookmark", "shot") and not n["text"] and cues:
            out.append(f"  > {context_at(cues, n['t'])}")
        img = n["drawing"] or n["image"]
        if img:
            out.append(f"  ![]({img_prefix}{img})")
        if n["scene"]:
            out.append(f"  [Excalidraw scene]({img_prefix}{n['scene']})")
    answers = c.execute("SELECT * FROM answers WHERE lesson_id=? ORDER BY id", (lesson_id,)).fetchall()
    if answers:
        out += ["", "## My answers", ""]
        for a in answers:
            out += [f"**Q:** {a['question']}", "", f"**My answer:** {a['answer']}", "", a["feedback"], ""]
    cards = c.execute("SELECT * FROM cards WHERE lesson_id=? ORDER BY t, id", (lesson_id,)).fetchall()
    if cards:
        out += ["", "## Flashcards", ""]
        out += [f"- **Q:** {k['q']}  \n  **A:** {k['a']}" for k in cards]
    return "\n".join(out) + "\n"


def reindex(c, lesson_id):
    les = get_lesson(c, lesson_id)
    c.execute("DELETE FROM fts WHERE lesson_id=?", (lesson_id,))
    rows = [(p["text"], lesson_id, p["t"], "transcript") for p in transcript_chunks(lesson_cues(les))]
    rows += [(n["text"], lesson_id, n["t"], "note") for n in
             c.execute("SELECT text, t FROM notes WHERE lesson_id=? AND draft=0 AND text != ''", (lesson_id,))]
    c.executemany("INSERT INTO fts (text, lesson_id, t, kind) VALUES (?,?,?,?)", rows)


def write_markdown(c, lesson_id):
    """Mirror every lesson to plain markdown so notes are never locked in the database.
    Called after every change, so it also refreshes the search index."""
    reindex(c, lesson_id)
    les = get_lesson(c, lesson_id)
    course = c.execute("SELECT slug FROM courses WHERE id=?", (les["course_id"],)).fetchone()
    folder = MARKDOWN / (course["slug"] if course else "misc")
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob(f"{lesson_id:04d}-*.md"):
        old.unlink()
    (folder / f"{lesson_id:04d}-{slugify(les['title'])}.md").write_text(lesson_markdown(c, lesson_id))


# ---------- lessons ----------

class LessonIn(BaseModel):
    url: str
    title: str
    course: str = ""
    course_slug: str = ""
    module: str = ""
    duration: float | None = None


def url_key(url):
    return re.sub(r"[?#].*$", "", url).rstrip("/")


def upsert_lesson(c, body: LessonIn):
    course_id = None
    if body.course_slug:
        c.execute("""INSERT INTO courses (slug, title) VALUES (?,?) ON CONFLICT(slug) DO UPDATE SET
                     title=CASE WHEN courses.title_custom=1 THEN courses.title ELSE excluded.title END""",
                  (body.course_slug, course_title(body.course, body.course_slug)))
        course_id = c.execute("SELECT id FROM courses WHERE slug=?", (body.course_slug,)).fetchone()["id"]
    key, now = url_key(body.url), time.time()
    row = c.execute("SELECT id FROM lessons WHERE url_key=?", (key,)).fetchone()
    if row:
        c.execute("""UPDATE lessons SET title=?, course_id=COALESCE(?, course_id), module=COALESCE(NULLIF(?, ''), module),
                     duration=COALESCE(?, duration) WHERE id=?""",
                  (body.title, course_id, body.module, body.duration, row["id"]))
        return row["id"]
    return c.execute("""INSERT INTO lessons (course_id, url_key, title, module, duration, created, updated)
                        VALUES (?,?,?,?,?,?,?)""",
                     (course_id, key, body.title, body.module, body.duration, now, now)).lastrowid


@app.post("/api/lessons/resolve")
def resolve_lesson(body: LessonIn):
    with db() as c:
        return lesson_out(c, upsert_lesson(c, body))


@app.get("/api/lessons/by-url")
def lesson_by_url(url: str):
    with db() as c:
        row = c.execute("SELECT id FROM lessons WHERE url_key=?", (url_key(url),)).fetchone()
        if not row:
            raise HTTPException(404, "no notes for this lesson yet")
        return lesson_out(c, row["id"])


@app.get("/api/lessons/{lesson_id}")
def lesson_detail(lesson_id: int):
    with db() as c:
        return lesson_out(c, lesson_id)


@app.delete("/api/lessons/{lesson_id}")
def delete_lesson(lesson_id: int):
    with db() as c:
        get_lesson(c, lesson_id)
        c.execute("DELETE FROM card_reviews WHERE card_id IN (SELECT id FROM cards WHERE lesson_id=?)", (lesson_id,))
        for n in c.execute("SELECT image, drawing, scene FROM notes WHERE lesson_id=?", (lesson_id,)):
            for f in n:
                remove_file(f)
        for table in ("notes", "cards", "jobs", "fts", "answers"):
            c.execute(f"DELETE FROM {table} WHERE lesson_id=?", (lesson_id,))
        c.execute("DELETE FROM lessons WHERE id=?", (lesson_id,))
        for f in MARKDOWN.glob(f"*/{lesson_id:04d}-*.md"):
            f.unlink()
    return {"ok": True}


@app.get("/api/courses")
def list_courses():
    with db() as c:
        lessons = c.execute("""
          SELECT l.id, l.title, l.module, l.url_key, l.updated, l.course_id, l.study_notes != '' AS processed,
                 l.transcript != '' AS has_transcript,
                 (SELECT status FROM jobs j WHERE j.lesson_id=l.id ORDER BY id DESC LIMIT 1) AS job_status,
                 (SELECT step FROM jobs j WHERE j.lesson_id=l.id ORDER BY id DESC LIMIT 1) AS job_step,
                 (SELECT COUNT(*) FROM notes n WHERE n.lesson_id=l.id AND n.draft=0) AS note_count,
                 (SELECT COUNT(*) FROM cards k WHERE k.lesson_id=l.id) AS card_count
          FROM lessons l ORDER BY l.updated DESC""").fetchall()
        courses = {r["id"]: {**course_out(r), "lessons": []} for r in c.execute("SELECT * FROM courses")}
        other = {"id": None, "slug": "other", "title": "Other", "lessons": []}
        for les in lessons:
            courses.get(les["course_id"], other)["lessons"].append(dict(les))
        out = [v for v in courses.values() if v["lessons"]] + ([other] if other["lessons"] else [])
        return sorted(out, key=lambda v: -max(x["updated"] for x in v["lessons"]))


class CoursePatch(BaseModel):
    title: str = Field(min_length=1, max_length=160)


@app.patch("/api/courses/{course_id}")
def rename_course(course_id: int, body: CoursePatch):
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "Enter a course title.")
    with db() as c:
        if not c.execute("SELECT id FROM courses WHERE id=?", (course_id,)).fetchone():
            raise HTTPException(404, "course not found")
        c.execute("UPDATE courses SET title=?, title_custom=1 WHERE id=?", (title, course_id))
        for row in c.execute("SELECT id FROM lessons WHERE course_id=?", (course_id,)).fetchall():
            write_markdown(c, row["id"])
    return {"id": course_id, "title": title}


class TranscriptIn(BaseModel):
    vtt: str
    src: str = ""


@app.put("/api/lessons/{lesson_id}/transcript")
def set_transcript(lesson_id: int, body: TranscriptIn):
    cues = parse_vtt(body.vtt)
    if not cues:
        raise HTTPException(400, "no cues found in transcript")
    with db() as c:
        get_lesson(c, lesson_id)
        c.execute("UPDATE lessons SET transcript=?, transcript_src=? WHERE id=?",
                  (json.dumps(cues), body.src, lesson_id))
        write_markdown(c, lesson_id)
    return {"ok": True, "cues": len(cues)}


@app.get("/api/lessons/{lesson_id}/transcript")
def get_transcript(lesson_id: int):
    with db() as c:
        les = get_lesson(c, lesson_id)
        cues = lesson_cues(les)
        return {"cues": cues, "paragraphs": transcript_chunks(cues), "src": les["transcript_src"]}


@app.get("/api/lessons/{lesson_id}/export.md", response_class=PlainTextResponse)
def export_md(lesson_id: int):
    with db() as c:
        return lesson_markdown(c, lesson_id, img_prefix="/files/")


# ---------- notes ----------

class NoteIn(BaseModel):
    id: str | None = None  # client-generated so offline retries are idempotent
    lesson: LessonIn
    t: float | None = None
    kind: str = "text"  # text | bookmark | shot | sketch | quote (saved transcript line)
    text: str = ""
    image: str | None = None  # data URL
    created: float | None = None
    draft: bool = False  # screenshot/sketch opened for drawing; hidden until the drawing is saved


class NotePatch(BaseModel):
    text: str | None = None
    t: float | None = None


class DrawingIn(BaseModel):
    scene: dict
    png: str  # data URL of the rendered drawing


@app.post("/api/notes")
def add_note(body: NoteIn):
    if body.kind not in ("text", "bookmark", "shot", "sketch", "quote"):
        raise HTTPException(400, "bad kind")
    with db() as c:
        if body.id and (existing := c.execute("SELECT * FROM notes WHERE id=?", (body.id,)).fetchone()):
            return note_out(existing)
        lesson_id = upsert_lesson(c, body.lesson)
        note_id = body.id or uuid.uuid4().hex
        image = save_data_url(body.image) if body.image else None
        now = time.time()
        c.execute("""INSERT INTO notes (id, lesson_id, t, kind, text, image, created, updated, draft)
                     VALUES (?,?,?,?,?,?,?,?,?)""",
                  (note_id, lesson_id, body.t, body.kind, body.text.strip(), image, body.created or now, now,
                   int(body.draft)))
        touch(c, lesson_id)
        write_markdown(c, lesson_id)
        return note_out(get_note(c, note_id))


@app.get("/api/notes/{note_id}")
def note_detail(note_id: str):
    """Used by the drawing editor: includes the Excalidraw scene."""
    with db() as c:
        n = get_note(c, note_id)
        les = get_lesson(c, n["lesson_id"])
        d = note_out(n)
        d["scene"] = json.loads((FILES / n["scene"]).read_text()) if n["scene"] else None
        d["lesson"] = {"id": les["id"], "title": les["title"], "url_key": les["url_key"]}
        d["context"] = context_at(lesson_cues(les), n["t"])
        return d


@app.patch("/api/notes/{note_id}")
def edit_note(note_id: str, body: NotePatch):
    with db() as c:
        n = get_note(c, note_id)
        if body.text is not None:
            c.execute("UPDATE notes SET text=?, updated=? WHERE id=?", (body.text.strip(), time.time(), note_id))
        if body.t is not None:
            c.execute("UPDATE notes SET t=?, updated=? WHERE id=?", (body.t, time.time(), note_id))
        touch(c, n["lesson_id"])
        write_markdown(c, n["lesson_id"])
        return note_out(get_note(c, note_id))


@app.put("/api/notes/{note_id}/drawing")
def save_drawing(note_id: str, body: DrawingIn):
    with db() as c:
        n = get_note(c, note_id)
        png = save_data_url(body.png)
        scene = n["scene"] or f"{note_id}.excalidraw"
        (FILES / scene).write_text(json.dumps(body.scene))
        remove_file(n["drawing"])
        c.execute("UPDATE notes SET drawing=?, scene=?, updated=?, draft=0 WHERE id=?", (png, scene, time.time(), note_id))
        touch(c, n["lesson_id"])
        write_markdown(c, n["lesson_id"])
        return note_out(get_note(c, note_id))


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: str):
    with db() as c:
        n = c.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
        if not n:
            return {"ok": True}  # already gone; keeps offline-queue retries idempotent
        for f in (n["image"], n["drawing"], n["scene"]):
            remove_file(f)
        c.execute("DELETE FROM notes WHERE id=?", (note_id,))
        write_markdown(c, n["lesson_id"])
        return {"ok": True}


# ---------- LLM processing ----------

class LLMError(Exception):
    pass


def llm(system, user, max_tokens=1500):
    """One chat completion. The LLM is shared with other apps, so retry politely when it's busy."""
    body = {"model": LLM_MODEL, "max_tokens": max_tokens, "temperature": 0.3,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    req = urllib.request.Request(LLM_URL, json.dumps(body).encode(), {"Content-Type": "application/json"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                text = json.load(r)["choices"][0]["message"]["content"] or ""
            return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read().decode()[:300]}"
            if e.code < 500 and e.code != 429:
                break
        except OSError as e:
            last = str(e)
        time.sleep(5 * (attempt + 1))
    raise LLMError(f"LLM failed ({LLM_URL}): {last}")


def split_chunks(lines, size):
    out, cur = [], ""
    for line in lines:
        if cur and len(cur) + len(line) > size:
            out.append(cur)
            cur = ""
        cur += line + "\n"
    return out + ([cur] if cur.strip() else [])


def parse_cards(raw):
    m = re.search(r"\[.*\]", raw, re.S)
    try:
        cards = json.loads(m[0]) if m else []
    except json.JSONDecodeError:
        return []
    out = []
    for k in cards:
        if isinstance(k, dict) and k.get("q") and k.get("a"):
            at = re.match(r"(?:(\d+):)?(\d+):(\d{2})", str(k.get("at", "")))
            t = (int(at[1] or 0) * 3600 + int(at[2]) * 60 + int(at[3])) if at else None
            out.append({"q": str(k["q"]).strip(), "a": str(k["a"]).strip(), "t": t})
    return out


STUDY_PROMPT = """You turn a student's rough lecture notes into clear study notes.
Write markdown with exactly these sections:
### Summary
3-5 sentences.
### Key concepts
Bullets. Start each bullet with the [m:ss] timestamp where the idea appears.
### What I might have missed
Only important points that are in the TRANSCRIPT but absent from MY NOTES, with [m:ss].
Omit this section if there is no transcript.
### Questions to think about
2-3 open questions.
Be accurate and concise. Do not invent facts that are not in the input."""

CARDS_PROMPT = """Create 6-10 flashcards for active recall from the lecture material.
Each card tests one idea; prefer the ideas the student marked IMPORTANT or wrote notes about.
Answers are short (one or two sentences). "at" is the [m:ss] timestamp where the idea is taught.
Reply with ONLY a JSON array: [{"q": "question", "a": "answer", "at": "m:ss"}]"""


def build_material(les, notes, set_step):
    cues = lesson_cues(les)
    note_lines = []
    for n in notes:
        tag = {"bookmark": "(IMPORTANT) ", "shot": "(screenshot) ", "sketch": "(drawing) ",
               "quote": "(saved quote) "}.get(n["kind"], "")
        line = f"[{fmt_t(n['t'])}] {tag}{n['text']}".strip()
        if n["kind"] != "text" and not n["text"] and cues:
            line += f" — said at the time: \"{context_at(cues, n['t'])}\""
        note_lines.append(line)
    my_notes = "\n".join(note_lines) or "(none)"
    paragraphs = transcript_paragraphs(cues)
    transcript = "\n".join(paragraphs)

    if len(my_notes) + len(transcript) > MATERIAL_CHARS and paragraphs:
        # Too long for one request: condense the transcript chunk by chunk first.
        parts = split_chunks(paragraphs, MATERIAL_CHARS - 2000)
        points = []
        for i, part in enumerate(parts):
            set_step(f"condensing transcript {i + 1}/{len(parts)}")
            points.append(llm("Extract the key teaching points from this lecture transcript excerpt. "
                              "Markdown bullets only, each starting with its [m:ss] timestamp. "
                              "Keep definitions, techniques, examples and tips. No preamble.", part, 900))
        transcript = "\n".join(points)[:MATERIAL_CHARS - len(my_notes[:4000])]
    material = f"LECTURE: {les['title']}\n\nMY NOTES (taken while watching):\n{my_notes[:6000]}"
    if transcript:
        material += f"\n\nTRANSCRIPT:\n{transcript}"
    return material


def run_job(job_id):
    with db() as c:
        job = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        les = get_lesson(c, job["lesson_id"])
        notes = c.execute("SELECT * FROM notes WHERE lesson_id=? AND draft=0 ORDER BY t IS NULL, t, created",
                          (les["id"],)).fetchall()

    def set_step(step):
        with db() as c:
            c.execute("UPDATE jobs SET status='running', step=? WHERE id=?", (step, job_id))

    material = build_material(les, notes, set_step)
    set_step("writing study notes")
    prompt = STUDY_PROMPT
    if not notes:
        # Watched without taking notes: "what I missed" would just repeat everything.
        prompt = re.sub(r"### What I might have missed\n.*?(?=### Questions)", "", prompt, flags=re.S)
        prompt = prompt.replace("Start each bullet with the [m:ss] timestamp where the idea appears.",
                                "Cover the whole lecture. Start each bullet with its [m:ss] timestamp.")
    study = llm(prompt, material, 1500)
    set_step("making flashcards")
    cards = parse_cards(llm(CARDS_PROMPT, material, 1200))
    if not cards:
        set_step("making flashcards (retry)")
        cards = parse_cards(llm(CARDS_PROMPT + "\nOutput valid JSON only.", material, 1200))

    now = time.time()
    with db() as c:
        meta = json.dumps({"model": LLM_MODEL, "prompt_version": PROMPT_VERSION, "at": now})
        c.execute("UPDATE lessons SET study_notes=?, study_meta=?, updated=? WHERE id=?",
                  (study, meta, now, les["id"]))
        # Keep review progress for cards whose question survives a re-run.
        old = {k["q"]: k for k in c.execute("SELECT * FROM cards WHERE lesson_id=?", (les["id"],))}
        generation_version = max(int(now * 1000), max((k["review_version"] for k in old.values()), default=0) + 1)
        c.execute("DELETE FROM card_reviews WHERE card_id IN (SELECT id FROM cards WHERE lesson_id=?)", (les["id"],))
        c.execute("DELETE FROM cards WHERE lesson_id=?", (les["id"],))
        for k in cards:
            prev = old.get(k["q"])
            c.execute("INSERT INTO cards (lesson_id, q, a, t, box, due, created, review_version) VALUES (?,?,?,?,?,?,?,?)",
                      (les["id"], k["q"], k["a"], k["t"], prev["box"] if prev else 0,
                       prev["due"] if prev else now, now, generation_version))
        write_markdown(c, les["id"])
        c.execute("UPDATE jobs SET status='done', step='', finished=? WHERE id=?", (now, job_id))


_job_wakeup = threading.Event()


def job_worker():
    """One job at a time: the Jetson LLM serves only 2 requests concurrently and other apps share it."""
    while True:
        _job_wakeup.wait(timeout=30)
        _job_wakeup.clear()
        while True:
            with db() as c:
                job = c.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
            if not job:
                break
            try:
                run_job(job["id"])
            except Exception as e:  # noqa: BLE001 - surface any failure to the UI
                with db() as c:
                    c.execute("UPDATE jobs SET status='error', error=?, finished=? WHERE id=?",
                              (str(e)[:500], time.time(), job["id"]))


threading.Thread(target=job_worker, daemon=True).start()


@app.post("/api/lessons/{lesson_id}/process")
def process_lesson(lesson_id: int):
    with db() as c:
        les = get_lesson(c, lesson_id)
        n = c.execute("SELECT COUNT(*) FROM notes WHERE lesson_id=? AND draft=0", (lesson_id,)).fetchone()[0]
        if not n and not les["transcript"]:
            raise HTTPException(400, "Nothing to process yet: take some notes first.")
        active = c.execute("SELECT * FROM jobs WHERE lesson_id=? AND status IN ('queued','running')",
                           (lesson_id,)).fetchone()
        if active:
            return dict(active)
        job_id = c.execute("INSERT INTO jobs (lesson_id, status, step, created) VALUES (?, 'queued', 'waiting', ?)",
                           (lesson_id, time.time())).lastrowid
        job = dict(c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())
    _job_wakeup.set()
    return job


@app.get("/api/jobs/{job_id}")
def job_status(job_id: int):
    with db() as c:
        job = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job:
            raise HTTPException(404, "job not found")
        return dict(job)


# ---------- answering the "questions to think about" ----------

class AnswerIn(BaseModel):
    question: str
    answer: str


FEEDBACK_PROMPT = """You are a friendly but honest tutor. The student answered an open question about a
lecture. Using ONLY the lecture transcript (and their notes), reply in markdown with:
**What you got right**: 1-3 bullets.
**What to add or fix**: 1-3 bullets, citing [m:ss] timestamps from the transcript where the idea is taught.
**A strong answer**: 3-5 sentences.
If the answer is empty or off-topic, say so kindly and give the strong answer."""


def relevant_paragraphs(paragraphs, question, budget):
    """The whole transcript if it fits, else the paragraphs sharing the most words with the question."""
    if sum(len(p) for p in paragraphs) <= budget:
        return paragraphs
    words = {w for w in re.findall(r"[a-z0-9]+", question.lower()) if w not in STOPWORDS and len(w) > 2}
    scored = sorted(range(len(paragraphs)), key=lambda i: -sum(w in paragraphs[i].lower() for w in words))
    keep, used = set(), 0
    for i in scored:
        if used + len(paragraphs[i]) > budget:
            break
        keep.add(i)
        used += len(paragraphs[i])
    return [paragraphs[i] for i in sorted(keep)]


@app.post("/api/lessons/{lesson_id}/answers")
def answer_question(lesson_id: int, body: AnswerIn):
    if not body.answer.strip():
        raise HTTPException(400, "Write an answer first.")
    with db() as c:
        les = get_lesson(c, lesson_id)
        notes = c.execute("SELECT t, text FROM notes WHERE lesson_id=? AND draft=0 AND text != '' ORDER BY t", (lesson_id,)).fetchall()
    my_notes = "\n".join(f"[{fmt_t(n['t'])}] {n['text']}" for n in notes)[:3000]
    transcript = "\n".join(relevant_paragraphs(transcript_paragraphs(lesson_cues(les)), body.question,
                                                MATERIAL_CHARS - len(my_notes) - len(body.answer) - 500))
    material = (f"LECTURE: {les['title']}\n\nQUESTION: {body.question}\n\nSTUDENT'S ANSWER: {body.answer}"
                f"\n\nSTUDENT'S NOTES:\n{my_notes or '(none)'}\n\nTRANSCRIPT:\n{transcript or '(no transcript)'}")
    try:
        feedback = llm(FEEDBACK_PROMPT, material, 900)
    except LLMError as e:
        raise HTTPException(502, str(e))
    with db() as c:
        answer_id = c.execute("INSERT INTO answers (lesson_id, question, answer, feedback, created) VALUES (?,?,?,?,?)",
                              (lesson_id, body.question.strip(), body.answer.strip(), feedback, time.time())).lastrowid
        write_markdown(c, lesson_id)
        return dict(c.execute("SELECT * FROM answers WHERE id=?", (answer_id,)).fetchone())


@app.delete("/api/answers/{answer_id}")
def delete_answer(answer_id: int):
    with db() as c:
        a = c.execute("SELECT lesson_id FROM answers WHERE id=?", (answer_id,)).fetchone()
        if a:
            c.execute("DELETE FROM answers WHERE id=?", (answer_id,))
            write_markdown(c, a["lesson_id"])
    return {"ok": True}


# ---------- search & ask ----------

STOPWORDS = set("""a an and are as at be but by can could did do does for from had has have how i if in into is it
its me my of on or so than that the their them then there these they this to was we were what when where which
who why will with would you your about does did say said talk talked mean means explain lecture video course""".split())


def fts_query(q, mode="and"):
    words = re.findall(r"[a-z0-9]+", q.lower())
    words = [w for w in words if w not in STOPWORDS and len(w) > 1] or words
    if not words:
        return None
    terms = [f'"{w}"' for w in words]
    if mode == "and":
        terms[-1] += "*"  # prefix-match the word being typed
        return " ".join(terms)
    return " OR ".join(terms)


def search_rows(c, q, limit, mode, course_slug=None, kind=None):
    match = fts_query(q, mode)
    if not match:
        return []
    sql = """SELECT fts.lesson_id, fts.t, fts.kind, fts.text,
                    snippet(fts, 0, char(2), char(3), '…', 20) AS snip, bm25(fts) AS rank,
                    l.title, l.url_key, l.module, c.title AS course, c.slug AS course_slug
             FROM fts JOIN lessons l ON l.id = fts.lesson_id LEFT JOIN courses c ON c.id = l.course_id
             WHERE fts MATCH ?"""
    args = [match]
    if course_slug:
        sql += " AND c.slug = ?"
        args.append(course_slug)
    if kind in ("note", "transcript"):
        sql += " AND fts.kind = ?"
        args.append(kind)
    try:
        return [dict(r) for r in c.execute(sql + " ORDER BY rank LIMIT ?", (*args, limit))]
    except sqlite3.OperationalError:
        return []


@app.get("/api/search")
def search(q: str, limit: int = Query(30, ge=1, le=100), course_slug: str | None = None,
           kind: str = Query("all", pattern="^(all|title|note|transcript)$")):
    """Notes and transcript paragraphs matching all words (falls back to any word).
    Snippets mark matches with \\x02 ... \\x03."""
    with db() as c:
        rows = search_rows(c, q, limit, "and", course_slug, kind) or search_rows(c, q, limit, "or", course_slug, kind)
        if kind != "all":
            rows = [r for r in rows if r["kind"] == kind]
        titles = []
        if q.strip() and kind in ("all", "title"):
            query = """SELECT l.id AS lesson_id, NULL AS t, 'title' AS kind, l.title AS snip,
                       l.title, l.url_key, l.module, c.title AS course, c.slug AS course_slug
                       FROM lessons l LEFT JOIN courses c ON c.id=l.course_id WHERE instr(lower(l.title), ?) > 0"""
            args = [q.strip().lower()]
            if course_slug:
                query += " AND c.slug=?"
                args.append(course_slug)
            titles = [dict(r) for r in c.execute(query + " ORDER BY l.updated DESC LIMIT ?", (*args, limit))]
    for r in rows:
        r.pop("text")
    return {"results": (titles + rows)[:limit]}


class AskIn(BaseModel):
    q: str
    course_slug: str | None = None


ASK_PROMPT = """Answer the student's question using ONLY the numbered excerpts from their course
transcripts and their own notes. Cite excerpts in square brackets, like [2] or [1][3], right after
the sentences they support. If the excerpts don't answer the question, say so in one sentence.
Be concise: a short paragraph or a few bullets."""


@app.post("/api/ask")
def ask(body: AskIn):
    with db() as c:
        rows = search_rows(c, body.q, 12, "or", body.course_slug)
    if not rows:
        return {"answer": "I couldn't find anything about that in your saved transcripts or notes yet.", "sources": []}
    sources, parts, used = [], [], 0
    for r in rows:
        excerpt = (f"[{len(sources) + 1}] {r['title']}{' (' + r['module'] + ')' if r['module'] else ''}"
                   f" at {fmt_t(r['t'])}{' (my note)' if r['kind'] == 'note' else ''}:\n{r['text']}")
        if used + len(excerpt) > MATERIAL_CHARS:
            break
        used += len(excerpt)
        parts.append(excerpt)
        sources.append({"n": len(sources) + 1, "lesson_id": r["lesson_id"], "title": r["title"], "t": r["t"],
                        "url_key": r["url_key"], "kind": r["kind"], "module": r["module"], "text": r["text"]})
    try:
        answer = llm(ASK_PROMPT, f"QUESTION: {body.q}\n\nEXCERPTS:\n\n" + "\n\n".join(parts), 700)
    except LLMError as e:
        raise HTTPException(502, str(e))
    return {"answer": answer, "sources": sources}


# ---------- flashcard review (Leitner boxes) ----------

BOX_DAYS = [0, 1, 3, 7, 14, 30]


class ReviewIn(BaseModel):
    correct: bool
    request_id: str | None = Field(default=None, min_length=1, max_length=100)
    expected_version: int | None = None


def card_scope(lesson_id=None, course_slug=None):
    where, args = [], []
    if lesson_id is not None:
        where.append("k.lesson_id=?")
        args.append(lesson_id)
    if course_slug:
        where.append("l.course_id IN (SELECT id FROM courses WHERE slug=?)")
        args.append(course_slug)
    return (" AND " + " AND ".join(where) if where else ""), args


@app.get("/api/review/summary")
def review_summary(lesson_id: int | None = None, course_slug: str | None = None):
    scope, args = card_scope(lesson_id, course_slug)
    with db() as c:
        row = c.execute("""SELECT COUNT(*) AS total,
                         COALESCE(SUM(k.due <= ?), 0) AS due, MIN(k.due) AS next_due
                         FROM cards k JOIN lessons l ON l.id=k.lesson_id WHERE 1=1""" + scope,
                        (time.time(), *args)).fetchone()
        return dict(row)


@app.get("/api/cards/due")
def due_cards(limit: int = Query(30, ge=1, le=500), lesson_id: int | None = None,
              course_slug: str | None = None):
    with db() as c:
        q = """SELECT k.*, l.title AS lesson_title, l.url_key FROM cards k JOIN lessons l ON l.id=k.lesson_id
               WHERE k.due <= ?"""
        args = [time.time()]
        scope, scope_args = card_scope(lesson_id, course_slug)
        args.extend(scope_args)
        rows = c.execute(q + scope + " ORDER BY k.due, k.id LIMIT ?", (*args, limit)).fetchall()
        counts = c.execute("""SELECT COUNT(*) AS total, COALESCE(SUM(k.due <= ?), 0) AS due
                              FROM cards k JOIN lessons l ON l.id=k.lesson_id WHERE 1=1""" + scope,
                           (args[0], *scope_args)).fetchone()
        return {"cards": [{**dict(r), "again_seconds": 600,
                           "correct_seconds": BOX_DAYS[min(r["box"] + 1, len(BOX_DAYS) - 1)] * 86400}
                          for r in rows], **dict(counts)}


@app.post("/api/cards/{card_id}/review")
def review_card(card_id: int, body: ReviewIn):
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        request_id = body.request_id or uuid.uuid4().hex
        previous = c.execute("SELECT * FROM card_reviews WHERE id=?", (request_id,)).fetchone()
        if previous:
            if previous["card_id"] != card_id or previous["correct"] != int(body.correct) or previous["undone"]:
                raise HTTPException(409, "This review request has already been used. Refresh the review session.")
            return {"box": previous["box"], "due": previous["due"], "review_id": previous["id"],
                    "review_version": previous["version"]}
        k = c.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
        if not k:
            raise HTTPException(404, "card not found")
        if body.expected_version is not None and body.expected_version != k["review_version"]:
            raise HTTPException(409, "This card changed in another session. Start a fresh review.")
        box = min(k["box"] + 1, len(BOX_DAYS) - 1) if body.correct else 0
        due = time.time() + (BOX_DAYS[box] * 86400 if body.correct else 600)
        version = k["review_version"] + 1
        c.execute("UPDATE cards SET box=?, due=?, review_version=? WHERE id=?", (box, due, version, card_id))
        c.execute("""INSERT INTO card_reviews
                     (id, card_id, correct, previous_box, previous_due, box, due, version, created)
                     VALUES (?,?,?,?,?,?,?,?,?)""",
                  (request_id, card_id, int(body.correct), k["box"], k["due"], box, due, version, time.time()))
        return {"box": box, "due": due, "review_id": request_id, "review_version": version}


class UndoIn(BaseModel):
    review_id: str = Field(min_length=1, max_length=100)


@app.post("/api/cards/{card_id}/undo")
def undo_review(card_id: int, body: UndoIn):
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        review = c.execute("SELECT * FROM card_reviews WHERE id=? AND card_id=?", (body.review_id, card_id)).fetchone()
        card = c.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
        if not review or not card:
            raise HTTPException(404, "This review is no longer available to undo.")
        if review["undone"]:
            return {"box": card["box"], "due": card["due"], "review_version": card["review_version"]}
        if card["review_version"] != review["version"]:
            raise HTTPException(409, "This card has been reviewed again. Its newer schedule was kept.")
        version = card["review_version"] + 1
        c.execute("UPDATE cards SET box=?, due=?, review_version=? WHERE id=?",
                  (review["previous_box"], review["previous_due"], version, card_id))
        c.execute("UPDATE card_reviews SET undone=1 WHERE id=?", (body.review_id,))
        return {"box": review["previous_box"], "due": review["previous_due"], "review_version": version}


# Drafts are drawings that were opened but never saved; drop ones older than a day.
with db() as _c:
    for _n in _c.execute("SELECT * FROM notes WHERE draft=1 AND created < ?", (time.time() - 86400,)).fetchall():
        for _f in (_n["image"], _n["drawing"], _n["scene"]):
            remove_file(_f)
        _c.execute("DELETE FROM notes WHERE id=?", (_n["id"],))

# Build the search index for lessons saved before it existed.
with db() as _c:
    if not _c.execute("SELECT COUNT(*) FROM fts").fetchone()[0]:
        for _row in _c.execute("SELECT id FROM lessons").fetchall():
            reindex(_c, _row["id"])


# ---------- health & static ----------

@app.get("/api/health")
def health():
    try:
        with urllib.request.urlopen(LLM_URL.replace("/v1/chat/completions", "/health"), timeout=3) as r:
            llm_ok = r.status == 200
    except OSError:
        llm_ok = False
    return {"ok": True, "llm": llm_ok, "llm_url": LLM_URL}


app.mount("/files", StaticFiles(directory=FILES), name="files")
app.mount("/assets", StaticFiles(directory=STATIC / "ui"), name="review-assets")
# Excalidraw editor, built from draw/ by `npm run build` (served at /draw/?note=<id>).
(STATIC / "draw").mkdir(parents=True, exist_ok=True)
app.mount("/draw", StaticFiles(directory=STATIC / "draw", html=True), name="draw")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")
