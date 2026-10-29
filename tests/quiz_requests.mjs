import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const appSource = fs.readFileSync(new URL('../server/static/ui/app.js', import.meta.url), 'utf8');
const quizSource = fs.readFileSync(new URL('../server/static/ui/quizzes.js', import.meta.url), 'utf8');
const listeners = {}, requests = [], routes = [], errors = [];
const elements = {
  '#q-mode': { value: 'sections' }, '#q-count': { value: '4' },
  '#q-title': { value: 'IAM revision' }, '#q-kind': { value: 'written' },
  '#q-partial': { checked: false }, '#q-scope': {}, '#q-sections': {},
  '#q-lessons': {}, '#q-coverage': {}, '#q-missing': {}, '#q-import': {},
  '#q-import-hint': {}, '#q-imports': {}, '#q-create-status': {},
};
const savedQuiz = {
  id: 'quiz-1', title: 'IAM revision', status: 'ready', question_count: 1, requested: 1,
  processed_chunks: 1, chunks: 1, represented: 1, lessons: 1, scope: {},
  coverage: [], omissions: [], attempts: [],
};
const attempt = {
  id: 'attempt-1', quiz_id: savedQuiz.id, title: savedQuiz.title, status: 'completed',
  answered: 1, total: 1, score: 0, max_score: 2,
  questions: [{ id: 'question-1', kind: 'written', question: 'Explain IAM', answer: 'Access control',
    explanation: 'Manage permissions', sources: [], response: { feedback: { score: 0, feedback: 'Try again' } } }],
};
let failCreate = true;
const context = vm.createContext({
  // HTTP on a LAN provides getRandomValues but does not expose randomUUID.
  crypto: { getRandomValues: values => webcrypto.getRandomValues(values) },
  document: {
    addEventListener: (name, handler) => { listeners[name] = handler; },
    querySelector: selector => elements[selector] ?? null,
    querySelectorAll: selector => selector === 'input[name="q-section"]:checked' ? [{ value: '10' }] : [],
  },
  localStorage: { getItem: () => null }, URLSearchParams, setTimeout, clearTimeout,
  api: async (path, options) => {
    if (options) {
      requests.push({ path, ...options });
      if (path === '/api/quizzes' && failCreate) {
        failCreate = false;
        throw new Error('Connection lost');
      }
      return path === '/api/quizzes' ? savedQuiz : attempt;
    }
    if (path === '/api/quiz-scopes') return [{ id: 1, title: 'AWS', inventory: { synced: 1 },
      lessons: [{ id: 101, has_transcript: true }],
      sections: [{ id: 10, title: 'IAM', available: 1, videos: 1, items: [] }] }];
    if (path === '/api/quizzes' || path === '/api/transcript-imports') return [];
    if (path === '/api/quizzes/quiz-1') return savedQuiz;
    if (path === '/api/quiz-attempts/attempt-1') return attempt;
    throw new Error(`Unexpected endpoint: ${path}`);
  },
  esc: value => String(value ?? ''), icon: () => '', fmt: () => '', videoLink: () => '',
  setPage() {}, setBreadcrumb() {}, navigate: route => routes.push(route),
  toast: message => errors.push(message),
});
// Use the actual application ID generator and workspace wiring.
vm.runInContext(appSource.slice(appSource.indexOf('const uid ='), appSource.indexOf('const safeUrl =')), context);
vm.runInContext(quizSource.replace('export function', 'function'), context);
vm.runInContext(appSource.match(/^const quizWorkspace = createQuizWorkspace\([^\n]+/m)[0], context);
const workspace = vm.runInContext('quizWorkspace', context);
const click = action => listeners.click({ target: { closest: () => ({ dataset: { quizAction: action }, isConnected: true }) } });

await workspace.load(new URLSearchParams());
await click('create');
assert.deepEqual(errors, ['Connection lost'], 'creation reaches the API over HTTP');
await click('create');
assert.equal(requests[0].body.request_id, requests[1].body.request_id, 'retry reuses the request ID');
assert.deepEqual(Array.from(requests[1].body.section_ids), [10]);
assert.equal(routes.at(-1), '#quizzes?quiz=quiz-1');
await click('create');
assert.notEqual(requests[2].body.request_id, requests[1].body.request_id, 'a new quiz gets a fresh ID');

await workspace.load(new URLSearchParams('quiz=quiz-1'));
await click('start');
await workspace.load(new URLSearchParams('attempt=attempt-1'));
await click('retake');
await click('missed');
assert.equal(requests.length, 6);
assert(requests.slice(3).every(request => request.path === '/api/quizzes/quiz-1/attempts'));
assert.equal(requests.at(-1).body.missed_from, 'attempt-1');
assert(requests.every(request => /^[0-9a-f]{32}$/.test(request.body.request_id)));
assert.equal(new Set(requests.map(request => request.body.request_id)).size, 5);
assert.deepEqual(errors, ['Connection lost'], 'no browser API errors in any quiz action');
await workspace.leave();
console.log('Quiz requests passed: HTTP creation, retry IDs, start, retake and missed questions.');
