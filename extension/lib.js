// Shared by the service worker and the side panel: settings, server API, page access,
// screenshots and the offline queue.
import { probePage, controlVideo, fetchTranscript, videoTime } from "./page.js";

export const DEFAULTS = { serverUrl: "http://192.168.3.20:8765", pauseOnNote: true, autoTranscript: true, resumeAfterDraw: true };

export async function settings() {
  const s = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(s.settings || {}) };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set({ settings: { ...(await settings()), ...patch } });
}

export const urlKey = (url) => url.replace(/[?#].*$/, "").replace(/\/$/, "");

export function fmtT(t) {
  if (t == null) return "";
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}

export async function api(path, opts = {}) {
  const { serverUrl } = await settings();
  const res = await fetch(serverUrl + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
    signal: opts.signal || AbortSignal.timeout(opts.timeout || 15000),
  });
  if (!res.ok) {
    const err = new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------- page access ----------

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function run(tabId, func, args = [], world = "MAIN") {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  return res?.result;
}

export const probe = (tabId) => run(tabId, probePage).catch(() => null);
export const control = (tabId, action, value) => run(tabId, controlVideo, [action, value]).catch(() => false);
export const transcript = (tabId) => run(tabId, fetchTranscript);
export const currentTime = (tabId) => run(tabId, videoTime).catch(() => null);

/** WebVTT text -> [{s, e, text}] (seconds). Mirrors the server's parser. */
export function parseVtt(vtt) {
  const secs = (ts) => ts.replace(",", ".").split(":").reverse().reduce((sum, p, i) => sum + parseFloat(p) * 60 ** i, 0);
  const cues = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.trim().split("\n");
    const i = lines.findIndex((l) => /-->/.test(l));
    if (i < 0) continue;
    const m = lines[i].match(/([\d:.,]+)\s+-->\s+([\d:.,]+)/);
    const text = lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (m && text) cues.push({ s: secs(m[1]), e: secs(m[2]), text });
  }
  return cues;
}

export function lessonInfo(p) {
  return { url: p.url, title: p.title, course: p.course, course_slug: p.courseSlug, module: p.module, duration: p.duration };
}

export async function toast(tabId, text) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [text],
    func: (msg) => {
      const el = Object.assign(document.createElement("div"), { textContent: msg });
      el.style.cssText = "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:2147483647;" +
        "background:rgba(20,20,22,.92);color:#fff;font:600 14px/1.4 system-ui,sans-serif;padding:10px 16px;" +
        "border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none;transition:opacity .3s";
      document.documentElement.appendChild(el);
      setTimeout(() => (el.style.opacity = "0"), 1400);
      setTimeout(() => el.remove(), 1800);
    },
  }).catch(() => {});
}

