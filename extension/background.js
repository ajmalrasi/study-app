import {
  activeTab, addBookmark, addNote, api, captureAndDraw, captureVideo, control, enqueue, flush, fmtT, probe, saveQuote, settings,
  syncTranscript, toast,
} from "./lib.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Retry unsynced notes every minute (e.g. after the Pi was offline).
chrome.alarms.create("flush", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => a.name === "flush" && flush());
chrome.runtime.onStartup.addListener(() => flush());

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (!tab?.id) return;
  const p = await probe(tab.id);
  if (!p?.hasVideo) {
    toast(tab.id, "Study Notes: no video on this page");
    return;
  }
  try {
    if (command === "bookmark") {
      const { duplicate } = await addBookmark(tab, p);
      toast(tab.id, duplicate ? `⭐ Already bookmarked here` : `⭐ Bookmarked ${fmtT(p.t)}`);
    } else if (command === "screenshot") {
      await addNote(tab, p, { kind: "shot", image: await captureVideo(tab, p) });
      toast(tab.id, `📷 Screenshot at ${fmtT(p.t)}`);
    } else if (command === "draw") {
      await captureAndDraw(tab, p);
    } else if (command === "quick-note") {
      await quickNote(tab, p);
    } else if (command === "quote") {
      const said = await saveQuote(tab, p);
      toast(tab.id, `💬 Saved quote at ${fmtT(said[0].s)}`);
    }
  } catch (e) {
    console.error(e);
    toast(tab.id, `Study Notes error: ${e.message}`);
  }
  syncTranscript(tab, p);
});

// Closing a drawing window resumes the video it paused, and throws away a new drawing that was
// never saved (nothing is kept unless you click Save).
chrome.windows.onRemoved.addListener(async (winId) => {
  const { drawingWindows = {} } = await chrome.storage.local.get("drawingWindows");
  const w = drawingWindows[winId];
  if (!w) return;
  delete drawingWindows[winId];
  await chrome.storage.local.set({ drawingWindows });
  if (w.resumeTabId != null && (await settings()).resumeAfterDraw) control(w.resumeTabId, "play");
  if (w.draft) {
    try {
      const note = await api(`/api/notes/${w.noteId}`);
      if (note.draft) await enqueue({ type: "delete", id: w.noteId });
    } catch { /* already gone */ }
  }
});

// Save every lesson's transcript as soon as its video loads, notes or not.
const LESSON_URL = /^https:\/\/(?:learn\.deeplearning\.ai\/courses\/[^/]+\/lesson\/|(?:[a-z0-9-]+\.)?udemy\.com\/course\/[^/]+\/learn\/lecture\/)/;
const autoSaving = new Map(); // tabId -> lesson URL being saved
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if ((info.url || info.status === "complete") && LESSON_URL.test(tab.url || "")) autoSaveTranscript(tabId, tab.url);
});

async function autoSaveTranscript(tabId, url) {
  if (autoSaving.get(tabId) === url || !(await settings()).autoTranscript) return;
  autoSaving.set(tabId, url); // a newer lesson in the same tab supersedes an older loop
  try {
    // The video and its playlist load a little after the page; retry for ~30 s.
    for (let i = 0; i < 15 && autoSaving.get(tabId) === url; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.url !== url) return;
      const p = await probe(tabId);
      if (!p?.hasVideo) continue;
      if ((await syncTranscript(tab, p)) !== "retry") return;
    }
  } finally {
    if (autoSaving.get(tabId) === url) autoSaving.delete(tabId);
  }
}

async function quickNote(tab, p) {
  const { pauseOnNote } = await settings();
  const resume = pauseOnNote && !p.paused;
  if (resume) await control(tab.id, "pause");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["overlay.js"] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (label) => window.__studyNotesOverlay(label),
    args: [`Note at ${fmtT(p.t)}`],
  });
  const out = res?.result;
  if (out?.text) {
    await addNote(tab, p, { kind: out.important ? "bookmark" : "text", text: out.text });
    toast(tab.id, "📝 Saved");
  }
  if (resume) await control(tab.id, "play");
}
