import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Chrome injects serialized functions without their module scope.
const source = fs.readFileSync(new URL('../extension/page.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, isFinite, window: { innerWidth: 1000, innerHeight: 800 } });
vm.runInContext(source.replaceAll('export ', ''), context);
const vtt = 'WEBVTT\n\n00:00.000 --> 00:02.000\nCurrent lecture\n';
const video = { clientWidth: 800, clientHeight: 450, currentTime: 12, duration: 60, paused: true,
  currentSrc: '', querySelectorAll: () => [], querySelector: () => null,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }) };
context.location = new URL('https://www.udemy.com/course/aws/learn/lecture/123?start=10#overview');
context.document = { title: 'AWS | Udemy', querySelectorAll: () => [video],
  querySelector: selector => selector.includes('course-taking')
    ? { getAttribute: () => '{"courseId":456}' } : null };
let page = context.probePage();
assert.equal(page.url, 'https://www.udemy.com/course/aws/learn/lecture/123');
assert.equal(page.courseSlug, 'udemy-aws');
assert.equal(page.title, 'Lecture 123');
context.location = new URL('https://www.udemy.com/course/aws/?couponCode=TEST');
assert.equal(context.probePage().hasVideo, false, 'promotional previews are not lectures');
context.location = new URL('https://www.udemy.com/course/aws/learn/lecture/123');
const requests = [];
context.fetch = async url => {
  requests.push(url);
  return { ok: true, text: async () => url.startsWith('/api-2.0/')
    ? JSON.stringify({ asset: { captions: [
      { locale_id: 'fr_FR', url: 'https://captions.example/fr.vtt' },
      { locale_id: 'en_US', url: 'https://captions.example/current.vtt' },
    ] } }) : vtt };
};
assert.equal((await context.fetchTranscript()).vtt, vtt);
assert(requests[0].includes('/456/lectures/123/'), 'request the current lecture, never a prior resource');
assert.equal(requests[1], 'https://captions.example/current.vtt', 'prefer English captions');
context.fetch = async () => ({ ok: true, text: async () => '{"asset":{"captions":[]}}' });
assert.match((await context.fetchTranscript()).error, /No captions/);
context.fetch = async () => ({ ok: false, status: 403 });
assert.match((await context.fetchTranscript()).error, /403/);

context.location = new URL('https://learn.deeplearning.ai/courses/agentic-ai/lesson/id/welcome!');
context.document.querySelectorAll = selector => selector === 'video' ? [video] : [];
context.document.title = 'Agentic AI - DeepLearning.AI';
page = context.probePage();
assert.equal(page.courseSlug, 'agentic-ai');
assert.equal(page.title, 'Welcome!');
video.querySelectorAll = () => [{ srclang: 'en', src: 'https://captions.example/dlai.vtt' }];
context.fetch = async () => ({ ok: true, text: async () => vtt });
assert.equal((await context.fetchTranscript()).vtt, vtt, 'native captions still work');
video.querySelectorAll = () => [];
video.currentSrc = 'https://video.example/master.m3u8';
context.fetch = async url => ({ ok: true, text: async () => url.endsWith('master.m3u8')
  ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="en",URI="captions.vtt"' : vtt });
assert.equal((await context.fetchTranscript()).src, 'https://video.example/captions.vtt');
console.log('Page adapter tests passed: Udemy identity/captions/errors and DeepLearning.AI native/HLS captions.');
