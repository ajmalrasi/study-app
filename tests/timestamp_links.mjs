import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
let tick, stopped = false, replaced;
const location = { hash: '#sn_t=45', pathname: '/course/aws/learn/lecture/123', search: '' };
const video = { readyState: 0, currentTime: 0, duration: 120, clientWidth: 800, clientHeight: 450 };
const context = vm.createContext({ location, document: { querySelectorAll: () => [video] },
  window: { addEventListener() {} }, history: { replaceState: (_, __, url) => { replaced = url; } },
  setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { stopped = true; } });
vm.runInContext(source, context);
// Udemy rewrites the hash while loading, then restores an earlier playback position.
location.hash = '#overview';
tick();
assert.equal(video.currentTime, 0);
video.readyState = 4;
tick();
assert.equal(video.currentTime, 45);
video.currentTime = 14;
tick();
assert.equal(video.currentTime, 45, 'saved timestamp survives late resume restoration');
for (let i = 0; i < 4; i++) tick();
assert(stopped);
assert.equal(replaced, '/course/aws/learn/lecture/123#overview', 'preserve the site navigation hash');
console.log('Timestamp tests passed: early hash capture, delayed video, late resume and site hash preservation.');
