"""Exercise exhaustive coverage, immutable evidence, imports, and durable attempts."""
import importlib.util
import json
import os
import re
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


class QuizAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="study-quiz-tests-")
        with sqlite3.connect(Path(cls.temp.name)/'notes.db') as c:
            c.execute('CREATE TABLE course_curricula (course_id INTEGER PRIMARY KEY,platform_course_id TEXT,item_count INTEGER,synced REAL)')
            c.execute("INSERT INTO course_curricula VALUES (999,'123',5,1)")
        with patch.dict(os.environ, {"NOTES_DATA": cls.temp.name, "QUIZ_WORKER_ENABLED": "0"}):
            spec = importlib.util.spec_from_file_location("quiz_test_app", Path(__file__).parents[1] / "server/app.py")
            cls.app = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.app)
        with cls.app.db() as c:
            cls.migrated_platform=c.execute('SELECT platform FROM course_curricula WHERE course_id=999').fetchone()[0]
        cls.client = TestClient(cls.app.app)

    def setUp(self):
        with self.app.db() as c:
            for table in ("quiz_responses", "quiz_attempts", "quiz_questions", "quiz_source_fts", "quiz_sources", "quizzes",
                          "transcript_import_items", "transcript_imports", "curriculum_items", "course_sections", "course_curricula",
                          "card_reviews", "cards", "notes", "answers", "jobs", "fts", "lessons", "courses"):
                c.execute("DELETE FROM " + table)
        self.payload = {"platform_course_id": "123", "course_slug": "udemy-aws", "course_title": "AWS",
                        "complete": True, "item_count": 5, "sections": [{"id": "10", "title": "IAM", "items": [
                            {"id": "101", "title": "Users", "kind": "video"},
                            {"id": "102", "title": "CLI", "kind": "video"},
                            {"id": "103", "title": "Reading", "kind": "article"},
                            {"id": "104", "title": "Original quiz", "kind": "quiz"}]}]}
        self.synced = self.client.put("/api/curriculum", json=self.payload).json()
        self.cid = self.synced["course_id"]
        self.sid = self.synced["sections"][0]["id"]
        self.lessons = [self.save_lesson(i) for i in (101, 102)]
        self.calls = []

    def save_lesson(self, number, text=None):
        lesson = self.client.post("/api/lessons/resolve", json={
            "url": f"https://www.udemy.com/course/aws/learn/lecture/{number}", "title": f"Lesson {number}",
            "course_slug": "udemy-aws", "course": "AWS", "module": "wrong DOM heading",
        }).json()
        response = self.client.put(f"/api/lessons/{lesson['id']}/transcript", json={
            "vtt": "WEBVTT\n\n00:00:01.000 --> 00:00:33.000\n" + (text or f"Concept {number} teaches access control and least privilege.") + "\n"})
        self.assertEqual(response.status_code, 200)
        return lesson

    def create(self, **overrides):
        body = {"request_id": uuid.uuid4().hex, "course_id": self.cid, "section_ids": [self.sid], "count": 4, **overrides}
        response = self.client.post("/api/quizzes", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def model(self, prompt, material, *args):
        self.calls.append((prompt, material))
        if "Extract up to" in prompt:
            return '["least privilege", "access policies", "secure credentials"]'
        if "Assess the student" in prompt:
            return '{"score":1,"feedback":"Correct idea; explain the permission boundary."}'
        data = json.loads(material)
        if "Validate the proposed" in prompt:
            return json.dumps([{"topic_key": q["topic_key"], "supported": True} for q in data["questions"]])
        return json.dumps([{"topic_key": t["topic_key"], "question": "Explain " + t["topic_key"],
                            "answer": "Use least privilege.", "explanation": "Limit access to what is needed.",
                            "choices": ["Least privilege", "Full access", "Shared credentials", "No policies"], "correct_index": 0,
                            "source_ids": [t["required_source"]]} for t in data["tasks"]])

    def generate(self, quiz):
        with self.app.db() as c:
            c.execute("UPDATE quizzes SET status='running' WHERE id=?", (quiz["id"],))
        with patch.object(self.app, "llm", side_effect=self.model):
            self.app.run_quiz_generation(quiz["id"])
        return self.client.get("/api/quizzes/" + quiz["id"]).json()

    def start(self, quiz, **extra):
        response = self.client.post(f"/api/quizzes/{quiz['id']}/attempts", json={"request_id": uuid.uuid4().hex, **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_inventory_rejects_partial_and_duplicate_pages_without_overwriting(self):
        bad = {**self.payload, "complete": False}
        self.assertEqual(self.client.put("/api/curriculum", json=bad).status_code, 400)
        bad = {**self.payload, "item_count": 6}
        self.assertEqual(self.client.put("/api/curriculum", json=bad).status_code, 400)
        bad = json.loads(json.dumps(self.payload))
        bad["sections"][0]["items"][1]["id"] = "101"
        self.assertEqual(self.client.put("/api/curriculum", json=bad).status_code, 400)
        self.assertEqual(self.client.get("/api/quiz-scopes").json()[0]["sections"][0]["videos"], 2)

    def test_stable_ids_override_dom_headings_and_survive_section_rename(self):
        self.assertEqual(self.lessons[0]["module"], "IAM")
        self.payload["sections"][0]["title"] = "IAM and CLI"
        renamed = self.client.put("/api/curriculum", json=self.payload).json()
        self.assertEqual(renamed["sections"][0]["id"], self.sid)
        lesson = self.client.get(f"/api/lessons/{self.lessons[0]['id']}").json()
        self.assertEqual(lesson["module"], "IAM and CLI")

    def test_missing_transcripts_block_complete_quiz_and_partial_requires_opt_in(self):
        with self.app.db() as c:
            c.execute("UPDATE lessons SET transcript='' WHERE id=?", (self.lessons[1]["id"],))
        response = self.client.post('/api/quizzes', json={"request_id":"missing","course_id":self.cid,"count":5})
        self.assertEqual(response.status_code, 409)
        partial = self.create(allow_partial=True)
        self.assertEqual(len(partial["omissions"]), 1)
        self.assertEqual(partial["lessons"], 1)
        self.assertEqual(self.generate(partial)["status"], "partial")

    def test_all_ten_transcripts_are_processed_and_represented(self):
        self.payload["sections"][0]["items"] = [{"id":str(i),"title":f"Topic {i}","kind":"video"} for i in range(101,111)]
        self.payload["item_count"] = 11
        self.client.put('/api/curriculum', json=self.payload)
        for i in range(103,111): self.save_lesson(i)
        quiz = self.create(count=10)
        result = self.generate(quiz)
        self.assertEqual((result["processed_chunks"],result["represented"],result["question_count"]),(10,10,10))
        self.assertEqual(result["status"],"ready")
        self.assertEqual(sum("Extract up to" in p for p,_ in self.calls),10)

    def test_limited_question_count_does_not_claim_full_coverage(self):
        result = self.generate(self.create(count=1))
        self.assertEqual(result["status"], "partial")
        self.assertEqual((result["processed_chunks"],result["represented"],result["lessons"]),(2,1,2))

    def test_evidence_is_immutable_and_questions_do_not_disappear_on_source_deletion(self):
        quiz = self.create()
        with self.app.db() as c:
            c.execute("UPDATE lessons SET transcript='changed' WHERE id=?",(self.lessons[0]["id"],))
        result = self.generate(quiz)
        self.assertTrue(result["coverage"][0]["source_changed"])
        self.assertTrue(any("Concept 101" in material for _,material in self.calls))
        self.client.delete(f"/api/lessons/{self.lessons[0]['id']}")
        attempt = self.start(quiz)
        self.assertEqual(attempt["total"],4)

    def test_creation_retries_are_idempotent_and_reject_changed_config(self):
        first = self.create(request_id="retry")
        second = self.create(request_id="retry")
        self.assertEqual(first["id"],second["id"])
        response = self.client.post('/api/quizzes',json={"request_id":"retry","course_id":self.cid,"section_ids":[self.sid],"count":5})
        self.assertEqual(response.status_code,409)

    def test_resume_reuses_topics_and_existing_questions(self):
        quiz = self.create()
        self.generate(quiz)
        before = len(self.calls)
        self.generate(quiz)
        self.assertEqual(len(self.calls),before)
        result = self.client.get('/api/quizzes/'+quiz['id']).json()
        self.assertEqual(result['question_count'],4)

    def test_mcq_attempts_hide_answers_grade_deterministically_and_preserve_history(self):
        quiz = self.create(count=2,kind="mcq")
        self.generate(quiz)
        attempt = self.start(quiz)
        self.assertNotIn("answer",attempt["questions"][0])
        for index,q in enumerate(attempt["questions"]):
            path = f"/api/quiz-attempts/{attempt['id']}/responses/{q['id']}"
            saved = self.client.put(path,json={"answer":"","choice":index,"expected_version":0}).json()
            result = self.client.post(path+'/check',json={"expected_version":saved["version"]})
            self.assertEqual(result.status_code,200,result.text)
            self.assertEqual(result.json()["score"],2 if index == 0 else 0)
        finished = self.client.post(f"/api/quiz-attempts/{attempt['id']}/finish").json()
        self.assertEqual((finished["status"],finished["score"]),("completed",2))
        self.assertIn('sources',finished['questions'][0])
        retry = self.start(quiz)
        self.assertNotEqual(attempt['id'],retry['id'])
        self.assertEqual(retry['answered'],0)
        missed = self.start(quiz,missed_from=attempt['id'])
        self.assertEqual(missed['total'],1)
        self.assertEqual(self.client.get('/api/quiz-attempts/'+attempt['id']).json()['score'],2)

    def test_drafts_are_durable_and_stale_tabs_cannot_overwrite(self):
        quiz = self.create(count=2)
        self.generate(quiz)
        a = self.start(quiz)
        q = a['questions'][0]
        path = f"/api/quiz-attempts/{a['id']}/responses/{q['id']}"
        result = self.client.put(path,json={"answer":"My draft","expected_version":0})
        self.assertEqual(result.json()['version'],1)
        self.assertEqual(self.client.get('/api/quiz-attempts/'+a['id']).json()['questions'][0]['response']['answer'],'My draft')
        self.assertEqual(self.client.put(path,json={"answer":"stale edit","expected_version":0}).status_code,409)
        self.assertEqual(self.client.post(f"/api/quiz-attempts/{a['id']}/finish").status_code,409)
        with patch.object(self.app,'llm',side_effect=self.model):
            self.assertEqual(self.client.post(path+'/check',json={"expected_version":1}).json()['score'],1)
        self.assertEqual(self.client.put(path,json={"answer":"overwrite checked","expected_version":1}).status_code,409)

    def test_import_lease_and_success_require_an_actually_saved_transcript(self):
        with self.app.db() as c:
            c.execute("UPDATE lessons SET transcript='' WHERE id=?",(self.lessons[1]['id'],))
        job = self.client.post('/api/transcript-imports',json={'section_ids':[self.sid]}).json()
        self.assertEqual(job['total'],1)
        claim = self.client.post('/api/transcript-imports/claim?course_slug=udemy-aws').json()
        self.assertIsNone(self.client.post('/api/transcript-imports/claim?course_slug=udemy-aws').json())
        path = f"/api/transcript-imports/{job['id']}/items/{job['items'][0]['item_id']}"
        self.assertEqual(self.client.post(path,json={'lease':'wrong','status':'saved'}).status_code,409)
        self.assertEqual(self.client.post(path,json={'lease':claim['lease'],'status':'saved'}).status_code,400)
        self.save_lesson(102)
        self.assertEqual(self.client.post(path,json={'lease':claim['lease'],'status':'saved'}).json()['status'],'done')

    def test_lesson_and_attempt_scope_cannot_leak_between_quizzes(self):
        q1 = self.create(count=2)
        q2 = self.create(count=2)
        self.generate(q1); self.generate(q2)
        a1,a2 = self.start(q1),self.start(q2)
        wrong = a2['questions'][0]['id']
        self.assertEqual(self.client.put(f"/api/quiz-attempts/{a1['id']}/responses/{wrong}",json={'answer':'x','expected_version':0}).status_code,404)
        self.assertEqual(self.client.post(f"/api/quizzes/{q1['id']}/attempts",json={'request_id':uuid.uuid4().hex,'missed_from':a2['id']}).status_code,400)

    def test_unsupported_questions_are_rejected_instead_of_filling_the_quota(self):
        quiz = self.create(count=2)
        original = self.model
        def reject(prompt, material, *args):
            if "Validate the proposed" in prompt:
                return json.dumps([{"topic_key":q['topic_key'],"supported":False} for q in json.loads(material)['questions']])
            return original(prompt,material,*args)
        with self.app.db() as c:c.execute("UPDATE quizzes SET status='running' WHERE id=?",(quiz['id'],))
        with patch.object(self.app,'llm',side_effect=reject):self.app.run_quiz_generation(quiz['id'])
        result=self.client.get('/api/quizzes/'+quiz['id']).json()
        self.assertEqual((result['question_count'],result['status']),(0,'error'))

    def test_a_long_transcript_is_fully_snapshotted_and_every_chunk_is_processed(self):
        long_text='A useful access-control teaching point. '*1000
        self.save_lesson(101,long_text)
        quiz=self.create(count=2)
        with self.app.db() as c:
            sources=c.execute('SELECT text FROM quiz_sources WHERE quiz_id=? AND lesson_id=? ORDER BY rowid',(quiz['id'],self.lessons[0]['id'])).fetchall()
        recovered=''.join(re.sub(r'(?m)^\[[^]]+\] ','',r[0]).replace('\n','') for r in sources)
        self.assertEqual(recovered,long_text.strip())
        result=self.generate(quiz)
        self.assertGreater(result['chunks'],2)
        self.assertEqual(result['processed_chunks'],result['chunks'])

    def test_grading_cannot_overwrite_an_answer_changed_during_the_model_call(self):
        quiz=self.create(count=2)
        self.generate(quiz)
        a=self.start(quiz);q=a['questions'][0]
        path=f"/api/quiz-attempts/{a['id']}/responses/{q['id']}"
        self.client.put(path,json={'answer':'Original answer','expected_version':0})
        def race(*args):
            self.client.put(path,json={'answer':'Newer answer','expected_version':1})
            return '{"score":2,"feedback":"Old feedback"}'
        with patch.object(self.app,'llm',side_effect=race):
            self.assertEqual(self.client.post(path+'/check',json={'expected_version':1}).status_code,409)
        answer=self.client.get('/api/quiz-attempts/'+a['id']).json()['questions'][0]['response']
        self.assertEqual(answer['answer'],'Newer answer')
        self.assertIsNone(answer['feedback'])

    def dlai_payload(self):
        return {'platform':'deeplearning','platform_course_id':'10074','course_slug':'agentic-ai','course_title':'Agentic AI',
                'complete':True,'item_count':7,'sections':[
                    {'id':'module-1','title':'Module 1: Foundations','items':[
                        {'id':'intro','title':'Welcome!','kind':'video','url':'https://learn.deeplearning.ai/courses/agentic-ai/lesson/intro/welcome!'},
                        {'id':'reading','title':'Reading','kind':'article','url':'https://learn.deeplearning.ai/courses/agentic-ai/lesson/reading/reading'},
                        {'id':'quiz','title':'Module quiz','kind':'quiz','url':'https://learn.deeplearning.ai/courses/agentic-ai/lesson/quiz/module-quiz'}]},
                    {'id':'module-2','title':'Module 2: Reflection','items':[
                        {'id':'reflect','title':'Reflection','kind':'video','url':'https://learn.deeplearning.ai/courses/agentic-ai/lesson/reflect/reflection'},
                        {'id':'lab','title':'Lab','kind':'other','url':'https://learn.deeplearning.ai/courses/agentic-ai/lesson/lab/lab'}]}]}

    def test_deeplearning_inventory_preserves_existing_lessons_by_id(self):
        self.assertEqual(self.migrated_platform,'udemy')
        old=self.client.post('/api/lessons/resolve',json={'url':'https://learn.deeplearning.ai/courses/agentic-ai/lesson/intro/old-title%3f',
            'title':'Old title','course_slug':'agentic-ai','course':'Agentic AI','module':'Module 1'}).json()
        self.client.put(f"/api/lessons/{old['id']}/transcript",json={'vtt':'WEBVTT\n\n00:00:01.000 --> 00:00:33.000\nPlan agentic workflows and evaluate their results.\n'})
        with self.app.db() as c:
            c.execute('INSERT INTO notes(id,lesson_id,kind,text,draft) VALUES (?,?,?,?,0)',('dlai-kept-note',old['id'],'text','Keep this personal note'))
        synced=self.client.put('/api/curriculum',json=self.dlai_payload())
        self.assertEqual(synced.status_code,200,synced.text)
        sections=synced.json()['sections']
        self.assertEqual((sections[0]['available'],sections[0]['videos']),(1,1))
        found=self.client.get('/api/lessons/by-url',params={'url':self.dlai_payload()['sections'][0]['items'][0]['url']}).json()
        self.assertEqual(found['id'],old['id'])
        self.assertEqual(found['notes'][0]['text'],'Keep this personal note')
        renamed=self.client.post('/api/lessons/resolve',json={'url':self.dlai_payload()['sections'][0]['items'][0]['url'],
            'title':'Welcome!','course_slug':'agentic-ai','course':'Agentic AI','module':'wrong DOM label'}).json()
        self.assertEqual(renamed['id'],old['id'])
        self.assertEqual(renamed['module'],'Module 1: Foundations')
        self.assertTrue(renamed['has_transcript'])
        with self.app.db() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM lessons WHERE course_id=?',(synced.json()['course_id'],)).fetchone()[0],1)
        q=self.create(course_id=synced.json()['course_id'],section_ids=[sections[0]['id']],count=1)
        self.assertEqual(self.generate(q)['status'],'ready')

    def test_deeplearning_import_claim_contains_provider_and_exact_lesson_url(self):
        synced=self.client.put('/api/curriculum',json=self.dlai_payload()).json()
        sid=synced['sections'][1]['id']
        job=self.client.post('/api/transcript-imports',json={'section_ids':[sid]}).json()
        self.assertEqual(job['total'],1,'labs are not treated as videos')
        claim=self.client.post('/api/transcript-imports/claim?course_slug=agentic-ai').json()
        self.assertEqual(claim['platform'],'deeplearning')
        self.assertEqual(claim['platform_course_id'],'10074')
        self.assertEqual(claim['items'][0]['external_id'],'reflect')
        self.assertIn('/lesson/reflect/',claim['items'][0]['url_key'])
        no_partial=self.client.post('/api/quizzes',json={'request_id':'dlai-missing','course_id':synced['course_id'],'count':10})
        self.assertEqual(no_partial.status_code,409)

    def test_deeplearning_rejects_foreign_or_mismatched_lesson_urls(self):
        for url in ('https://evil.example/courses/agentic-ai/lesson/intro/welcome!',
                    'https://learn.deeplearning.ai/courses/other/lesson/intro/welcome!',
                    'https://learn.deeplearning.ai/courses/agentic-ai/lesson/wrong/welcome!',
                    'https://learn.deeplearning.ai/courses/agentic-ai/lesson/intro/welcome!?token=x'):
            payload=self.dlai_payload();payload['sections'][0]['items'][0]['url']=url
            self.assertEqual(self.client.put('/api/curriculum',json=payload).status_code,400)
        self.assertFalse(any(s['slug']=='agentic-ai' for s in self.client.get('/api/quiz-scopes').json()))

    def test_deeplearning_module_resync_keeps_stable_section_identity(self):
        payload=self.dlai_payload()
        first=self.client.put('/api/curriculum',json=payload).json()
        payload['sections'][0]['title']='Module 1: New title'
        second=self.client.put('/api/curriculum',json=payload).json()
        self.assertEqual(first['sections'][0]['id'],second['sections'][0]['id'])
        scope=next(c for c in self.client.get('/api/quiz-scopes').json() if c['slug']=='agentic-ai')
        self.assertEqual(scope['inventory']['platform'],'deeplearning')
        self.assertEqual(len(scope['sections']),2)


if __name__ == '__main__':
    unittest.main()