function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buf) => {
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type};base64,${btoa(bin)}`;
  });
}

/** Screenshot of the visible tab, cropped to the video player. */
export async function captureVideo(tab, p) {
  const full = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(full)).blob());
  const scale = bmp.width / p.viewport.w;
  const r = p.rect;
  const x = Math.max(0, Math.round(r.x * scale)), y = Math.max(0, Math.round(r.y * scale));
  const w = Math.min(bmp.width - x, Math.round(r.w * scale)), h = Math.min(bmp.height - y, Math.round(r.h * scale));
  const ok = w > 50 && h > 50;
  const canvas = new OffscreenCanvas(ok ? w : bmp.width, ok ? h : bmp.height);
  canvas.getContext("2d").drawImage(bmp, ok ? x : 0, ok ? y : 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 }));
}

// ---------- offline queue ----------
// Every write goes to chrome.storage first, then syncs. Notes carry client ids, so a retry
// after a timeout can't create duplicates.

export const newId = () => crypto.randomUUID().replace(/-/g, "");

export async function queued() {
  return (await chrome.storage.local.get("queue")).queue || [];
}

export async function enqueue(op) {
  await navigator.locks.request("sn-queue", async () => {
    const q = await queued();
    q.push({ opId: newId(), ...op });
    await chrome.storage.local.set({ queue: q });
  });
  notifyChanged();
  return flush();
}

let flushing = null;
export function flush() {
  flushing ??= navigator.locks.request("sn-queue-flush", async () => {
    let synced = 0, error = null, q;
    // Re-read after each pass so ops queued while syncing go out in the same flush.
    while (!error && (q = await queued()).length) for (const op of q) {
      try {
        if (op.type === "note") await api("/api/notes", { method: "POST", body: op.note });
        if (op.type === "patch") await api(`/api/notes/${op.id}`, { method: "PATCH", body: op.patch });
        if (op.type === "delete") await api(`/api/notes/${op.id}`, { method: "DELETE" });
      } catch (e) {
        if (e.status === 404 && op.type !== "note") {
          // Note no longer exists on the server; drop the op.
        } else if (e.status >= 400 && e.status < 500) {
          console.warn("dropping rejected op", op, e);
        } else {
          error = e;
          break; // server unreachable: keep order, retry later
        }
      }
      await navigator.locks.request("sn-queue", async () => {
        const q = await queued();
        await chrome.storage.local.set({ queue: q.filter((x) => x.opId !== op.opId) });
      });
      synced++;
    }
    if (synced) notifyChanged();
    return { synced, error, pending: (await queued()).length };
  }).finally(() => (flushing = null));
  return flushing;
}

export function notifyChanged() {
  // runtime messages never reach the page that sent them, so also tell this page directly.
  chrome.runtime.sendMessage({ type: "notes-changed" }).catch(() => {});
  globalThis.dispatchEvent?.(new Event("sn-changed"));
}

// ---------- high-level actions (hotkeys and side panel) ----------

/** Bookmark unless there's already one within 2 s of this moment (repeated clicks). */
export async function addBookmark(tab, p) {
  const key = urlKey(p.url);
  const near = (t) => t != null && Math.abs(t - p.t) < 2;
  const pending = (await queued()).some((o) => o.type === "note" && o.key === key && o.note.kind === "bookmark" && near(o.note.t));
  let saved = false;
  if (!pending) {
    try {
      const lesson = await api(`/api/lessons/by-url?url=${encodeURIComponent(p.url)}`, { timeout: 3000 });
      saved = lesson.notes.some((n) => n.kind === "bookmark" && near(n.t));
    } catch { /* no lesson yet, or offline */ }
  }
  if (pending || saved) return { duplicate: true };
  return addNote(tab, p, { kind: "bookmark" });
}

export async function addNote(tab, p, fields) {
  const note = { id: newId(), lesson: lessonInfo(p), t: p.t, created: Date.now() / 1000, text: "", ...fields };
  const result = await enqueue({ type: "note", key: urlKey(p.url), note });
  return { note, result };
}

/** Open the Excalidraw window. When it closes, the service worker resumes `resumeTabId`'s video
 * and deletes the note if it was a `draft` that was never saved. */
export async function openDrawing(noteId, { resumeTabId = null, draft = false } = {}) {
  const { serverUrl } = await settings();
  const win = await chrome.windows.create({ url: `${serverUrl}/draw/?note=${noteId}`, type: "popup", width: 1280, height: 860 });
  if (resumeTabId != null || draft) {
    const { drawingWindows = {} } = await chrome.storage.local.get("drawingWindows");
    await chrome.storage.local.set({ drawingWindows: { ...drawingWindows, [win.id]: { noteId, resumeTabId, draft } } });
  }
}

/** Pause so nothing is missed while drawing; returns whether it was playing. */
async function pauseForDrawing(tab, p) {
  if (p.paused) return false;
  await control(tab.id, "pause");
  return true;
}

/** Screenshot -> note -> Excalidraw window. Drawing needs the server, so sync first. */
export async function captureAndDraw(tab, p) {
  const wasPlaying = await pauseForDrawing(tab, p);
  const image = await captureVideo(tab, p);
  const { note, result } = await addNote(tab, p, { kind: "shot", image, draft: true });
  if (result.error) {
    // Can't draw offline: keep it as a plain screenshot instead of a draft.
    await enqueue({ type: "delete", id: note.id, key: urlKey(p.url) });
    await addNote(tab, p, { kind: "shot", image });
    await toast(tab.id, "📷 Saved as a screenshot. Drawing needs the server (offline right now)");
    return;
  }
  await openDrawing(note.id, { resumeTabId: wasPlaying ? tab.id : null, draft: true });
}

const transcriptDone = new Set();
/** Save the lesson's subtitles on the server once (creates the lesson if needed), so they can be
 * searched, asked about and used by the LLM. Returns "saved" | "exists" | "retry" | "none". */
export async function syncTranscript(tab, p) {
  const key = urlKey(p.url);
  if (transcriptDone.has(key)) return "exists";
  transcriptDone.add(key);
  try {
    const lesson = await api("/api/lessons/resolve", { method: "POST", body: lessonInfo(p) });
    if (lesson.has_transcript) return "exists";
    const tr = await transcript(tab.id);
    if (tr?.error) {
      if (tr.retry) transcriptDone.delete(key);
      return tr.retry ? "retry" : "none";
    }
    await api(`/api/lessons/${lesson.id}/transcript`, { method: "PUT", body: { vtt: tr.vtt, src: tr.src } });
    notifyChanged();
    return "saved";
  } catch {
    transcriptDone.delete(key); // offline: try again next time
    return "retry";
  }
}

const cueCache = new Map();
/** Transcript cues for the lesson in this tab, read straight from the page (works offline). */
export async function lessonCues(tab, p) {
  const key = urlKey(p.url);
  if (!cueCache.has(key)) {
    const tr = await transcript(tab.id);
    if (tr?.error) throw new Error(tr.error);
    cueCache.set(key, parseVtt(tr.vtt));
  }
  return cueCache.get(key);
}

/** The last few seconds of what was said, as a quote note. */
export async function saveQuote(tab, p, cues) {
  cues ??= await lessonCues(tab, p);
  const said = cues.filter((c) => c.e >= p.t - 6 && c.s <= p.t + 0.5);
  if (!said.length) throw new Error("Nothing was being said at this moment.");
  await addNote(tab, { ...p, t: said[0].s }, { kind: "quote", text: said.map((c) => c.text).join(" ") });
  return said;
}

export async function newSketch(tab, p) {
  const wasPlaying = await pauseForDrawing(tab, p);
  const { note, result } = await addNote(tab, p, { kind: "sketch", draft: true });
  if (result.error) {
    await enqueue({ type: "delete", id: note.id, key: urlKey(p.url) });
    throw new Error("Server is offline; sketches need the server.");
  }
  await openDrawing(note.id, { resumeTabId: wasPlaying ? tab.id : null, draft: true });
}
