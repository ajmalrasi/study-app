import {
  activeTab, addBookmark, addNote, api, captureAndDraw, captureVideo, control, currentTime, enqueue, flush, fmtT, lessonCues,
  lessonInfo, newSketch, openDrawing, probe, queued, saveQuote, saveSettings, settings, transcript, urlKey,
} from "./lib.js";

const $ = (s) => document.querySelector(s);
const state = { tab: null, p: null, lesson: null, server: "unknown", serverUrl: "", composeT: null, resumeAfterNote: false,
  view: "notes", cues: null, cuesKey: null };
const transcriptTried = new Set();

// ---------- data ----------

async function loadLesson(p) {
  const key = urlKey(p.url);
  const cacheKey = `lesson:${key}`;
  try {
    const lesson = await api(`/api/lessons/by-url?url=${encodeURIComponent(p.url)}`);
    await chrome.storage.local.set({ [cacheKey]: lesson });
    return lesson;
  } catch (e) {
    if (e.status === 404) return null;
    return (await chrome.storage.local.get(cacheKey))[cacheKey] || null; // offline: last known copy
  }
}

async function ensureTranscript(lesson, force = false) {
  if (!force && !(await settings()).autoTranscript) return;
  if (!lesson || lesson.has_transcript || transcriptTried.has(lesson.id)) return;
  transcriptTried.add(lesson.id);
  $("#transcriptState").textContent = "📜 fetching transcript…";
  try {
    const tr = await transcript(state.tab.id);
    if (tr?.error) throw new Error(tr.error);
    const res = await api(`/api/lessons/${lesson.id}/transcript`, { method: "PUT", body: { vtt: tr.vtt, src: tr.src } });
    lesson.has_transcript = true;
    $("#transcriptState").textContent = `📜 transcript ✓ (${res.cues} lines)`;
  } catch (e) {
    $("#transcriptState").textContent = "📜 no transcript";
    $("#transcriptState").title = e.message;
  }
}

async function checkHealth() {
  try {
    const h = await api("/api/health", { timeout: 4000 });
    state.server = h.llm ? "ok" : "llm-down";
  } catch {
    state.server = "offline";
  }
  const dot = $("#status");
  dot.className = "dot " + { ok: "ok", "llm-down": "warn", offline: "bad" }[state.server];
  dot.title = { ok: "Server and LLM online", "llm-down": "Server online, LLM (Jetson) unreachable", offline: `Server offline (${state.serverUrl})` }[state.server];
}

// ---------- render ----------

let refreshing = null, refreshAgain = false;
async function refresh() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    state.serverUrl = (await settings()).serverUrl;
    state.tab = await activeTab();
    state.p = state.tab?.id && /^https?:/.test(state.tab.url || "") ? await probe(state.tab.id) : null;
    const p = state.p;
    $("#courseQuizTools").hidden = !p?.courseSlug?.startsWith("udemy-");
    $("#tools").classList.toggle("disabled-area", !p?.hasVideo);
    $("#composer").classList.toggle("disabled-area", !p?.hasVideo);
    $("#processBtn").disabled = !p?.hasVideo;
    if (!p?.hasVideo) {
      $("#lessonTitle").textContent = "Study Notes";
      $("#lessonSub").textContent = "";
      $("#timeline").innerHTML = `<div class="empty">Open a course video to take notes.<br><br>
        <span class="muted">Hotkeys work on the video page:<br>Alt+N note · Alt+S screenshot · Alt+D draw · Alt+B bookmark</span></div>`;
      $("#transcriptState").textContent = "";
      $("#jobState").textContent = "";
      $("#syncState").textContent = "";
      return;
    }
    if (urlKey(p.url) !== state.key) {
      state.key = urlKey(p.url);
      $("#jobState").textContent = ""; // job messages belong to the previous lesson
    }
    if (state.view === "transcript") state.cuesKey === urlKey(p.url) ? markNoted() : renderTranscript();
    $("#lessonTitle").textContent = p.title;
    $("#lessonSub").textContent = [p.course, p.module].filter(Boolean).join(" · ");
    state.lesson = await loadLesson(p);
    $("#lessonSub").textContent = [p.course, p.module || state.lesson?.module].filter(Boolean).join(" · ");
    render(await queued());
    if (state.lesson && state.server !== "offline") ensureTranscript(state.lesson);
    if (state.lesson?.job && ["queued", "running"].includes(state.lesson.job.status)) pollJob(state.lesson.job.id);
  })().finally(() => {
    refreshing = null;
    if (refreshAgain) { refreshAgain = false; refresh(); }
  });
  return refreshing;
}

