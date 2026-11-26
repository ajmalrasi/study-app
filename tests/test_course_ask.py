import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from server.course_ask import make_chunks
from server.course_embeddings import DIMENSIONS


class FakeEncoder:
    model_id = "test-bge"

    def count(self, text):
        return len(text.split()) + 2

    def embed(self, texts, *, query=False):
        return [[1.0, 0.0] + [0.0] * (DIMENSIONS - 2) for _ in texts]


class CourseAskAPI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        with patch.dict(os.environ, {"NOTES_DATA": self.temp.name, "QUIZ_WORKER_ENABLED": "0",
                                     "COURSE_ASK_COUNT_URL": ""}):
            spec = importlib.util.spec_from_file_location("course_ask_test_app", Path(__file__).parents[1] / "server/app.py")
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)
        self.client = TestClient(self.module.app)
        self.addCleanup(self.client.close)
        self.ask = self.module.course_ask
        self.ask.encoder = FakeEncoder()
        self.ask.chunker = "test:encoder"

    def lesson(self, course, title, text=None):
        response = self.client.post("/api/lessons/resolve", json={"url": "https://example.com/" + title.replace(" ", "-"),
                                    "title": title, "course": course, "course_slug": course})
        self.assertEqual(response.status_code, 200)
        lesson = response.json()
        if text:
            self.save(lesson, text)
        return lesson

    def save(self, lesson, text):
        result = self.client.put(f"/api/lessons/{lesson['id']}/transcript", json={
            "vtt": "WEBVTT\n\n00:00:12.000 --> 00:00:35.000\n" + text + "\n",
        })
        self.assertEqual(result.status_code, 200)

    def question(self, lesson, q):
        response = self.client.post(f"/api/courses/{lesson['course']['id']}/ask", json={"q": q})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_hybrid_search_scopes_both_rankings_and_cites_two_lessons(self):
        first = self.lesson("agentic-ai", "Reflection", "Reflection revises an initial draft.")
        second = self.lesson("agentic-ai", "Evaluation", "An evaluator gives feedback on the revised output.")
        self.lesson("context-engineering", "Unrelated Context", "Reflection reflection reflection is outside the course.")
        while self.ask.embed_batch():
            pass

        def generate(system, material, limit):
            excerpts = json.loads(material)["passages"]
            self.assertEqual({p["lesson"] for p in excerpts}, {"Reflection", "Evaluation"})
            return json.dumps({"items": [{"text": "Reflection and evaluation improve the draft.",
                                          "sources": [p["id"] for p in excerpts]}]})

        self.ask.generate = generate
        answer = self.question(first, "How does reflection improve the draft?")
        self.assertEqual(answer["status"], "answered")
        self.assertEqual(answer["coverage"], {"saved": 2, "keyword": 2, "semantic": 2})
        self.assertEqual({s["lesson_id"] for s in answer["sources"]}, {first["id"], second["id"]})
        self.assertTrue(all(s["t"] == 12 for s in answer["sources"]))

    def test_reimport_preserves_vectors_but_edit_and_delete_remove_stale_evidence(self):
        lesson = self.lesson("course-a", "Search", "Reflection improves drafts.")
        self.assertTrue(self.ask.embed_batch())
        self.save(lesson, "Reflection improves drafts.")
        self.assertEqual(self.ask.coverage(lesson["course"]["id"])["semantic"], 1)
        self.save(lesson, "Planning decomposes tasks.")
        self.assertEqual(self.ask.coverage(lesson["course"]["id"])["semantic"], 0)
        self.assertEqual(self.question(lesson, "reflection")["status"], "insufficient_evidence")
        self.assertEqual(self.client.delete(f"/api/lessons/{lesson['id']}").status_code, 200)
        self.assertEqual(self.question(lesson, "planning")["status"], "missing_transcripts")
        with self.module.db() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM ask_fts").fetchone()[0], 0)

    def test_invalid_references_show_evidence_and_lesson_moves_invalidate_answer(self):
        source = self.lesson("course-a", "Workflow", "Feedback revises the draft.")
        target = self.lesson("course-b", "Notes")
        self.ask.generate = lambda *_: '{"items":[{"text":"A claim","sources":[999]}]}'
        answer = self.question(source, "feedback")
        self.assertEqual(answer["status"], "generation_unavailable")
        self.assertEqual(answer["sources"][0]["text"], "Feedback revises the draft.")

        def move_lesson(*_):
            with self.module.db() as c:
                c.execute("UPDATE lessons SET course_id=? WHERE id=?", (target["course"]["id"], source["id"]))
            return '{"items":[{"text":"Feedback revises the draft.","sources":[1]}]}'

        self.ask.generate = move_lesson
        self.assertEqual(self.question(source, "feedback")["status"], "source_changed")
        self.assertEqual(self.question(target, "feedback")["status"], "answered")

    def test_legacy_transcript_backfill_and_long_cue_partition(self):
        lesson = self.lesson("course-a", "Legacy")
        cues = [{"s": 1.0, "e": 31.0, "text": " ".join(f"word{i}" for i in range(950))},
                {"s": 32.0, "e": 50.0, "text": "And here is the ending."}]
        with self.module.db() as c:
            c.execute("UPDATE lessons SET transcript=? WHERE id=?", (json.dumps(cues), lesson["id"]))
        self.assertEqual(self.question(lesson, "ending")["status"], "index_pending")
        self.assertTrue(self.ask.backfill())
        chunks = make_chunks(cues, self.ask.paragraphs(cues), self.ask.encoder.count)
        self.assertTrue(all(self.ask.encoder.count(" ".join(p["text"] for p in chunk)) <= 450 for chunk in chunks))
        self.assertEqual(" ".join(p["text"] for chunk in chunks for p in chunk), " ".join(c["text"] for c in cues))
        self.assertEqual(chunks[-1][-1]["t"], 32.0)
