const $ = (s, parent = document) => parent.querySelector(s);
const $$ = (s, parent = document) => [...parent.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#${name}"></use></svg>`;
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmt = (t) => {
  if (t == null) return "";
  t = Math.floor(t);
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60;
  return (
    (h ? `${h}:${String(m).padStart(2, "0")}` : m) +
    ":" +
    String(s).padStart(2, "0")
  );
};
const seconds = (t) => t.split(":").reduce((a, v) => a * 60 + Number(v), 0);
const interval = (s) =>
  s < 3600
    ? `${Math.round(s / 60)} min`
    : s < 86400
      ? `${Math.round(s / 3600)} hr`
      : `${Math.round(s / 86400)} day${s === 86400 ? "" : "s"}`;
const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Reading still works when browser storage is unavailable. */
  }
};
const uid = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const safeUrl = (s) => {
  try {
    const u = new URL(s, location.origin);
    return ["http:", "https:"].includes(u.protocol) ? u.href : "#";
  } catch {
    return "#";
  }
};
const videoUrl = (url, t) => {
  const u = new URL(safeUrl(url));
  if (t != null) u.hash = "sn_t=" + Math.floor(t);
  return u.href;
};
const videoLink = (url, t, label = "Open video") =>
  `<a class="text-button" href="${esc(videoUrl(url, t))}" target="_blank" rel="noopener noreferrer">${icon("play")}${esc(label)}${icon("external")}</a>`;
const lessonHref = (id, tab = "study", t = null) =>
  `#lesson/${id}/${tab}${t == null ? "" : "?t=" + encodeURIComponent(t)}`;
const timeButton = (t) =>
  t == null
    ? ""
    : `<button class="time" data-action="source" data-t="${Number(t)}" aria-label="Inspect source at ${fmt(t)}">${fmt(t)}</button>`;
const announce = (s) => {
  $("#announcer").textContent = s;
};
let toastTimer;
function toast(s, error = false) {
  const el = $("#toast");
  el.textContent = s;
  el.hidden = false;
  el.classList.toggle("error", error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6500);
  announce(s);
}
async function api(path, { signal, method = "GET", body, ...opts } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const e = new Error(
      typeof data.detail === "string"
        ? data.detail
        : `Request failed (${response.status}). Please try again.`,
    );
    e.status = response.status;
    throw e;
  }
  return data;
}
const state = {
  courses: [],
  summary: null,
  summaryError: false,
  epoch: 0,
  controller: null,
  current: null,
  lesson: null,
  paragraphs: [],
  questionIndex: {},
  filter: "all",
  course: "",
  transcriptQuery: "",
  sourceT: 0,
  review: null,
  ask: null,
  poll: null,
  health: null,
};
let positions = read("sn-reading-positions", {}),
  drafts = read("sn-answer-drafts", {}),
  modules = read("sn-open-modules", {}),
  preferences = read("sn-preferences", {
    theme: "system",
    reading: "standard",
  });
