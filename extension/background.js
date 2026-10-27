import {
  activeTab, addBookmark, addNote, api, captureAndDraw, captureVideo, control, enqueue, flush, fmtT, probe, saveQuote, settings,
  syncTranscript, toast, syncCourseSections, udemyCaption,
} from "./lib.js";
import { isSupportedSite, isLessonUrl } from "./sites.js";

// Handle the action ourselves so Chrome grants activeTab for screenshots as well
// as opening the tab's panel. The built-in panel toggle does not grant it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener((tab) => {
  if (isSupportedSite(tab.url)) chrome.sidePanel.open({ tabId: tab.id }).catch(console.warn);
});

// No global panel: each supported tab opts in independently. Chrome hides that
// tab's panel when switching to another site and restores it on return.
const panelReady = chrome.sidePanel.setOptions({ enabled: false });
async function updatePanel(tabId) {
  await panelReady;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const enabled = isSupportedSite(tab.url);
  await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled });
  await chrome.action[enabled ? "enable" : "disable"](tabId);
}
chrome.tabs.onActivated.addListener(({ tabId }) => updatePanel(tabId).catch(console.warn));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === "loading" || info.status === "complete") updatePanel(tabId).catch(console.warn);
});
chrome.tabs.query({}).then((tabs) => Promise.all(tabs.map((tab) => updatePanel(tab.id)))).catch(console.warn);

// Retry unsynced notes every minute (e.g. after the Pi was offline).
chrome.alarms.create("flush", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "flush") { flush(); processCourseImports(); } });
chrome.runtime.onStartup.addListener(() => flush());

let importing = false;
async function processCourseImports() {
  if (importing) return;
  importing = true;
  try {
    const tabs = await chrome.tabs.query({ url: ["https://*.udemy.com/course/*"] });
    for (const tab of tabs) {
      const p = await probe(tab.id);
      if (!p?.courseSlug?.startsWith("udemy-")) continue;
      const job = await api(`/api/transcript-imports/claim?course_slug=${encodeURIComponent(p.courseSlug)}`, { method: "POST" });
      if (!job) continue;
      for (const item of job.items.filter(i => i.status === "pending")) {
        let status = "saved", error = "";
        try {
          const caption = await udemyCaption(tab.id, job.platform_course_id, item.external_id);
          if (caption?.error) {
            status = caption.noCaptions ? "no_captions" : "error";
            error = caption.error;
          } else {
            const lesson = await api("/api/lessons/resolve", { method: "POST", body: {
              url: item.url_key, title: item.title, course: p.course, course_slug: p.courseSlug, module: item.section_title,
            } });
            await api(`/api/lessons/${lesson.id}/transcript`, { method: "PUT", body: caption, timeout: 30000 });
          }
        } catch (e) { status = "error"; error = e.message; }
        await api(`/api/transcript-imports/${job.id}/items/${item.item_id}`, { method: "POST", body: { lease: job.lease, status, error } });
      }
    }
  } catch (e) { console.warn("Course caption import will retry:", e.message); }
  finally { importing = false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === "sync-course-sections") {
    (async () => {
      try {
        const p = await probe(message.tabId);
        respond({ result: await syncCourseSections(message.tabId, p) });
        processCourseImports();
      } catch (e) { respond({ error: e.message }); }
    })();
    return true;
  }
  if (message.type === "check-course-imports") {
    processCourseImports();
    respond({ ok: true });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (!tab?.id || !isSupportedSite(tab.url)) return;
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
const autoSaving = new Map(); // tabId -> lesson URL being saved
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if ((info.url || info.status === "complete") && isLessonUrl(tab.url)) autoSaveTranscript(tabId, tab.url);
  if (info.status === "complete" && /^https:\/\/[^/]*udemy\.com\/course\//.test(tab.url || "")) processCourseImports();
});

async function autoSaveTranscript(tabId, url) {
  if (autoSaving.get(tabId) === url || !(await settings()).autoTranscript) return;
  autoSaving.set(tabId, url); // a newer lesson in the same tab supersedes an older loop
  try {
    // The video and its playlist load a little after the page; retry for ~30 s.
    for (let i = 0; i < 15 && autoSaving.get(tabId) === url; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!(await settings()).autoTranscript) return;
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