function render(queue) {
  const key = urlKey(state.p.url);
  const deleted = new Set(queue.filter((o) => o.type === "delete").map((o) => o.id));
  const patches = Object.fromEntries(queue.filter((o) => o.type === "patch").map((o) => [o.id, o.patch]));
  const notes = (state.lesson?.notes || []).map((n) => ({ ...n, ...patches[n.id] }));
  const known = new Set(notes.map((n) => n.id));
  for (const op of queue) {
    if (op.type === "note" && op.key === key && !op.note.draft && !known.has(op.note.id)) notes.push({ ...op.note, pending: true, ...patches[op.note.id] });
  }
  const list = notes.filter((n) => !deleted.has(n.id)).sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9) || a.created - b.created);

  const tl = $("#timeline");
  tl.innerHTML = "";
  if (!list.length) {
    tl.innerHTML = `<div class="empty">No notes yet for this lesson.<br><span class="muted">Type below, or use Alt+N / Alt+S / Alt+D / Alt+B while watching.</span></div>`;
  }
  for (const n of list) tl.appendChild(noteEl(n));

  const pending = queue.length;
  const t = state.lesson?.has_transcript ? "📜 transcript ✓" : state.lesson ? "📜 no transcript yet" : "";
  if (!$("#transcriptState").textContent.includes("fetching")) $("#transcriptState").textContent = t;
  $("#syncState").textContent = pending ? `⏳ ${pending} change${pending > 1 ? "s" : ""} waiting to sync` : "";
}

function noteEl(n) {
  const el = document.createElement("div");
  el.className = `note ${n.kind}${n.pending ? " pending" : ""}`;
  const icon = { bookmark: "⭐", shot: "📷", sketch: "🖊", quote: "💬", text: "" }[n.kind] || "";
  el.innerHTML = `<div class="meta">${n.t != null ? `<button class="ts">${fmtT(n.t)}</button>` : ""}<span>${icon}</span>
    ${n.pending ? `<span class="muted">not synced</span>` : ""}</div>
    <div class="text"></div><button class="del" title="Delete">×</button>`;
  const text = el.querySelector(".text");
  text.textContent = n.text || "";
  text.dataset.placeholder = n.kind === "text" ? "" : "add a note…";
  el.querySelector(".ts")?.addEventListener("click", () => control(state.tab.id, "seek", n.t));
  text.addEventListener("click", () => editText(el, n));
  el.querySelector(".del").addEventListener("click", async () => {
    if (!confirm("Delete this note?")) return;
    await enqueue({ type: "delete", id: n.id, key: urlKey(state.p.url) });
  });

  const img = n.drawing || n.image;
  const src = n.pending ? n.image : img ? `${state.serverUrl}/files/${img}` : null;
  if (src || n.kind === "sketch") {
    if (src) {
      const im = Object.assign(document.createElement("img"), { src, loading: "lazy", title: "Click to draw on it" });
      el.appendChild(im);
      im.addEventListener("click", () => drawOn(n));
    }
    if (!n.pending) {
      const b = Object.assign(document.createElement("button"), { className: "edit-draw", textContent: n.has_drawing ? "✏️ edit drawing" : "✏️ draw" });
      b.addEventListener("click", () => drawOn(n));
      el.querySelector(".meta").appendChild(b);
    }
  }
  return el;
}

function drawOn(n) {
  if (n.pending) return alert("This note hasn't synced to the server yet.");
  openDrawing(n.id);
}

function editText(el, n) {
  if (el.querySelector("textarea")) return;
  const text = el.querySelector(".text");
  const ta = Object.assign(document.createElement("textarea"), { value: n.text || "", rows: Math.max(2, (n.text || "").split("\n").length) });
  text.replaceWith(ta);
  ta.focus();
  const finish = async (save) => {
    if (!ta.isConnected) return;
    if (save && ta.value.trim() !== (n.text || "")) {
      await enqueue({ type: "patch", id: n.id, patch: { text: ta.value.trim() }, key: urlKey(state.p.url) });
    } else refresh();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === "Escape") finish(false);
  });
  ta.addEventListener("blur", () => finish(true));
}