if (!positions || typeof positions !== "object") positions = {};
if (!drafts || typeof drafts !== "object") drafts = {};
if (!modules || typeof modules !== "object") modules = {};
const pendingNotes = new Map();
function applyPreferences() {
  document.documentElement.dataset.theme = ["system", "light", "dark"].includes(
    preferences.theme,
  )
    ? preferences.theme
    : "system";
  document.documentElement.dataset.reading =
    preferences.reading === "comfortable" ? "comfortable" : "standard";
  const dark =
    preferences.theme === "dark" ||
    (preferences.theme !== "light" &&
      matchMedia("(prefers-color-scheme:dark)").matches);
  $('meta[name="theme-color"]').content = dark ? "#171b19" : "#30664e";
}
applyPreferences();
matchMedia("(prefers-color-scheme:dark)").addEventListener(
  "change",
  applyPreferences,
);
function parseRoute() {
  const [path, query = ""] = location.hash.slice(1).split("?"),
    params = new URLSearchParams(query),
    parts = path.split("/");
  const route = {
    key: location.hash || "#",
    page: parts[0] || "overview",
    params,
  };
  if (["search", "ask"].includes(route.page) && parts[1] && !params.has("q")) {
    try {
      params.set("q", decodeURIComponent(parts.slice(1).join("/")));
    } catch {
      params.set("q", parts.slice(1).join("/"));
    }
  }
  if (route.page === "lesson") {
    route.id = Number(parts[1]);
    route.tab = ["study", "notes", "transcript", "cards"].includes(parts[2])
      ? parts[2]
      : "auto";
  }
  if (route.page === "review") route.id = Number(parts[1]) || null;
  return route;
}
function savePosition() {
  if (state.current?.page === "lesson") {
    positions[state.current.key] = Math.round(window.scrollY);
    positions[lessonHref(state.current.id, state.current.tab)] = Math.round(
      window.scrollY,
    );
    store("sn-reading-positions", positions);
  }
}
let scrollTimer;
addEventListener(
  "scroll",
  () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(savePosition, 180);
  },
  { passive: true },
);
function navigate(hash, replace = false) {
  savePosition();
  if ((location.hash || "#") === hash) {
    route();
    return;
  }
  if (replace) location.replace(hash);
  else location.hash = hash;
}
function setBreadcrumb(items) {
  $("#breadcrumbs").innerHTML =
    `<a href="#">Study space</a>` +
    items
      .map(
        ([label, href]) =>
          `${icon("chevron")}${href ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span class="current">${esc(label)}</span>`}`,
      )
      .join("");
}
function setPage(title, html) {
  document.title =
    title === "Overview" ? "Study Notes" : `${title} · Study Notes`;
  $("#main").innerHTML = html;
}
function loading(label = "Opening your lesson…") {
  return `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(label)}</div>`;
}
function errorBox(message, action = "retry-route") {
  return `<div class="error-box" role="alert"><p>${icon("alert")} ${esc(message)}</p><button class="button" data-action="${action}">${icon("refresh")}Try again</button></div>`;
}
function empty(title, text, action = "") {
  return `<section class="empty"><h2>${esc(title)}</h2><p>${text}</p>${action}</section>`;
}
function courseUrl(c, module = "") {
  return (
    "#library?" +
    new URLSearchParams({ course: c.slug, ...(module ? { module } : {}) })
  );
}
function renderNavigation() {
  const active = state.current?.page;
  $$("[data-nav]").forEach((a) => {
    if (a.dataset.nav === (active === "lesson" ? "library" : active))
      a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const n = state.courses.reduce((a, c) => a + c.lessons.length, 0);
  $("#library-count").textContent = n;
  $("#library-count").hidden = !n;
  $("#course-navigation").innerHTML = state.courses.length
    ? state.courses
        .map(
          (c) =>
            `<a class="course-link" href="${esc(courseUrl(c))}"><span class="course-dot"></span>${esc(c.title)}</a><div class="module-nav">${[
              ...new Set(c.lessons.map((l) => l.module || "Other lessons")),
            ]
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
              .map(
                (m) =>
                  `<a href="${esc(courseUrl(c, m))}">${esc(m)} · ${count(c.lessons.filter((l) => (l.module || "Other lessons") === m).length, "lesson")}</a>`,
              )
              .join("")}</div>`,
        )
        .join("")
    : '<p class="small muted">Your saved courses will appear here.</p>';
  renderDueCounts();
}
function renderDueCounts() {
  $$("[data-due-count]").forEach((el) => {
    el.hidden = state.summary === null || !state.summary.due;
    el.textContent = state.summary?.due ?? "";
  });
}
async function refreshLibrary(signal) {
  const data = await api("/api/courses", { signal });
  state.courses = data;
  renderNavigation();
  return data;
}
async function refreshSummary() {
  try {
    state.summary = await api("/api/review/summary");
    state.summaryError = false;
  } catch {
    state.summary = null;
    state.summaryError = true;
  }
  renderDueCounts();
}
function status(l) {
  if (["queued", "running"].includes(l.job_status))
    return ["Generating study notes", "clock", "pending"];
  if (l.job_status === "error") return ["Generation failed", "alert", "failed"];
  if (l.processed) return ["Study notes ready", "check", ""];
  if (l.has_transcript || l.note_count)
    return ["Ready to generate", "sparkles", "pending"];
  return ["No transcript saved", "file", "pending"];
}
function lessonRow(l) {
  const [label, ico, style] = status(l);
  return `<a class="lesson-row" href="${lessonHref(l.id, "auto")}"><span class="row-icon">${icon(l.processed ? "check-file" : "file")}</span><div class="row-copy"><div class="row-title">${esc(l.title)}</div><div class="row-meta">${count(l.note_count, "note")}${l.card_count ? " · " + count(l.card_count, "flashcard") : ""}${l.has_transcript ? " · Transcript saved" : ""}<span class="mobile-state"> · ${esc(label)}</span></div></div><span class="tag row-status ${style}">${icon(ico)}${label}</span>${icon("chevron").replace('class="icon"', 'class="icon row-arrow"')}</a>`;
}
function courseSection(c, { openModule = null } = {}) {
  const groups = new Map();
  c.lessons
    .filter((l) => state.filter !== "pending" || !l.processed)
    .forEach((l) => {
      const m = l.module || "Other lessons";
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(l);
    });
  if (!groups.size) return "";
  return `<section class="course-section"><div class="course-heading"><div class="course-monogram" aria-hidden="true">${esc(c.title.slice(0, 1))}</div><div><h3>${esc(c.title)}</h3><p class="small muted">${c.lessons.some((l) => l.url_key.includes("deeplearning.ai")) ? "DeepLearning.AI · " : ""}${count(c.lessons.length, "saved lesson")}</p></div>${c.id ? `<button class="text-button" data-action="rename-course" data-course-id="${c.id}" aria-label="Rename ${esc(c.title)}">${icon("edit")}Rename course</button>` : ""}</div>${[
    ...groups,
  ]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([name, lessons], i) => {
      const key = `${c.slug}/${name}`,
        isOpen =
          openModule === name ||
          state.filter === "pending" ||
          (key in modules ? modules[key] : i === 0);
      return `<details class="module" data-module-key="${esc(key)}" ${isOpen ? "open" : ""}><summary>${icon("chevron")}${esc(name)}<span class="module-count">${count(lessons.length, "saved lesson")}</span></summary>${lessons.map(lessonRow).join("")}</details>`;
    })
    .join("")}</section>`;
}
function libraryContent(route, overview = false) {
  const chosen = route.params.get("course") || "",
    courses = state.courses.filter((c) => !chosen || c.slug === chosen),
    pending = state.courses.reduce(
      (n, c) => n + c.lessons.filter((l) => !l.processed).length,
      0,
    );
  return `<div class="section-heading"><h2>${overview ? "Your library" : "Saved lessons"}</h2>${overview ? '<a class="text-button" href="#library">Browse library ' + icon("external") + "</a>" : ""}</div><div class="filters" aria-label="Filter lessons"><button class="filter" data-action="filter" data-filter="all" aria-pressed="${state.filter === "all"}">All lessons</button><button class="filter" data-action="filter" data-filter="pending" aria-pressed="${state.filter === "pending"}">Needs study notes <span class="small">${pending}</span></button>${chosen ? '<a class="text-button" href="#library">All courses</a>' : ""}</div>${courses.map((c) => courseSection(c, { openModule: route.params.get("module") })).join("") || empty("Nothing here yet.", state.filter === "pending" ? "Your saved lessons already have study notes." : "Choose another course or save a lesson with the extension.")}`;
}
async function home(route, epoch) {
  setBreadcrumb([[route.page === "library" ? "Library" : "Overview"]]);
  await refreshLibrary(state.controller.signal);
  await refreshSummary();
  if (epoch !== state.epoch) return;
  if (!state.courses.length) {
    setPage(
      "Overview",
      `<div class="intro"><div class="eyebrow">Your study space</div><h1>A place for what you learn.</h1></div>${empty("Your first lesson starts here.", "Open a course video with the Study Notes extension installed.<br>Your notes, transcript, and captures will appear here.", '<a class="button primary" href="https://learn.deeplearning.ai/" target="_blank" rel="noopener noreferrer">Open DeepLearning.AI ' + icon("external") + "</a>")}`,
    );
    return;
  }
  if (route.page === "library") {
    setPage(
      "Library",
      `<div class="intro"><div class="eyebrow">Your collection</div><h1>Your saved lessons.</h1><p>Browse your notes and study material, grouped by course and module.</p></div>${libraryContent(route)}`,
    );
    const module = route.params.get("module");
    if (module)
      requestAnimationFrame(() => {
        if (epoch !== state.epoch) return;
        const target = $$("details[data-module-key]").find(
          (el) =>
            el.dataset.moduleKey === `${route.params.get("course")}/${module}`,
        );
        target?.scrollIntoView({ block: "start", behavior: "instant" });
      });
    return;
  }
  const all = state.courses.flatMap((c) =>
      c.lessons.map((l) => ({ ...l, course: c })),
    ),
    last = read("sn-last-lesson", null),
    resume =
      all.find((l) => l.id === last?.id) ||
      all.sort((a, b) => b.updated - a.updated)[0],
    isLast = resume.id === last?.id;
  setPage(
    "Overview",
    `<div class="intro"><div class="eyebrow">Your study space</div><h1>Pick up where you left off.</h1><p>A little review. A clearer understanding.</p></div><div class="home-features"><section class="resume"><div class="eyebrow">${isLast ? "Continue reading" : "Recently updated"}</div><h2>${esc(resume.title)}</h2><p class="small muted">${esc(resume.course.title)}${resume.module ? " · " + esc(resume.module) : ""}</p><a class="button primary" href="${lessonHref(resume.id, isLast ? last.tab : "auto")}">${isLast ? "Continue reading" : "Open lesson"}${icon("arrow")}</a></section><section class="due-panel">${state.summary ? `<div class="flex" style="gap:15px"><span class="due-number">${state.summary.due}</span><span>${state.summary.due ? "cards ready" : "cards due"}<br><span class="small muted">${state.summary.due ? "for a little practice" : "All caught up"}</span></span></div><p class="small muted">${state.summary.due ? "Start with a short session." : "Your next review will be ready when it’s due."}</p><a class="button primary" href="#review">${state.summary.due ? "Start a short review" : "Review overview"}${icon("arrow")}</a>` : `<h2>Review</h2><p class="small muted">We couldn’t load your due count.</p><button class="button" data-action="retry-route">${icon("refresh")}Try again</button>`}</section></div>${libraryContent(route, true)}`,
  );
}
function inline(s, url = null) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,:;!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[((?:\d+:)?\d+:\d{2})\]/g, (m, t) =>
      url
        ? `<a class="time" href="${esc(videoUrl(url, seconds(t)))}" target="_blank" rel="noopener noreferrer">${t}</a>`
        : timeButton(seconds(t)),
    );
}
function markdown(src, url = null) {
  let html = "",
    list = null,
    code = false,
    buffer = [];
  const close = () => {
    if (list) {
      html += `</${list}>`;
      list = null;
    }
  };
  for (const line of String(src || "").split("\n")) {
    if (/^```/.test(line)) {
      close();
      if (code) {
        html += `<pre><code>${esc(buffer.join("\n"))}</code></pre>`;
        buffer = [];
      }
      code = !code;
      continue;
    }
    if (code) {
      buffer.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/),
      li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (li) {
      const type = /\d/.test(li[1]) ? "ol" : "ul";
      if (list !== type) {
        close();
        html += `<${type}>`;
        list = type;
      }
      html += `<li>${inline(li[2], url)}</li>`;
      continue;
    }
    close();
    if (heading) html += `<h3>${inline(heading[2], url)}</h3>`;
    else if (/^>\s?/.test(line))
      html += `<blockquote>${inline(line.replace(/^>\s?/, ""), url)}</blockquote>`;
    else if (line.trim()) html += `<p>${inline(line, url)}</p>`;
  }
  close();
  if (buffer.length)
    html += `<pre><code>${esc(buffer.join("\n"))}</code></pre>`;
  return html;
}
function studySections(l) {
  return l.study_notes
    .split(/^###\s+/m)
    .filter((x) => x.trim())
    .map((sec, i) => {
      const nl = sec.indexOf("\n"),
        title = (nl < 0 ? sec : sec.slice(0, nl)).trim(),
        body = nl < 0 ? "" : sec.slice(nl + 1),
        type = /summary/i.test(title)
          ? "summary"
          : /concept/i.test(title)
            ? "concepts"
            : /missed|additional points/i.test(title)
              ? "additional"
              : /question/i.test(title)
                ? "practice"
                : "section-" + i;
      return { title, body, type };
    });
}
const listItems = (body) =>
  body
    .split("\n")
    .map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/)?.[1])
    .filter(Boolean);
