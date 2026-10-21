"""Exercise the redesign's data and scheduling contracts in an isolated database."""
import importlib.util
import os
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient


class ReviewUIAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="study-notes-api-")
        os.environ["NOTES_DATA"] = cls.temp.name
        os.environ["LLM_URL"] = "http://127.0.0.1:9/v1/chat/completions"
        # Start with the previous schema to verify the non-destructive migration.
        with sqlite3.connect(Path(cls.temp.name) / "notes.db") as c:
            c.execute("CREATE TABLE courses (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, title TEXT)")
            c.execute("CREATE TABLE cards (id INTEGER PRIMARY KEY, lesson_id INTEGER, q TEXT, a TEXT, t REAL, box INTEGER DEFAULT 0, due REAL, created REAL)")
        spec = importlib.util.spec_from_file_location("review_ui_test_app", Path(__file__).parents[1] / "server/app.py")
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)
        cls.client = TestClient(cls.module.app)

    def setUp(self):
        with self.module.db() as c:
            for table in ("card_reviews", "cards", "notes", "answers", "jobs", "fts", "lessons", "courses"):
                c.execute("DELETE FROM " + table)
        self.lesson = self.client.post("/api/lessons/resolve", json={
            "url": "https://learn.deeplearning.ai/courses/agentic-ai/lesson/test/reflection",
            "title": "Reflection workflow", "course": "DeepLearning.AI - Learning Platform",
            "course_slug": "agentic-ai", "module": "Module 2",
        }).json()
        self.other = self.client.post("/api/lessons/resolve", json={
            "url": "https://example.com/other", "title": "Another course", "course": "Other course", "course_slug": "other-course",
        }).json()
        with self.module.db() as c:
            self.card = c.execute("INSERT INTO cards (lesson_id,q,a,t,box,due,created) VALUES (?,?,?,?,?,?,?)",
                                 (self.lesson["id"], "Why reflect?", "Improve a draft", 40, 2, 10, 1)).lastrowid
            c.execute("INSERT INTO cards (lesson_id,q,a,box,due,created) VALUES (?,?,?,?,?,?)",
                      (self.other["id"], "Other question", "Other answer", 0, 10, 1))
            c.execute("INSERT INTO cards (lesson_id,q,a,box,due,created) VALUES (?,?,?,?,?,?)",
                      (self.lesson["id"], "Future question", "Later", 0, 9000000000, 1))

    def rate(self, request_id="one", version=0, correct=True):
        return self.client.post(f"/api/cards/{self.card}/review", json={
            "correct": correct, "request_id": request_id, "expected_version": version,
        })

    def test_previous_schema_migrates_and_course_title_is_useful(self):
        self.assertEqual(self.lesson["course"]["title"], "Agentic AI")
        self.assertEqual(self.lesson["cards"], [])
        with self.module.db() as c:
            self.assertEqual(c.execute("SELECT review_version FROM cards WHERE id=?", (self.card,)).fetchone()[0], 0)

    def test_counts_and_intervals_are_scoped_and_not_limited_by_page(self):
        summary = self.client.get("/api/review/summary", params={"lesson_id": self.lesson["id"]}).json()
        self.assertEqual((summary["total"], summary["due"]), (2, 1))
        global_cards = self.client.get("/api/cards/due", params={"limit": 1}).json()
        self.assertEqual(len(global_cards["cards"]), 1)
        self.assertEqual(global_cards["due"], 2)
        scoped = self.client.get("/api/cards/due", params={"course_slug": "agentic-ai"}).json()
        self.assertEqual(len(scoped["cards"]), 1)
        self.assertEqual(scoped["cards"][0]["correct_seconds"], 7 * 86400)
        self.assertEqual(scoped["cards"][0]["again_seconds"], 600)

    def test_concurrent_retries_grade_only_once(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.rate("same-request"), range(2)))
        self.assertTrue(all(r.status_code == 200 for r in results))
        self.assertEqual(results[0].json(), results[1].json())
        with self.module.db() as c:
            card = c.execute("SELECT * FROM cards WHERE id=?", (self.card,)).fetchone()
            self.assertEqual(card["box"], 3)
            self.assertEqual(card["review_version"], 1)
            self.assertEqual(c.execute("SELECT COUNT(*) FROM card_reviews").fetchone()[0], 1)

    def test_stale_session_cannot_grade_again(self):
        self.assertEqual(self.rate().status_code, 200)
        self.assertEqual(self.rate("another-request", version=0).status_code, 409)
        self.assertEqual(self.rate("one", version=0, correct=False).status_code, 409)

    def test_undo_restores_schedule_and_is_idempotent(self):
        review = self.rate().json()
        undo = self.client.post(f"/api/cards/{self.card}/undo", json={"review_id": review["review_id"]})
        self.assertEqual(undo.status_code, 200)
        self.assertEqual((undo.json()["box"], undo.json()["due"]), (2, 10))
        self.assertEqual(undo.json()["review_version"], 2)
        again = self.client.post(f"/api/cards/{self.card}/undo", json={"review_id": review["review_id"]})
        self.assertEqual(again.json(), undo.json())
        self.assertEqual(self.rate("after-undo", version=2).status_code, 200)

    def test_undo_cannot_overwrite_a_newer_review(self):
        first = self.rate().json()
        self.assertEqual(self.rate("second", version=1).status_code, 200)
        self.assertEqual(self.client.post(f"/api/cards/{self.card}/undo", json={"review_id": first["review_id"]}).status_code, 409)

    def test_regeneration_preserves_schedule_but_invalidates_stale_ratings(self):
        self.rate()
        with self.module.db() as c:
            job_id = c.execute("INSERT INTO jobs (lesson_id,status,created) VALUES (?,'queued',1)",
                               (self.lesson["id"],)).lastrowid
        original = self.module.llm
        self.module.llm = lambda prompt, *args, **kwargs: ('[{"q":"Why reflect?","a":"Improve a draft","at":"0:40"}]'
                                                        if "flashcards" in prompt else "### Summary\nReflect on a draft.")
        try:
            self.module.run_job(job_id)
        finally:
            self.module.llm = original
        with self.module.db() as c:
            card = c.execute("SELECT * FROM cards WHERE lesson_id=?", (self.lesson["id"],)).fetchone()
            self.assertEqual(card["box"], 3)
            self.assertGreater(card["review_version"], 1)
            self.assertEqual(c.execute("SELECT COUNT(*) FROM card_reviews").fetchone()[0], 0)
        result = self.client.post(f"/api/cards/{card['id']}/review", json={
            "correct": True, "request_id": "stale-after-generation", "expected_version": 1,
        })
        self.assertEqual(result.status_code, 409)

    def test_custom_course_name_survives_extension_sync(self):
        cid = self.lesson["course"]["id"]
        self.assertEqual(self.client.patch(f"/api/courses/{cid}", json={"title": "My Agentic AI course"}).status_code, 200)
        self.client.post("/api/lessons/resolve", json={
            "url": self.lesson["url_key"], "title": "Reflection workflow", "course": "DeepLearning.AI - Learning Platform", "course_slug": "agentic-ai",
        })
        course = next(c for c in self.client.get("/api/courses").json() if c["id"] == cid)
        self.assertEqual(course["title"], "My Agentic AI course")
        self.assertEqual(self.client.patch(f"/api/courses/{cid}", json={"title": "  "}).status_code, 400)

    def test_search_titles_transcripts_notes_and_passage_ids(self):
        response = self.client.put(f"/api/lessons/{self.lesson['id']}/transcript", json={"vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:33.000\nExternal feedback guides reflection.\n"})
        self.assertEqual(response.status_code, 200)
        tr = self.client.get(f"/api/lessons/{self.lesson['id']}/transcript").json()
        self.assertEqual(tr["paragraphs"][0]["id"], "p-1000")
        titles = self.client.get("/api/search", params={"q": "workflow", "kind": "title"}).json()["results"]
        self.assertEqual(titles[0]["kind"], "title")
        matches = self.client.get("/api/search", params={"q": "feedback", "course_slug": "agentic-ai"}).json()["results"]
        self.assertEqual(matches[0]["t"], 1)
        self.assertFalse(self.client.get("/api/search", params={"q": "feedback", "course_slug": "other-course"}).json()["results"])

    def test_ask_returns_the_actual_cited_excerpt(self):
        with self.module.db() as c:
            c.execute("INSERT INTO fts (text, lesson_id,t,kind) VALUES (?,?,?,?)", ("External feedback improves reflection", self.lesson["id"], 40, "transcript"))
        original = self.module.llm
        self.module.llm = lambda *args, **kwargs: "Use external feedback [1]."
        try:
            result = self.client.post("/api/ask", json={"q": "feedback", "course_slug": "agentic-ai"}).json()
            self.assertEqual(result["sources"][0]["text"], "External feedback improves reflection")
        finally:
            self.module.llm = original

    def test_assets_and_limits(self):
        for asset in ("app.css", "app.js", "icons.svg", "favicon.svg", "apple-touch-icon.png", "site.webmanifest"):
            self.assertEqual(self.client.get("/assets/" + asset).status_code, 200)
        self.assertEqual(self.client.get("/api/cards/due?limit=0").status_code, 422)
        self.assertEqual(self.client.get("/api/search?q=test&kind=invalid").status_code, 422)


if __name__ == "__main__":
    unittest.main()