// ---------- composer ----------

const input = $("#noteInput");
input.addEventListener("input", async () => {
  if (!input.value.trim()) return;
  if (state.composeT == null && state.p?.hasVideo) {
    state.composeT = -1; // claim it before the async probe
    const p = await probe(state.tab.id);
    state.composeT = p?.t ?? null;
    $("#composeTime").textContent = state.composeT != null ? `@ ${fmtT(state.composeT)}` : "";
    if ((await settings()).pauseOnNote && p && !p.paused) {
      await control(state.tab.id, "pause");
      state.resumeAfterNote = true;
    }
  }
});
input.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") {
    input.value = "";
    resetComposer();
  }
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  const p = { ...state.p, t: state.composeT >= 0 ? state.composeT : state.p.t };
  input.value = "";
  await addNote(state.tab, p, { kind: "text", text });
  resetComposer();
});

function resetComposer() {
  state.composeT = null;
  $("#composeTime").textContent = "";
  if (state.resumeAfterNote) control(state.tab.id, "play");
  state.resumeAfterNote = false;
}

// ---------- toolbar ----------

async function withVideo(fn) {
  const p = await probe(state.tab.id);
  if (!p?.hasVideo) return;
  try {
    await fn(p);
  } catch (e) {
    alert(e.message);
  }
}

$("#bookmarkBtn").onclick = () => withVideo(async (p) => {
  const { duplicate } = await addBookmark(state.tab, p);
  flash($("#bookmarkBtn"), duplicate ? "Already here" : `✓ ${fmtT(p.t)}`);
});

/** Brief confirmation on a toolbar button. */
function flash(btn, text) {
  clearTimeout(btn._flash);
  btn.dataset.label ??= btn.textContent;
  btn.textContent = text;
  btn._flash = setTimeout(() => (btn.textContent = btn.dataset.label), 1200);
}
$("#shotBtn").onclick = () => withVideo(async (p) => {
  await addNote(state.tab, p, { kind: "shot", image: await captureVideo(state.tab, p) });
  flash($("#shotBtn"), `✓ ${fmtT(p.t)}`);
});
$("#drawBtn").onclick = () => withVideo(async (p) => {
  await captureAndDraw(state.tab, p);
});
$("#sketchBtn").onclick = () => withVideo((p) => newSketch(state.tab, p));
$("#quoteBtn").onclick = () => withVideo(async (p) => {
  const said = await saveQuote(state.tab, p);
  flash($("#quoteBtn"), `✓ ${fmtT(said[0].s)}`);
});
$("#askBtn").onclick = () => chrome.tabs.create({ url: `${state.serverUrl}/#search` });
$("#openQuizzesBtn").onclick = () => chrome.tabs.create({ url: `${state.serverUrl}/#quizzes` });
$("#syncSectionsBtn").onclick = async () => {
  const button = $("#syncSectionsBtn"), output = $("#courseSyncState");
  button.disabled = true;
  output.textContent = "Reading every curriculum page… Keep this Udemy tab open.";
  try {
    const reply = await chrome.runtime.sendMessage({ type: "sync-course-sections", tabId: state.tab.id });
    if (reply.error) throw new Error(reply.error);
    output.textContent = `${reply.result.sections.length} sections synced. Open Section quizzes to choose lessons and fetch missing captions.`;
    await refresh();
  } catch (e) { output.textContent = e.message; }
  finally { button.disabled = false; }
};

