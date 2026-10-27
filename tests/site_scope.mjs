import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const siteSource = fs.readFileSync(new URL('../extension/sites.js', import.meta.url), 'utf8');
const { isSupportedSite, isLessonUrl } = await import('data:text/javascript;base64,' + Buffer.from(siteSource).toString('base64'));
for (const url of ['https://udemy.com/course/test', 'https://www.udemy.com/course/test',
  'https://company.udemy.com/course/test', 'https://learn.deeplearning.ai/courses/test']) assert(isSupportedSite(url));
for (const url of ['https://youtube.com/watch?v=1', 'https://mail.google.com/', 'http://udemy.com/',
  'https://udemy.com.evil.test/', 'https://fakeudemy.com/', 'chrome://extensions/', '', undefined]) assert(!isSupportedSite(url));
assert(isLessonUrl('https://www.udemy.com/course/aws/learn/lecture/123#overview'));
assert(isLessonUrl('https://learn.deeplearning.ai/courses/ai/lesson/1/welcome'));
assert(!isLessonUrl('https://www.udemy.com/course/aws/'));

const tabs = new Map([[1, { id: 1, url: 'https://www.udemy.com/course/aws/learn/lecture/123', active: false }],
  [2, { id: 2, url: 'https://mail.google.com/', active: true }]]);
const options = [], actions = [], events = { updated: [], activated: [], commands: [] };
let injected = 0, captured = 0, syncs = 0, autoTranscript = true;
const chrome = {
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {}, setOptions: async o => { options.push(o); } },
  action: { onClicked: { addListener() {} }, enable: async id => actions.push([id, true]), disable: async id => actions.push([id, false]) },
  tabs: { query: async q => [...tabs.values()].filter(t => !q.active || t.active),
    get: async id => tabs.get(id), onUpdated: { addListener: fn => events.updated.push(fn) },
    onActivated: { addListener: fn => events.activated.push(fn) }, captureVisibleTab: async () => { captured++; } },
  scripting: { executeScript: async () => { injected++; return [{ result: true }]; } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  runtime: { onStartup: { addListener() {} }, onMessage: { addListener() {} } },
  commands: { onCommand: { addListener: fn => events.commands.push(fn) } },
  windows: { onRemoved: { addListener() {} } },
};
const stripImports = s => s.replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, '').replaceAll('export ', '');
const ctx = vm.createContext({ chrome, URL, console, isSupportedSite, isLessonUrl,
  activeTab: async () => tabs.get(2), settings: async () => ({ autoTranscript }),
  probe: async () => ({ hasVideo: true }), syncTranscript: async () => { syncs++; return 'saved'; },
  // Run the auto-transcript delay immediately, without waiting in a unit test.
  setTimeout: fn => { fn(); }, flush() {}, toast() { throw new Error('must not inject on unsupported site'); } });
vm.runInContext(stripImports(fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8')), ctx);
for (let i = 0; i < 15; i++) await Promise.resolve();
assert(options.some(o => o.tabId == null && o.enabled === false), 'global panel disabled');
assert(options.some(o => o.tabId === 1 && o.enabled === true));
assert(options.some(o => o.tabId === 2 && o.enabled === false));
await events.commands[0]('screenshot');
assert.equal(injected, 0, 'unsupported shortcuts do nothing');
for (const event of events.updated) event(1, { status: 'complete' }, tabs.get(1));
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.equal(syncs, 1, 'supported background lessons still save transcripts');
autoTranscript = false;
tabs.get(1).url = 'https://www.udemy.com/course/aws/learn/lecture/124';
for (const event of events.updated) event(1, { status: 'complete' }, tabs.get(1));
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.equal(syncs, 1, 'automatic background capture can be disabled');
tabs.get(1).url = 'https://youtube.com/watch?v=123';
await events.activated[0]({ tabId: 1 });
assert.equal(options.at(-1).enabled, false, 'disable panel after navigating away');

const libCtx = vm.createContext({ chrome, URL, console, isSupportedSite });
vm.runInContext(stripImports(fs.readFileSync(new URL('../extension/lib.js', import.meta.url), 'utf8')), libCtx);
await assert.rejects(libCtx.run(2, () => true), /only works/);
await assert.rejects(libCtx.captureVideo({ id: 1, windowId: 1 }, {}), /Open the Udemy/);
assert.equal(injected, 0);
assert.equal(captured, 0, 'never capture the unrelated active tab');
const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
assert(!manifest.host_permissions.includes('<all_urls>'));
assert(manifest.permissions.includes('activeTab'));
console.log('Site scope tests passed: panel visibility, URL boundaries, unsupported shortcuts/injection/capture and background transcripts.');