const plain = (s) =>
  String(s || "")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const tsOf = (s) => {
  const m = String(s).match(/\[((?:\d+:)?\d+:\d{2})\]/);
  return m ? seconds(m[1]) : null;
};
function questionMarkup(l, questions) {
  if (!questions.length) return "";
  const index = Math.min(state.questionIndex[l.id] || 0, questions.length - 1),
    q = questions[index],
    attempts = l.answers.filter((a) => plain(a.question) === plain(q)),
    draft = drafts[l.id]?.[q] || "";
  return `<div class="practice" data-question="${esc(q)}"><div class="practice-pagination"><div class="eyebrow">Practice · ${index + 1} of ${questions.length}</div><div class="flex"><button class="icon-button" data-action="question-prev" ${index === 0 ? "disabled" : ""} aria-label="Previous practice question">${icon("chevron").replace("<svg ", '<svg style="transform:rotate(180deg)" ')}</button><button class="icon-button" data-action="question-next" ${index === questions.length - 1 ? "disabled" : ""} aria-label="Next practice question">${icon("chevron")}</button></div></div><div class="question">${inline(q)}</div>${attempts.map((a) => `<div class="attempt"><div class="flex between small muted"><span>My answer · ${new Date(a.created * 1000).toLocaleDateString()}</span><button class="text-button" data-action="delete-answer" data-id="${a.id}">Delete answer</button></div><div class="my-answer">${esc(a.answer)}</div><div class="prose feedback">${markdown(a.feedback)}</div></div>`).join("")}<label class="field-label" for="practice-answer">${attempts.length ? "Try another answer" : "Your answer"}</label><textarea id="practice-answer" placeholder="Explain it in your own words…">${esc(draft)}</textarea><button class="button primary" data-action="check-answer">Check my answer${icon("arrow")}</button><div class="question-status" id="question-status" role="status"></div></div>`;
}
function studyMarkup(l) {
  if (!l.study_notes)
    return empty(
      "Turn this lesson into study material.",
      "Your notes and any saved transcript are ready.<br>Generate a summary, key ideas, and flashcards when you’re ready.",
      '<button class="button primary" data-action="process">' +
        icon("sparkles") +
        "Generate study notes</button>",
    );
  const sections = studySections(l),
    have = new Set(l.notes.map((n) => plain(n.text))),
    questions = sections
      .filter((s) => s.type === "practice")
      .flatMap((s) => listItems(s.body));
  state.questions = questions;
  return `<div class="reading-layout"><article class="prose"><div class="ai-label">${icon("sparkles")}AI study notes · Verify with the source</div>${sections
    .map((s) => {
      if (s.type === "summary")
        return `<section id="summary" class="summary-callout"><div class="eyebrow">Summary</div>${markdown(s.body)}</section>`;
      if (s.type === "practice")
        return `<section id="practice"><h2>Put it into your own words</h2><div id="practice-container">${questionMarkup(l, questions)}</div></section>`;
      if (s.type === "additional")
        return `<section id="additional"><h2>Additional points from the transcript</h2><ul>${listItems(
          s.body,
        )
          .map((item) => {
            const text = item
              .replace(/^\s*\[(?:\d+:)?\d+:\d{2}\]\s*/, "")
              .replace(/\*\*/g, "")
              .trim();
            return `<li>${inline(item)}<div>${have.has(plain(text)) ? '<span class="small muted">' + icon("check") + " In my notes</span>" : `<button class="text-button" data-action="add-point" data-text="${esc(text)}" data-t="${tsOf(item) ?? ""}">${icon("plus")}Add to my notes</button>`}</div></li>`;
          })
          .join("")}</ul></section>`;
      return `<section id="${s.type}"><h2>${esc(s.title)}</h2><div${s.type === "concepts" ? ' class="concept-content"' : ""}>${markdown(s.body)}</div></section>`;
    })
    .join(
      "",
    )}<div class="generated-at">Generated by ${esc(l.study_meta.model || "your local model")}${l.study_meta.at ? " · " + new Date(l.study_meta.at * 1000).toLocaleString() : ""}. Your personal notes stay separate.</div></article><aside class="context-panel" aria-label="Lesson context"><div><div class="eyebrow">On this page</div><nav class="section-links">${sections.map((s) => `<a href="#${s.type}" data-section="${s.type}">${esc(s.type === "additional" ? "Additional points" : s.type === "practice" ? "Practice" : s.title)}</a>`).join("")}</nav></div><hr><div><div class="eyebrow">Source passage</div><div id="source-excerpt"><p class="small muted">Select a timestamp to inspect the source.</p></div></div>${
    l.notes.some((n) => n.image || n.drawing)
      ? `<hr><div class="context-captures"><div class="eyebrow">Your captures</div>${l.notes
          .filter((n) => n.image || n.drawing)
          .map(
            (n) =>
              `<button class="text-button capture-link" data-action="preview" data-note="${esc(n.id)}">${icon("image")}Capture${n.t != null ? " at " + fmt(n.t) : ""}</button>`,
          )
          .join("")}</div>`
      : ""
  }</aside></div>`;
}
function noteMarkup(n, { compact = false } = {}) {
  const img = n.drawing || n.image,
    kind =
      {
        bookmark: "Important moment",
        quote: "Saved quote",
        shot: "Slide capture",
        sketch: "Drawing",
        text: "Personal note",
      }[n.kind] || "Personal note";
  if (img)
    return `<article class="capture" id="note-${esc(n.id)}" data-note-time="${n.t ?? ""}"><button class="capture-image" data-action="preview" data-note="${esc(n.id)}" aria-label="Preview ${kind.toLowerCase()}${n.t != null ? " at " + fmt(n.t) : ""}"><img src="/files/${encodeURIComponent(img)}" alt="${esc(n.text || kind + (n.t != null ? " at " + fmt(n.t) : ""))}" loading="lazy"></button><div class="capture-body"><div class="flex between">${timeButton(n.t)}<span class="small muted">${kind}</span></div>${n.text ? `<p>${esc(n.text)}</p>` : ""}${n.context && !compact ? `<details class="capture-context"><summary>Transcript context</summary><p>${esc(n.context)}</p></details>` : ""}<div class="capture-tools"><button class="text-button" data-action="preview" data-note="${esc(n.id)}">${icon("expand")}View capture</button><a class="text-button" href="/draw/?note=${encodeURIComponent(n.id)}" target="_blank" rel="noopener noreferrer">${icon("edit")}Edit drawing</a><button class="text-button" data-action="edit-note" data-note="${esc(n.id)}">Caption</button></div></div></article>`;
  return `<article class="text-note ${esc(n.kind)}" id="note-${esc(n.id)}" data-note-time="${n.t ?? ""}"><div class="flex">${timeButton(n.t)}${icon(n.kind === "bookmark" ? "bookmark" : n.kind === "quote" ? "quote" : "file")}<span class="small muted">${kind}</span></div>${n.text ? `<p>${esc(n.text)}</p>` : ""}${!n.text && n.context ? `<div class="capture-context">${esc(n.context)}</div>` : ""}<button class="text-button" data-action="edit-note" data-note="${esc(n.id)}">${icon("edit")}Edit note</button></article>`;
}
function notesMarkup(l) {
  if (!l.notes.length)
    return empty(
      "No personal notes yet.",
      "Capture a moment or write a note while watching with the extension.",
    );
  return `<div class="section-heading"><h2>Your moments from the lesson</h2><span class="small muted">${count(l.notes.length, "note")}</span></div><div class="capture-grid">${l.notes
    .filter((n) => n.image || n.drawing)
    .map((n) => noteMarkup(n))
    .join("")}</div><div class="notes-text">${l.notes
    .filter((n) => !n.image && !n.drawing)
    .map((n) => noteMarkup(n))
    .join("")}</div>`;
}
function transcriptRows() {
  const l = state.lesson,
    q = state.transcriptQuery.trim().toLocaleLowerCase(),
    matches = state.paragraphs.filter(
      (p) => !q || p.text.toLocaleLowerCase().includes(q),
    );
  $("#transcript-count").textContent = q
    ? count(matches.length, "match").replace("matchs", "matches")
    : count(state.paragraphs.length, "passage");
  $("#transcript-results").innerHTML =
    matches
      .map((p) => {
        const i = state.paragraphs.indexOf(p),
          end = state.paragraphs[i + 1]?.t ?? Infinity,
          notes = l.notes.filter(
            (n) => n.t != null && n.t >= (i ? p.t : -Infinity) && n.t < end,
          );
        return `<section class="passage" id="${esc(p.id || "p-" + Math.round(p.t * 1000))}" data-passage-time="${p.t}">${timeButton(p.t)}<div><p>${highlight(p.text, q)}</p>${videoLink(l.url_key, p.t, "Open video at " + fmt(p.t))}${notes.length ? `<div class="inline-notes">${notes.map((n) => noteMarkup(n, { compact: true })).join("")}</div>` : ""}</div></section>`;
      })
      .join("") || empty("No matching passage.", "Try another word or phrase.");
}
function highlight(text, q) {
  if (!q) return esc(text);
  let pos = 0,
    out = "",
    lower = text.toLocaleLowerCase(),
    i;
  while ((i = lower.indexOf(q, pos)) >= 0) {
    out +=
      esc(text.slice(pos, i)) +
      "<mark>" +
      esc(text.slice(i, i + q.length)) +
      "</mark>";
    pos = i + q.length;
  }
  return out + esc(text.slice(pos));
}
function transcriptMarkup(l) {
  if (!l.has_transcript)
    return empty(
      "No transcript saved.",
      "Open this lesson in the extension to fetch its subtitles.",
    );
  return `<label class="field-label" for="transcript-find">Find in this transcript</label><div class="find-box">${icon("search")}<input type="search" id="transcript-find" placeholder="Find a word or phrase" value="${esc(state.transcriptQuery)}"><span id="transcript-count" class="small muted" role="status"></span></div><div id="transcript-results"></div>`;
}
function cardsMarkup(l) {
  if (!l.cards.length)
    return empty(
      "No flashcards yet.",
      "Generate study notes to create cards from this lesson.",
      '<button class="button primary" data-action="process">' +
        icon("sparkles") +
        "Generate study notes</button>",
    );
  return `<div class="section-heading"><h2>Practice the key ideas</h2><a class="button primary" href="#review/${l.id}">${icon("layers")}Review lesson</a></div><p class="small muted" style="margin-bottom:20px">Open a card to inspect it, or start a recall session with cards that are due.</p><div class="card-list">${l.cards.map((k) => `<details class="card-item"><summary>${esc(k.q)}</summary><p>${esc(k.a)}</p>${timeButton(k.t)}</details>`).join("")}</div>`;
}
function jobMarkup(job) {
  if (!job) return "";
  if (["queued", "running"].includes(job.status))
    return `<div class="job-status" role="status"><span class="spinner" aria-hidden="true"></span><span>${job.status === "queued" ? "Waiting to generate study notes…" : esc(job.step || "Generating study notes…")}</span></div>`;
  if (job.status === "error")
    return `<div class="job-status error" role="alert">${icon("alert")}<span>Study material couldn’t be generated. ${esc(job.error || "Please try again.")}</span><button class="button" data-action="process">Retry</button></div>`;
  return "";
}
function lessonContent(l, tab) {
  return (
    {
      study: studyMarkup,
      notes: notesMarkup,
      transcript: transcriptMarkup,
      cards: cardsMarkup,
    }[tab] || studyMarkup
  )(l);
}
function renderLesson(l, tab) {
  const busy = ["queued", "running"].includes(l.job?.status);
  setPage(
    l.title,
    `<div class="lesson-heading"><div class="eyebrow">${esc(l.course?.title || "Your library")}${l.module ? " / " + esc(l.module) : ""}</div><h1>${esc(l.title)}</h1><div class="small muted">${[l.has_transcript ? "Transcript saved" : "No transcript saved", count(l.notes.length, "note"), l.cards.length ? count(l.cards.length, "flashcard") : ""].filter(Boolean).join(" · ")}</div><div class="flex wrap actions"><a class="button" href="${esc(safeUrl(l.url_key))}" target="_blank" rel="noopener noreferrer">${icon("play")}Open video${icon("external")}</a>${l.study_notes ? `<a class="button primary" href="#review/${l.id}">${icon("layers")}Review lesson</a>` : `<button class="button primary" data-action="process" ${busy ? "disabled" : ""}>${icon("sparkles")}${busy ? "Generating…" : "Generate study notes"}</button>`}<button class="icon-button" data-action="lesson-menu" aria-label="More lesson actions">${icon("more")}</button></div></div><div id="job-status">${jobMarkup(l.job)}</div><div class="tabs" role="tablist" aria-label="Lesson views">${[
      ["study", "Study notes", ""],
      ["notes", "My notes", l.notes.length],
      ["transcript", "Transcript", ""],
      ["cards", "Flashcards", l.cards.length],
    ]
      .map(
        ([id, label, n]) =>
          `<button role="tab" id="tab-${id}" data-tab="${id}" aria-selected="${tab === id}" tabindex="${tab === id ? "0" : "-1"}" aria-controls="lesson-panel">${label}${n ? `<span class="tab-count">${n}</span>` : ""}</button>`,
      )
      .join(
        "",
      )}</div><div id="lesson-panel" role="tabpanel" aria-labelledby="tab-${tab}">${lessonContent(l, tab)}</div>`,
  );
  if (tab === "transcript" && l.has_transcript) transcriptRows();
  if (l.has_transcript && tab === "study") updateSource(state.sourceT, false);
}
async function lessonPage(route, epoch) {
  setBreadcrumb([["Library", "#library"], ["Lesson"]]);
  setPage("Lesson", loading());
  const l = await api("/api/lessons/" + route.id, {
    signal: state.controller.signal,
  });
  let paragraphs = [];
  if (l.has_transcript) {
    const tr = await api(`/api/lessons/${l.id}/transcript`, {
      signal: state.controller.signal,
    });
    paragraphs = tr.paragraphs;
  }
  if (epoch !== state.epoch) return;
  state.lesson = l;
  state.paragraphs = paragraphs;
  state.transcriptQuery = "";
  state.sourceT = Number(route.params.get("t")) || paragraphs[0]?.t || 0;
  let tab = route.tab;
  if (tab === "auto") {
    tab = l.study_notes
      ? "study"
      : l.notes.length || !l.has_transcript
        ? "notes"
        : "transcript";
    const suffix = route.params.toString();
    history.replaceState(
      null,
      "",
      lessonHref(l.id, tab) + (suffix ? "?" + suffix : ""),
    );
    route.key = location.hash;
    route.tab = tab;
  }
  setBreadcrumb([
    ["Library", "#library"],
    [l.course?.title || "Course", l.course ? courseUrl(l.course) : "#library"],
    [l.module || "Lesson"],
  ]);
  store("sn-last-lesson", { id: l.id, tab, title: l.title });
  renderLesson(l, tab);
  if (["queued", "running"].includes(l.job?.status)) pollJob(l.job.id, epoch);
  requestAnimationFrame(() => {
    if (epoch !== state.epoch) return;
    const target = route.params.get("t");
    if (target !== null) focusPassage(Number(target), tab);
    else
      window.scrollTo({ top: positions[route.key] || 0, behavior: "instant" });
  });
}
function paragraphAt(t) {
  return (
    state.paragraphs.find(
      (p, i) =>
        p.t <= t && (!state.paragraphs[i + 1] || state.paragraphs[i + 1].t > t),
    ) || state.paragraphs[0]
  );
}
function sourceContent(t) {
  const p = paragraphAt(t),
    l = state.lesson;
  if (!p)
    return `<p class="small muted">No transcript is saved for this moment.</p>${videoLink(l.url_key, t, "Watch at " + fmt(t))}`;
  return `<span class="time">${fmt(p.t)}</span><blockquote>${esc(p.text)}</blockquote><a class="text-button" href="${lessonHref(l.id, "transcript", p.t)}">Read in transcript${icon("arrow")}</a>${videoLink(l.url_key, t, "Watch at " + fmt(t))}`;
}
function updateSource(t, interactive = true) {
  if (!state.lesson) return;
  state.sourceT = t;
  const slot = $("#source-excerpt");
  if (slot) slot.innerHTML = sourceContent(t);
  if (interactive && (!slot || matchMedia("(max-width:1100px)").matches)) {
    showDialog(
      "Source passage",
      `<div class="source-dialog">${sourceContent(t)}</div>`,
    );
  }
  announce("Source passage at " + fmt(t));
}
function focusPassage(t, tab) {
  let el;
  if (tab === "transcript") {
    const p = paragraphAt(t);
    el = p
      ? document.getElementById(p.id || "p-" + Math.round(p.t * 1000))
      : null;
  } else if (tab === "notes") {
    el = $$("[data-note-time]").sort(
      (a, b) =>
        Math.abs(Number(a.dataset.noteTime) - t) -
        Math.abs(Number(b.dataset.noteTime) - t),
    )[0];
  }
  if (el) {
    $$(".highlight").forEach((x) => x.classList.remove("highlight"));
    el.classList.add("highlight");
    el.scrollIntoView({ block: "center", behavior: "instant" });
  } else if (tab === "study") updateSource(t, true);
}
async function pollJob(id, epoch) {
  try {
    const job = await api("/api/jobs/" + id, {
      signal: state.controller.signal,
    });
    if (epoch !== state.epoch) return;
    state.lesson.job = job;
    const slot = $("#job-status");
    if (slot) slot.innerHTML = jobMarkup(job);
    if (["queued", "running"].includes(job.status)) {
      state.poll = setTimeout(() => pollJob(id, epoch), 3000);
    } else {
      if (job.status === "done") {
        if (slot)
          slot.innerHTML =
            '<div class="job-status" role="status">' +
            icon("check") +
            '<span>Your study material is ready.</span><button class="button" data-action="reload-lesson">Open study notes' +
            icon("arrow") +
            "</button></div>";
        toast("Your new study material is ready.");
      }
      $$('[data-action="process"]').forEach((b) => {
        b.disabled = false;
        if (!b.closest(".job-status"))
          b.innerHTML = icon("sparkles") + "Generate study notes";
      });
      refreshLibrary().catch(() => {});
      refreshSummary();
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    if (epoch === state.epoch) {
      const slot = $("#job-status");
      if (slot)
        slot.innerHTML = errorBox(
          "We lost the generation status. Your notes are safe.",
          "retry-job",
        );
    }
  }
}
async function processLesson() {
  const l = state.lesson;
  if (!l) return;
  const epoch = state.epoch;
  $$('[data-action="process"]').forEach((b) => (b.disabled = true));
  try {
    const result = await api(`/api/lessons/${l.id}/process`, {
      method: "POST",
    });
    if (epoch !== state.epoch) return;
    const job = result.job || result;
    state.lesson.job = job;
    $("#job-status").innerHTML = jobMarkup({
      ...job,
      status: job.status || "queued",
    });
    pollJob(job.id, epoch);
  } catch (e) {
    if (epoch !== state.epoch) return;
    $("#job-status").innerHTML = errorBox(e.message, "process");
    $$('[data-action="process"]').forEach((b) => (b.disabled = false));
  }
}
function reviewScope(route) {
  const p = new URLSearchParams();
  if (route.id) p.set("lesson_id", route.id);
  if (route.params.get("course"))
    p.set("course_slug", route.params.get("course"));
  return p;
}
function reviewTitle(route) {
  if (route.id)
    return (
      state.courses.flatMap((c) => c.lessons).find((l) => l.id === route.id)
        ?.title || "This lesson"
    );
  const slug = route.params.get("course");
  return slug
    ? state.courses.find((c) => c.slug === slug)?.title || "This course"
    : "All saved lessons";
}
async function reviewPage(route, epoch) {
  setBreadcrumb([["Review"]]);
  setPage("Review", loading("Checking what’s ready to review…"));
  const params = reviewScope(route),
    summary = await api("/api/review/summary?" + params, {
      signal: state.controller.signal,
    });
  if (epoch !== state.epoch) return;
  state.review = {
    scope: params.toString(),
    title: reviewTitle(route),
    summary,
    phase: "setup",
    size: read("sn-review-size", 10),
    cards: [],
    index: 0,
    history: [],
    revealed: false,
    busy: false,
    pending: null,
    error: null,
  };
  renderReview();
}
function renderReview() {
  const r = state.review;
  if (!r || state.current?.page !== "review") return;
  let html;
  if (r.phase === "setup") {
    const { due, total } = r.summary;
    if (!due) {
      html = `<div class="review-complete"><div class="complete-mark">${icon(total ? "check" : "layers")}</div><h1>${total ? "All caught up." : "A little preparation first."}</h1><p>${total ? "Nothing is due in this collection right now. Your cards will return when they’re ready." : "Generate study notes from a saved lesson to create your first flashcards."}</p><a class="button primary" href="#library">Browse your lessons${icon("arrow")}</a></div>`;
    } else {
      const options = [
        ...new Set([Math.min(5, due), Math.min(10, due), Math.min(due, 500)]),
      ];
      if (!options.includes(r.size))
        r.size = options.find((n) => n >= 10) || options.at(-1);
      html = `<div class="review-intro"><span class="tag">${count(due, "card")} due</span><h1>A little practice goes a long way.</h1><p class="muted">Recall an idea, reveal the answer, then decide how it went.</p></div><section class="review-setup"><div class="eyebrow">Choose a session</div><div class="review-options">${options.map((n) => `<button class="button" data-action="review-size" data-size="${n}" aria-pressed="${r.size === n}">${n === due ? "All " + n : n + " cards"}</button>`).join("")}</div><button class="button primary" data-action="start-review" ${r.busy ? "disabled" : ""}>${r.busy ? "Opening cards…" : "Start review"}${icon("arrow")}</button><p class="small muted">${esc(r.title)} · You can stop at any point.</p>${due > 500 ? '<p class="small muted">Up to 500 cards per session. Remaining cards stay due.</p>' : ""}</section>${r.error ? errorBox(r.error, "start-review") : ""}`;
    }
  } else if (r.index >= r.cards.length) {
    const recalled = r.history.filter((h) => h.correct).length;
    html = `<div class="review-complete"><div class="complete-mark">${icon("check")}</div><h1>Good work. Let it settle.</h1><p>You reviewed ${count(r.history.length, "card")}.<br>${recalled} recalled · ${r.history.length - recalled} to revisit</p><div class="flex wrap"><button class="button primary" data-action="review-more">Check remaining cards${icon("arrow")}</button><a class="button" href="#">Back to your study space</a></div>${r.history.length ? '<button class="text-button" style="margin-top:20px" data-action="undo-review" ' + (r.busy ? "disabled" : "") + ">" + icon("undo") + "Undo last rating</button>" : ""}${r.error ? errorBox(r.error, "undo-review") : ""}</div>`;
  } else {
    const k = r.cards[r.index];
    html = `<div class="flex between"><span class="small muted">Card ${r.index + 1} of ${r.cards.length}</span><button class="text-button" data-action="end-review" ${r.busy || r.pending || r.conflict ? "disabled" : ""}>End session</button></div><div class="progress" role="progressbar" aria-label="Session progress" aria-valuenow="${r.index}" aria-valuemin="0" aria-valuemax="${r.cards.length}"><span style="width:${(r.index / r.cards.length) * 100}%"></span></div><section class="session-card"><div class="eyebrow">${esc(k.lesson_title)}</div><div class="review-question">${esc(k.q)}</div>${r.revealed ? `<div class="review-answer">${esc(k.a)}</div>${k.t != null ? videoLink(k.url_key, k.t, "Revisit the lesson at " + fmt(k.t)) : `<a class="text-button" href="${lessonHref(k.lesson_id)}">Open this lesson${icon("arrow")}</a>`}` : `<div class="small muted" style="margin-top:auto">Take a moment to recall before revealing.</div><button class="button primary" data-action="reveal">Reveal answer <span class="small">Space</span></button>`}</section>${r.revealed ? `<div class="review-controls"><button class="button" data-action="grade" data-correct="false" ${r.busy || r.pending || r.conflict ? "disabled" : ""}>Review again<small>In ${interval(k.again_seconds)} · key 1</small></button><button class="button primary" data-action="grade" data-correct="true" ${r.busy || r.pending || r.conflict ? "disabled" : ""}>Got it<small>In ${interval(k.correct_seconds)} · key 2</small></button></div>` : ""}${r.busy ? '<p class="question-status" role="status">Saving your review…</p>' : ""}${r.error ? errorBox(r.error, r.pending ? "retry-grade" : r.conflict ? "review-more" : "retry-route") : ""}<div class="review-footer"><button class="text-button" data-action="undo-review" ${!r.history.length || r.busy || r.pending ? "disabled" : ""}>${icon("undo")}Undo last rating</button><span>${r.busy ? "Saving…" : "Progress saved as you go"}</span></div>`;
  }
  setPage("Review", `<div class="review-wrap">${html}</div>`);
}
async function startReview() {
  const r = state.review,
    epoch = state.epoch;
  if (!r || r.busy) return;
  r.busy = true;
  r.error = null;
  renderReview();
  try {
    const params = new URLSearchParams(r.scope);
    params.set("limit", r.size);
    const data = await api("/api/cards/due?" + params);
    if (epoch !== state.epoch) return;
    r.cards = data.cards;
    r.phase = "active";
    r.index = 0;
    r.history = [];
    r.revealed = false;
    r.busy = false;
    r.pending = null;
    store("sn-review-size", r.size);
    renderReview();
    $('[data-action="reveal"]')?.focus();
    if (!r.cards.length) {
      r.summary = data;
      r.phase = "setup";
      renderReview();
    }
  } catch (e) {
    if (epoch !== state.epoch) return;
    r.busy = false;
    r.error = e.message;
    renderReview();
  }
}
async function grade(correct) {
  const r = state.review,
    epoch = state.epoch;
  if (!r || r.busy || r.conflict || !r.revealed) return;
  const card = r.cards[r.index];
  if (!card) return;
  if (!r.pending) r.pending = { id: uid(), correct, card };
  r.busy = true;
  r.error = null;
  renderReview();
  try {
    const pending = r.pending,
      result = await api(`/api/cards/${pending.card.id}/review`, {
        method: "POST",
        body: {
          correct: pending.correct,
          request_id: pending.id,
          expected_version: pending.card.review_version,
        },
      });
    r.history.push({
      card: { ...pending.card },
      correct: pending.correct,
      review_id: result.review_id,
    });
    r.pending = null;
    r.busy = false;
    r.index++;
    r.revealed = false;
    refreshSummary();
    if (epoch === state.epoch) {
      renderReview();
      $('[data-action="reveal"]')?.focus();
      announce("Review saved.");
    }
  } catch (e) {
    r.busy = false;
    if (e.status === 409) {
      r.pending = null;
      r.conflict = true;
    }
    r.error = e.message;
    if (epoch === state.epoch) renderReview();
  }
}
async function undoReview() {
  const r = state.review,
    epoch = state.epoch;
  if (!r || r.busy || r.pending || !r.history.length) return;
  const previous = r.history.at(-1);
  r.busy = true;
  r.error = null;
  renderReview();
  try {
    const data = await api(`/api/cards/${previous.card.id}/undo`, {
      method: "POST",
      body: { review_id: previous.review_id },
    });
    r.history.pop();
    r.index--;
    r.cards[r.index] = { ...previous.card, ...data };
    r.revealed = true;
    r.busy = false;
    refreshSummary();
    if (epoch === state.epoch) {
      renderReview();
      announce("Last rating undone.");
    }
  } catch (e) {
    r.busy = false;
    r.error = e.message;
    if (epoch === state.epoch) renderReview();
  }
}
function scopeOptions(selected = "", includeAll = true) {
  return (
    (includeAll ? '<option value="">All courses</option>' : "") +
    state.courses
      .map(
        (c) =>
          `<option value="${esc(c.slug)}" ${selected === c.slug ? "selected" : ""}>${esc(c.title)}</option>`,
      )
      .join("")
  );
}
function searchForm(q = "", course = "", kind = "all") {
  return `<form id="search-form" class="search-form"><label class="field-label" for="search-q">Search notes, transcripts, and lesson titles</label><div class="find-box">${icon("search")}<input id="search-q" type="search" placeholder="Find a word or idea…" value="${esc(q)}" required autocomplete="off"><button class="button primary" type="submit">Search</button></div><div class="search-controls"><label class="small muted" for="search-course">Course</label><select class="select" id="search-course">${scopeOptions(course)}</select><label class="small muted" for="search-kind">Look in</label><select class="select" id="search-kind">${[
    ["all", "Everything"],
    ["title", "Lesson titles"],
    ["note", "My notes"],
    ["transcript", "Transcripts"],
  ]
    .map(
      ([v, s]) =>
        `<option value="${v}" ${v === kind ? "selected" : ""}>${s}</option>`,
    )
    .join(
      "",
    )}</select><a class="text-button" href="#ask">Ask for an explanation${icon("arrow")}</a></div></form>`;
}
async function searchPage(route, epoch) {
  const q = route.params.get("q") || "",
    course = route.params.get("course") || "",
    kind = route.params.get("kind") || "all";
  setBreadcrumb([["Search"]]);
  setPage(
    "Search",
    `<div class="intro"><div class="eyebrow">Library search</div><h1>Find your way back to an idea.</h1></div>${searchForm(q, course, kind)}<div id="search-results">${q ? loading("Looking through your library…") : empty("What would you like to revisit?", "Search for words in your notes, transcripts, or lesson titles.")}</div>`,
  );
  if (!q) return;
  const p = new URLSearchParams({ q, kind });
  if (course) p.set("course_slug", course);
  try {
    const { results } = await api("/api/search?" + p, {
      signal: state.controller.signal,
    });
    if (epoch !== state.epoch) return;
    $("#search-results").innerHTML =
      `<p class="small muted" style="margin-bottom:15px">${count(results.length, "result")}${results.length >= 30 ? " · Showing the first 30 matches" : ""}</p><div class="search-results">${
        results
          .map(
            (r) =>
              `<article class="result"><div class="where">${esc(state.courses.find((c) => c.slug === r.course_slug)?.title || r.course || "Saved lesson")}${r.module ? " / " + esc(r.module) : ""} · ${{ title: "Lesson", note: "My note", transcript: "Transcript" }[r.kind] || "Passage"}</div><h3><a href="${lessonHref(r.lesson_id, r.kind === "note" ? "notes" : r.kind === "title" ? "auto" : "transcript", r.t)}">${esc(r.title)}</a></h3><p>${esc(
                r.snip,
              )
                .replace(/\u0002/g, "<mark>")
                .replace(
                  /\u0003/g,
                  "</mark>",
                )}</p>${r.t != null ? videoLink(r.url_key, r.t, "Watch at " + fmt(r.t)) : ""}</article>`,
          )
          .join("") ||
        empty(
          "No matching material.",
          "Try fewer words, another course, or a different filter.",
        )
      }</div>`;
  } catch (e) {
    if (e.name !== "AbortError" && epoch === state.epoch)
      $("#search-results").innerHTML = errorBox(e.message);
  }
}
function askExamples() {
  const l = state.courses
    .flatMap((c) => c.lessons)
    .find((l) => /reflection/i.test(l.title));
  return l
    ? [
        "How does reflection improve an AI output?",
        "Why does external feedback help?",
      ]
    : ["What are the key ideas in my saved lessons?"];
}
function askPage(route) {
  setBreadcrumb([["Ask your notes"]]);
  const q = route.params.get("q") || state.ask?.q || "",
    course = route.params.get("course") ?? state.ask?.course ?? "";
  if (!state.ask || q !== state.ask.q || course !== state.ask.course)
    state.ask = {
      q,
      course,
      answer: null,
      sources: [],
      busy: false,
      error: null,
    };
  setPage(
    "Ask your notes",
    `<div class="intro"><div class="eyebrow">Ask your notes</div><h1>Connect the ideas.</h1><p>Answers grounded in your saved lessons, with sources you can inspect.</p></div><div class="ask-layout"><div><form id="ask-form" class="ask-box"><label class="field-label" for="ask-q">Your question</label><textarea id="ask-q" placeholder="What would you like to understand?" required>${esc(q)}</textarea><div class="flex between wrap"><div class="flex wrap"><label class="small muted" for="ask-course">Course</label><select class="select" id="ask-course">${scopeOptions(course)}</select></div><button class="button primary" type="submit" id="ask-submit">${icon("sparkles")}Ask your notes</button></div><div class="health-note" id="ask-health"></div></form><div class="small muted">Try a question</div><div class="ask-examples">${askExamples()
      .map(
        (q) =>
          `<button class="button subtle" data-action="ask-example" data-q="${esc(q)}">${esc(q)}</button>`,
      )
      .join(
        "",
      )}</div><div id="ask-answer"></div></div><aside class="sources-panel" aria-label="Answer sources"><div class="eyebrow">Sources</div><div id="ask-sources"><p class="small muted" style="margin-top:10px">Source passages will appear alongside your answer.</p></div></aside></div>`,
  );
  renderAskResult();
  checkHealth();
}
async function checkHealth() {
  const el = $("#ask-health");
  if (!el) return;
  try {
    if (!state.health || Date.now() - state.health.at > 30000) {
      const value = await api("/api/health");
      state.health = { ...value, at: Date.now() };
    }
    if ($("#ask-health"))
      $("#ask-health").textContent = state.health.llm
        ? "Answers use your local AI model."
        : "AI is unavailable right now. Your saved lessons remain readable.";
  } catch {
    if ($("#ask-health"))
      $("#ask-health").textContent = "AI availability could not be checked.";
  }
}
function renderAskResult() {
  const a = state.ask;
  if (!$("#ask-answer") || !a) return;
  $("#ask-submit").disabled = a.busy;
  if (a.busy) {
    $("#ask-answer").innerHTML = loading(
      "Finding relevant passages and preparing your answer…",
    );
    return;
  }
  if (a.error) {
    $("#ask-answer").innerHTML = errorBox(a.error, "retry-ask");
    return;
  }
  if (a.answer === null) return;
  const cited = new Set(
    [...a.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
  );
  const firstCited = a.sources.find((s) => cited.has(s.n))?.n;
  let html = markdown(a.answer);
  html = html.replace(/\[(\d+)\]/g, (m, n) =>
    a.sources.some((s) => s.n === Number(n))
      ? `<button class="cite" data-action="citation" data-source="${n}" aria-label="Inspect source ${n}">${n}</button>`
      : m,
  );
  $("#ask-answer").innerHTML =
    `<article class="ask-answer prose"><div class="ai-label">${icon("sparkles")}Answer from your saved material</div>${html}</article>`;
  $("#ask-sources").innerHTML = a.sources.length
    ? `<div class="sources-list">${a.sources.map((s) => `<details class="source-card" id="source-${s.n}" ${s.n === firstCited ? "open" : ""}><summary><span class="tag">${s.n}</span> ${esc(s.title)}${s.t != null ? " · " + fmt(s.t) : ""}</summary><blockquote>${esc(s.text || "Open the source lesson to inspect this passage.")}</blockquote><a class="text-button" href="${lessonHref(s.lesson_id, s.kind === "note" ? "notes" : "transcript", s.t)}">Read in ${s.kind === "note" ? "my notes" : "transcript"}${icon("arrow")}</a>${s.t != null ? videoLink(s.url_key, s.t, "Watch at " + fmt(s.t)) : ""}</details>`).join("")}</div>`
    : '<p class="small muted" style="margin-top:10px">No supporting passages were found in this scope.</p>';
}
async function askQuestion() {
  const a = state.ask,
    epoch = state.epoch;
  if (!a || a.busy) return;
  const q = $("#ask-q").value.trim(),
    course = $("#ask-course").value;
  if (!q) {
    $("#ask-q").focus();
    return;
  }
  a.q = q;
  a.course = course;
  a.busy = true;
  a.error = null;
  renderAskResult();
  try {
    const result = await api("/api/ask", {
      method: "POST",
      body: { q, course_slug: course || null },
      signal: state.controller.signal,
    });
    if (epoch !== state.epoch) return;
    a.answer = result.answer;
    a.sources = result.sources;
    a.busy = false;
    renderAskResult();
    announce("Answer ready with " + count(a.sources.length, "source") + ".");
  } catch (e) {
    a.busy = false;
    if (e.name !== "AbortError" && epoch === state.epoch) {
      a.error = e.message;
      renderAskResult();
    }
  }
}
let returnFocus = null;
function showDialog(title, html, { preview = false } = {}) {
  const dialog = $("#dialog");
  returnFocus = document.activeElement;
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = html;
  dialog.classList.toggle("preview-dialog", preview);
  if (!dialog.open) dialog.showModal();
}
function closeDialog() {
  const dialog = $("#dialog");
  dialog.close();
  if (returnFocus?.isConnected) returnFocus.focus();
}
function preferencesDialog() {
  showDialog(
    "Make yourself comfortable",
    `<section class="preferences-section"><h3>Appearance</h3><div class="preference-options">${[
      ["system", "monitor", "System"],
      ["light", "sun", "Paper"],
      ["dark", "moon", "Evening"],
    ]
      .map(
        ([value, ico, label]) =>
          `<button class="button" data-action="preference" data-key="theme" data-value="${value}" aria-pressed="${preferences.theme === value}">${icon(ico)}${label}</button>`,
      )
      .join(
        "",
      )}</div></section><section class="preferences-section"><h3>Reading size</h3><div class="preference-options">${[
      ["standard", "Standard"],
      ["comfortable", "Comfortable"],
    ]
      .map(
        ([value, label]) =>
          `<button class="button" data-action="preference" data-key="reading" data-value="${value}" aria-pressed="${preferences.reading === value}">${icon("type")}${label}</button>`,
      )
      .join(
        "",
      )}</div><p class="small muted" style="margin-top:15px">These preferences and your reading position are saved in this browser.</p></section>`,
  );
}
function previewNote(id) {
  const n = state.lesson?.notes.find((n) => n.id === id);
  if (!n) return;
  const image = n.drawing || n.image;
  if (!image) return;
  showDialog(
    n.t != null ? "Capture at " + fmt(n.t) : "Your capture",
    `<div class="preview-toolbar"><button class="button" data-action="zoom">${icon("expand")}Actual size</button><a class="button" href="/draw/?note=${encodeURIComponent(n.id)}" target="_blank" rel="noopener noreferrer">${icon("edit")}Edit drawing</a></div><div class="preview-viewport"><img src="/files/${encodeURIComponent(image)}" alt="${esc(n.text || "Saved lesson capture")}"></div>${n.text ? `<p class="preview-caption">${esc(n.text)}</p>` : ""}${n.context ? `<p class="small muted" style="margin-top:12px">${esc(n.context)}</p>` : ""}`,
    { preview: true },
  );
}
function editNote(id) {
  const n = state.lesson?.notes.find((n) => n.id === id);
  if (!n) return;
  showDialog(
    n.image || n.drawing ? "Edit capture caption" : "Edit your note",
    `<form id="note-form" class="note-editor" data-note="${esc(n.id)}"><label class="field-label" for="note-text">${n.image || n.drawing ? "Caption" : "Note"}</label><textarea id="note-text">${esc(n.text)}</textarea><button class="button primary" type="submit">${icon("check")}Save changes</button><div id="note-error"></div></form>`,
  );
  $("#note-text").focus();
}
async function saveNote(form) {
  const id = form.dataset.note,
    epoch = state.epoch,
    button = $("button[type=submit]", form);
  button.disabled = true;
  try {
    const result = await api("/api/notes/" + encodeURIComponent(id), {
      method: "PATCH",
      body: { text: $("#note-text").value },
    });
    if (epoch === state.epoch) {
      const i = state.lesson.notes.findIndex((n) => n.id === id);
      state.lesson.notes[i] = { ...state.lesson.notes[i], ...result };
      closeDialog();
      renderLesson(state.lesson, state.current.tab);
      toast("Your note is saved.");
    } else closeDialog();
    refreshLibrary().catch(() => {});
  } catch (e) {
    if (form.isConnected) {
      $("#note-error").innerHTML = errorBox(e.message, "retry-note");
      button.disabled = false;
    }
  }
}
function renameCourse(id) {
  const c = state.courses.find((c) => c.id === Number(id));
  if (!c) return;
  showDialog(
    "Rename course",
    `<form id="course-form" data-id="${c.id}"><label class="field-label" for="course-title">Course title</label><input class="input" id="course-title" value="${esc(c.title)}" required maxlength="160"><p class="small muted" style="margin:13px 0 20px">This title will stay when the extension saves new notes.</p><button type="submit" class="button primary">Save title${icon("check")}</button><div id="course-error"></div></form>`,
  );
  $("#course-title").focus();
}
async function saveCourse(form) {
  const title = $("#course-title").value.trim();
  if (!title) return;
  const button = $("button[type=submit]", form);
  button.disabled = true;
  try {
    await api("/api/courses/" + form.dataset.id, {
      method: "PATCH",
      body: { title },
    });
    closeDialog();
    await refreshLibrary();
    route();
    toast("Course title updated.");
  } catch (e) {
    if (form.isConnected) {
      $("#course-error").innerHTML = errorBox(e.message, "retry-course");
      button.disabled = false;
    }
  }
}
function draftKey() {
  return (
    state.lesson && state.questions?.[state.questionIndex[state.lesson.id] || 0]
  );
}
function saveDraft(value) {
  const l = state.lesson,
    q = draftKey();
  if (!l || !q) return;
  drafts[l.id] ||= {};
  drafts[l.id][q] = value;
  store("sn-answer-drafts", drafts);
}
async function checkAnswer() {
  const l = state.lesson,
    q = draftKey(),
    answer = $("#practice-answer").value.trim(),
    epoch = state.epoch;
  if (!q || !answer) {
    $("#practice-answer").focus();
    return;
  }
  const button = $('[data-action="check-answer"]');
  button.disabled = true;
  $("#question-status").innerHTML =
    '<span class="spinner" aria-hidden="true"></span> Checking against your lesson…';
  try {
    const result = await api(`/api/lessons/${l.id}/answers`, {
      method: "POST",
      body: { question: q, answer },
    });
    l.answers.push(result);
    if (drafts[l.id]?.[q]?.trim() === answer) {
      delete drafts[l.id][q];
      store("sn-answer-drafts", drafts);
    }
    if (epoch === state.epoch) {
      $("#practice-container").innerHTML = questionMarkup(l, state.questions);
      toast("Your answer and feedback are saved.");
    }
  } catch (e) {
    if (epoch === state.epoch) {
      $("#question-status").innerHTML =
        `<span class="inline-error">${esc(e.message)}</span>`;
      button.disabled = false;
    }
  }
}
async function addPoint(button) {
  const l = state.lesson,
    text = button.dataset.text,
    t = button.dataset.t === "" ? null : Number(button.dataset.t),
    key = l.id + "/" + text;
  if (!pendingNotes.has(key)) pendingNotes.set(key, uid());
  button.disabled = true;
  try {
    const note = await api("/api/notes", {
      method: "POST",
      body: {
        id: pendingNotes.get(key),
        lesson: {
          url: l.url_key,
          title: l.title,
          course: l.course?.title || "",
          course_slug: l.course?.slug || "",
          module: l.module || "",
        },
        kind: "text",
        text,
        t,
      },
    });
    if (!l.notes.some((n) => n.id === note.id))
      l.notes.push({ ...note, context: paragraphAt(t)?.text || "" });
    if (button.isConnected)
      button.outerHTML =
        '<span class="small muted">' + icon("check") + " In my notes</span>";
    toast("Added to your personal notes.");
    refreshLibrary().catch(() => {});
  } catch (e) {
    if (button.isConnected) button.disabled = false;
    toast(e.message, true);
  }
}
function setDrawer(open) {
  document.body.classList.toggle("nav-open", open);
  $("#menu-toggle").setAttribute("aria-expanded", String(open));
  $("#menu-toggle").setAttribute(
    "aria-label",
    open ? "Close course navigation" : "Open course navigation",
  );
  if (open) {
    $(".drawer-close")?.focus();
  } else $("#menu-toggle").focus();
}
async function route() {
  savePosition();
  clearTimeout(state.poll);
  state.controller?.abort();
  state.controller = new AbortController();
  const epoch = ++state.epoch,
    route = parseRoute();
  state.current = route;
  state.lesson = null;
  state.questions = [];
  document.body.classList.remove("nav-open");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
  if ($("#dialog").open) closeDialog();
  renderNavigation();
  window.scrollTo({ top: 0, behavior: "instant" });
  try {
    if (
      !["overview", "library", "lesson", "review", "ask", "search"].includes(
        route.page,
      )
    ) {
      navigate("#", true);
      return;
    }
    if (!["overview", "library"].includes(route.page) && !state.courses.length)
      await refreshLibrary(state.controller.signal);
    if (epoch !== state.epoch) return;
    if (route.page === "overview" || route.page === "library")
      await home(route, epoch);
    else if (route.page === "lesson") await lessonPage(route, epoch);
    else if (route.page === "review") await reviewPage(route, epoch);
    else if (route.page === "search") await searchPage(route, epoch);
    else askPage(route);
    if (epoch !== state.epoch) return;
    renderNavigation();
    if (state.focusTab && route.page === "lesson") {
      $("#tab-" + state.focusTab)?.focus({ preventScroll: true });
      state.focusTab = null;
    }
    if (route.page !== "lesson")
      window.scrollTo({ top: 0, behavior: "instant" });
  } catch (e) {
    if (e.name !== "AbortError" && epoch === state.epoch) {
      setPage("Couldn’t open this page", errorBox(e.message));
    }
  }
}
// Keep the course drawer in the same document, with explicit dismissal and focus return.
const drawerClose = document.createElement("button");
drawerClose.className = "icon-button drawer-close";
drawerClose.dataset.action = "menu";
drawerClose.setAttribute("aria-label", "Close course navigation");
drawerClose.innerHTML = icon("close");
$("#sidebar").prepend(drawerClose);
const scrim = document.createElement("button");
scrim.className = "nav-scrim";
scrim.dataset.action = "menu";
scrim.tabIndex = -1;
scrim.setAttribute("aria-label", "Close course navigation");
document.body.append(scrim);
document.addEventListener("click", async (e) => {
  const section = e.target.closest("[data-section]");
  if (section) {
    e.preventDefault();
    document.getElementById(section.dataset.section)?.scrollIntoView({
      block: "start",
      behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
        ? "instant"
        : "smooth",
    });
    return;
  }
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    navigate(lessonHref(state.lesson.id, tab.dataset.tab));
    return;
  }
  const a = e.target.closest("a[href]");
  if (a?.getAttribute("href") === "#main") {
    e.preventDefault();
    $("#main").focus({ preventScroll: true });
    $("#main").scrollIntoView({ block: "start", behavior: "instant" });
    return;
  }
  if (a?.getAttribute("href")?.startsWith("#")) {
    if ($("#dialog").open) closeDialog();
    if (document.body.classList.contains("nav-open")) setDrawer(false);
    if (a.hash === location.hash) {
      e.preventDefault();
      route();
    }
    return;
  }
  const b = e.target.closest("button[data-action]");
  if (!b || b.disabled) return;
  const action = b.dataset.action;
  try {
    if (action === "menu")
      setDrawer(!document.body.classList.contains("nav-open"));
    else if (action === "preferences") preferencesDialog();
    else if (action === "close-dialog") closeDialog();
    else if (action === "preference") {
      preferences[b.dataset.key] = b.dataset.value;
      store("sn-preferences", preferences);
      applyPreferences();
      $$('[data-action="preference"]').forEach((el) =>
        el.setAttribute(
          "aria-pressed",
          String(preferences[el.dataset.key] === el.dataset.value),
        ),
      );
    } else if (action === "filter") {
      state.filter = b.dataset.filter;
      const top = window.scrollY;
      const epoch = state.epoch;
      await home(state.current, epoch);
      if (epoch === state.epoch) window.scrollTo({ top, behavior: "instant" });
    } else if (action === "rename-course") renameCourse(b.dataset.courseId);
    else if (action === "retry-route") route();
    else if (action === "source") updateSource(Number(b.dataset.t), true);
    else if (action === "preview") previewNote(b.dataset.note);
    else if (action === "zoom") {
      const box = $(".preview-viewport");
      box.classList.toggle("zoom");
      b.innerHTML =
        icon("expand") +
        (box.classList.contains("zoom") ? "Fit to window" : "Actual size");
    } else if (action === "edit-note") editNote(b.dataset.note);
    else if (action === "retry-note") $("#note-form").requestSubmit();
    else if (action === "retry-course") $("#course-form").requestSubmit();
    else if (action === "lesson-menu")
      showDialog(
        "Lesson actions",
        `<div class="lesson-menu"><a class="button" href="/api/lessons/${state.lesson.id}/export.md" target="_blank" rel="noopener noreferrer">${icon("download")}Export Markdown</a><button class="button" data-action="regenerate" ${["queued", "running"].includes(state.lesson.job?.status) ? "disabled" : ""}>${icon("refresh")}Regenerate study notes</button><p class="small muted">Regeneration keeps your personal notes. Review progress is kept for unchanged card questions.</p></div>`,
      );
    else if (action === "regenerate") {
      closeDialog();
      processLesson();
    } else if (action === "process") processLesson();
    else if (action === "retry-job" && state.lesson?.job)
      pollJob(state.lesson.job.id, state.epoch);
    else if (action === "reload-lesson")
      navigate(lessonHref(state.lesson.id, "study"));
    else if (action === "question-prev" || action === "question-next") {
      const id = state.lesson.id;
      state.questionIndex[id] = Math.max(
        0,
        Math.min(
          (state.questionIndex[id] || 0) +
            (action === "question-next" ? 1 : -1),
          state.questions.length - 1,
        ),
      );
      $("#practice-container").innerHTML = questionMarkup(
        state.lesson,
        state.questions,
      );
    } else if (action === "check-answer") checkAnswer();
    else if (action === "add-point") addPoint(b);
    else if (action === "delete-answer")
      showDialog(
        "Delete this answer?",
        `<p class="muted" style="margin-bottom:20px">This removes your answer and its feedback from the lesson.</p><button class="button" data-action="confirm-delete-answer" data-id="${Number(b.dataset.id)}">Delete answer</button>`,
      );
    else if (action === "confirm-delete-answer") {
      const epoch = state.epoch;
      b.disabled = true;
      await api("/api/answers/" + Number(b.dataset.id), { method: "DELETE" });
      if (epoch === state.epoch) {
        state.lesson.answers = state.lesson.answers.filter(
          (a) => a.id !== Number(b.dataset.id),
        );
        closeDialog();
        $("#practice-container").innerHTML = questionMarkup(
          state.lesson,
          state.questions,
        );
        toast("Answer deleted.");
      }
    } else if (action === "review-size") {
      state.review.size = Number(b.dataset.size);
      renderReview();
    } else if (action === "start-review") startReview();
    else if (action === "reveal") {
      state.review.revealed = true;
      renderReview();
      $('[data-action="grade"]')?.focus();
      announce("Answer revealed.");
    } else if (action === "grade") grade(b.dataset.correct === "true");
    else if (action === "retry-grade") grade(state.review.pending?.correct);
    else if (action === "undo-review") undoReview();
    else if (action === "end-review") {
      state.review.phase = "setup";
      state.review.error = null;
      state.review.summary = await api(
        "/api/review/summary?" + state.review.scope,
      );
      renderReview();
    } else if (action === "review-more") reviewPage(state.current, state.epoch);
    else if (action === "ask-example") {
      $("#ask-q").value = b.dataset.q;
      askQuestion();
    } else if (action === "retry-ask") askQuestion();
    else if (action === "citation") {
      const source = $("#source-" + b.dataset.source);
      if (source) {
        $$(".source-card").forEach((el) => (el.open = false));
        source.open = true;
        source.scrollIntoView({
          block: "center",
          behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
            ? "instant"
            : "smooth",
        });
        announce("Source " + b.dataset.source + " expanded.");
      }
    }
  } catch (err) {
    toast(err.message, true);
    b.disabled = false;
  }
});
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (form.id === "search-form") {
    e.preventDefault();
    const q = $("#search-q").value.trim();
    if (!q) return;
    const params = new URLSearchParams({ q });
    if ($("#search-course").value)
      params.set("course", $("#search-course").value);
    if ($("#search-kind").value !== "all")
      params.set("kind", $("#search-kind").value);
    navigate("#search?" + params);
  } else if (form.id === "ask-form") {
    e.preventDefault();
    askQuestion();
  } else if (form.id === "note-form") {
    e.preventDefault();
    saveNote(form);
  } else if (form.id === "course-form") {
    e.preventDefault();
    saveCourse(form);
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "practice-answer") saveDraft(e.target.value);
  if (e.target.id === "transcript-find") {
    state.transcriptQuery = e.target.value;
    transcriptRows();
  }
});
document.addEventListener(
  "toggle",
  (e) => {
    if (e.target.matches?.("details[data-module-key]")) {
      modules[e.target.dataset.moduleKey] = e.target.open;
      store("sn-open-modules", modules);
    }
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
    setDrawer(false);
    return;
  }
  if (document.body.classList.contains("nav-open") && e.key === "Tab") {
    const focusables = $$("a[href],button:not(:disabled)", $("#sidebar")),
      first = focusables[0],
      last = focusables.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
    return;
  }
  if ($("#dialog").open) return;
  if (e.target.matches("input,textarea,select,[contenteditable=true]")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    navigate("#search");
    return;
  }
  if (
    e.target.matches("[role=tab]") &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    const tabs = $$("[role=tab]"),
      i = tabs.indexOf(e.target),
      next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? tabs.length - 1
            : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
    const id = tabs[next].dataset.tab;
    state.focusTab = id;
    navigate(lessonHref(state.lesson.id, id));
    return;
  }
  const r = state.review;
  if (
    state.current?.page === "review" &&
    r?.phase === "active" &&
    r.index < r.cards.length &&
    !r.busy &&
    !r.pending
  ) {
    if (e.code === "Space" && !r.revealed) {
      e.preventDefault();
      r.revealed = true;
      renderReview();
      $('[data-action="grade"]')?.focus();
    } else if (e.key === "1" && r.revealed) grade(false);
    else if (e.key === "2" && r.revealed) grade(true);
  }
});
$("#dialog").addEventListener("click", (e) => {
  if (e.target !== $("#dialog")) return;
  const r = e.target.getBoundingClientRect();
  if (
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  )
    closeDialog();
});
$("#dialog").addEventListener("close", () => {
  if (returnFocus?.isConnected) returnFocus.focus();
});
addEventListener("hashchange", route);
addEventListener("pagehide", savePosition);
route();
refreshSummary();