$("#openReview").onclick = () => chrome.tabs.create({ url: `${state.serverUrl}/${state.lesson ? `#lesson/${state.lesson.id}` : ""}` });

// ---------- processing ----------

$("#processBtn").onclick = async () => {
  const btn = $("#processBtn");
  btn.disabled = true;
  try {
    const { error } = await flush();
    if (error) throw new Error("Server is offline.");
    const p = await probe(state.tab.id);
    let lesson = await api("/api/lessons/resolve", { method: "POST", body: lessonInfo(p) });
    transcriptTried.delete(lesson.id);
    await ensureTranscript(lesson, true);
    const job = await api(`/api/lessons/${lesson.id}/process`, { method: "POST" });
    await pollJob(job.id);
  } catch (e) {
    showJob({ status: "error", error: e.message });
  } finally {
    btn.disabled = false;
  }
};

let polling = null;
function pollJob(jobId) {
  if (polling === jobId) return;
  polling = jobId;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const job = await api(`/api/jobs/${jobId}`);
        showJob(job);
        if (job.status === "done" || job.status === "error") {
          polling = null;
          if (job.status === "done") refresh();
          return resolve(job);
        }
      } catch (e) {
        showJob({ status: "error", error: e.message });
        polling = null;
        return resolve(null);
      }
      setTimeout(tick, 2000);
    };
    tick();
  });
}

function showJob(job) {
  const el = $("#jobState");
  el.className = job.status === "error" ? "error" : "muted";
  el.innerHTML = "";
  if (job.status === "error") el.textContent = `⚠ ${job.error}`;
  else if (job.status === "done") {
    el.textContent = "✓ Study notes and flashcards ready. ";
    const a = Object.assign(document.createElement("a"), { href: "#", textContent: "Open" });
    a.onclick = (e) => { e.preventDefault(); $("#openReview").click(); };
    el.appendChild(a);
  } else el.textContent = `✨ ${job.status === "queued" ? "waiting for the LLM…" : job.step || "working…"}`;
}


// ---------- transcript view ----------

document.querySelectorAll("#views [data-view]").forEach((b) => (b.onclick = () => showView(b.dataset.view)));

function showView(view) {
  state.view = view;
  document.querySelectorAll("#views [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("#timeline").hidden = view !== "notes";
  $("#transcript").hidden = view !== "transcript";
  if (view === "transcript") renderTranscript();
  else $("#selectionBar").hidden = true;
}

async function renderTranscript() {
  const box = $("#cues");
  const p = state.p;
  if (!p?.hasVideo) {
    box.innerHTML = `<div class="empty">Open a course video to see its transcript.</div>`;
    return;
  }
  const key = urlKey(p.url);
  if (state.cuesKey !== key) {
    state.cues = null;
    state.cuesKey = key;
    box.innerHTML = `<div class="empty">Loading transcript…</div>`;
    try {
      state.cues = await lessonCues(state.tab, p);
    } catch (e) {
      box.innerHTML = `<div class="empty">No transcript for this video.<br><span class="muted">${e.message}</span></div>`;
      return;
    }
  }
  if (!state.cues) return;
  box.innerHTML = "";
  let para = null, start = null;
  state.cues.forEach((c, i) => {
    if (!para || c.s - start >= 30) {
      start = c.s;
      para = Object.assign(document.createElement("div"), { className: "para" });
      const ts = Object.assign(document.createElement("button"), { className: "ts", textContent: fmtT(c.s) });
      ts.onclick = () => control(state.tab.id, "seek", c.s);
      para.appendChild(ts);
      box.appendChild(para);
    }
    const span = Object.assign(document.createElement("span"), { className: "cue", textContent: c.text + " " });
    span.dataset.i = i;
    para.appendChild(span);
  });
  markNoted();
  lastNow = -1;
  tick();
}

/** Underline transcript lines already saved as quotes. */
function markNoted() {
  if (!state.cues) return;
  const quoted = (state.lesson?.notes || []).filter((n) => n.kind === "quote").map((n) => n.t);
  document.querySelectorAll("#cues .cue").forEach((el) => {
    const c = state.cues[el.dataset.i];
    el.classList.toggle("noted", quoted.some((t) => Math.abs(t - c.s) < 0.5));
  });
}

// Click a line to jump there (unless you're selecting text to save it).
$("#cues").addEventListener("click", (e) => {
  const cue = e.target.closest(".cue");
  if (!cue || !getSelection().isCollapsed) return;
  control(state.tab.id, "seek", state.cues[cue.dataset.i].s);
});

// Follow the video: highlight the current line, scroll to it unless you scrolled recently.
let lastNow = -1, userScrolled = 0;
["wheel", "touchmove", "keydown"].forEach((t) => $("#transcript").addEventListener(t, () => (userScrolled = Date.now())));
async function tick() {
  if (state.view !== "transcript" || !state.cues || document.hidden || !state.tab) return;
  const now = await currentTime(state.tab.id);
  if (!now) return;
  let i = state.cues.findIndex((c) => c.s <= now.t && now.t < c.e);
  if (i < 0) i = state.cues.findLastIndex((c) => c.s <= now.t);
  if (i === lastNow) return;
  $("#cues .cue.now")?.classList.remove("now");
  const el = $(`#cues .cue[data-i="${i}"]`);
  el?.classList.add("now");
  lastNow = i;
  if (el && Date.now() - userScrolled > 5000) el.scrollIntoView({ block: "center", behavior: "smooth" });
}
setInterval(tick, 1000);

// Select transcript text -> save it as a quote note at the time of its first line.
function selectedCues() {
  const sel = getSelection();
  if (sel.isCollapsed || !$("#cues").contains(sel.anchorNode)) return null;
  const spans = [...document.querySelectorAll("#cues .cue")].filter((s) => sel.containsNode(s, true));
  const frag = sel.getRangeAt(0).cloneContents();
  frag.querySelectorAll(".ts").forEach((b) => b.remove()); // paragraph timestamps aren't part of the quote
  const text = frag.textContent.replace(/\s+/g, " ").trim();
  return spans.length && text ? { t: state.cues[spans[0].dataset.i].s, text } : null;
}
document.addEventListener("selectionchange", () => {
  if (state.view !== "transcript") return;
  const picked = selectedCues();
  $("#selectionBar").hidden = !picked;
  if (picked) $("#selectionInfo").textContent = `Quote at ${fmtT(picked.t)}`;
});
$("#saveSelection").onclick = async () => {
  const picked = selectedCues();
  if (!picked) return;
  getSelection().removeAllRanges();
  $("#selectionBar").hidden = true;
  await addNote(state.tab, { ...state.p, t: picked.t }, { kind: "quote", text: picked.text });
};

// ---------- settings ----------

$("#settingsBtn").onclick = async () => {
  const form = $("#settings");
  form.hidden = !form.hidden;
  const s = await settings();
  $("#serverUrl").value = s.serverUrl;
  $("#pauseOnNote").checked = s.pauseOnNote;
  $("#autoTranscript").checked = s.autoTranscript;
  $("#resumeAfterDraw").checked = s.resumeAfterDraw;
};
$("#settings").onsubmit = async (e) => {
  e.preventDefault();
  const error = $("#settingsError");
  error.hidden = true;
  try {
    const server = new URL($("#serverUrl").value);
    if (!["http:", "https:"].includes(server.protocol)) throw new Error("Use an HTTP or HTTPS server URL.");
    // Only the chosen notes server gets additional access, on an explicit Save.
    const granted = await chrome.permissions.request({ origins: [`${server.protocol}//${server.hostname}/*`] });
    if (!granted) throw new Error("Allow access to the notes server to save this address.");
    await saveSettings({ serverUrl: $("#serverUrl").value.replace(/\/$/, ""), pauseOnNote: $("#pauseOnNote").checked,
      autoTranscript: $("#autoTranscript").checked, resumeAfterDraw: $("#resumeAfterDraw").checked });
    $("#settings").hidden = true;
    await checkHealth();
    flush();
    refresh();
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
};

// ---------- wiring ----------

let debounce;
const soon = () => { clearTimeout(debounce); debounce = setTimeout(refresh, 250); };
chrome.tabs.onActivated.addListener(soon);
chrome.tabs.onUpdated.addListener((id, info) => { if (id === state.tab?.id && (info.url || info.status === "complete")) soon(); });
chrome.runtime.onMessage.addListener((m) => { if (m?.type === "notes-changed") soon(); });
window.addEventListener("sn-changed", soon); // changes made from this panel
window.addEventListener("focus", soon); // e.g. back from the drawing window
setInterval(() => { checkHealth(); flush(); }, 30000);

(async () => {
  state.serverUrl = (await settings()).serverUrl;
  await checkHealth();
  await flush();
  await refresh();
})();
