// Functions injected into the lesson page (MAIN world) with chrome.scripting.executeScript.
// Each must be self-contained: Chrome serializes the function source, not its closure.
// Site-specific bits for DeepLearning.AI live here; the generic fallback is "largest <video>".

export function probePage() {
  const videos = [...document.querySelectorAll("video")];
  const video = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  const lessonUrl = new URL(location.href);
  lessonUrl.hash = "";
  const udemy = /(^|\.)udemy\.com$/.test(location.hostname);
  if (udemy) lessonUrl.search = "";
  const url = lessonUrl.href;
  const m = location.hostname === "learn.deeplearning.ai" && location.pathname.match(/^\/courses\/([^/]+)(?:\/lesson\/[^/]+\/([^/?#]+))?/);
  let title = document.title, course = "", courseSlug = "", module = "", platformCourseId = null, platform = null;
  if (m) {
    platform = "deeplearning";
    courseSlug = m[1];
    course = document.title.replace(/\s*-\s*DeepLearning\.AI.*$/i, "").trim() || courseSlug;
    const slug = decodeURIComponent(m[2] || "").replace(/-/g, " ").trim();
    title = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : course;
    const crumb = [...document.querySelectorAll("nav, header")].map((n) => n.innerText).join(" ");
    module = (crumb.match(/Module\s+\d+/i) || [""])[0];
  }
  if (udemy) {
    const match = location.pathname.match(/\/course\/([^/]+)(?:\/learn\/lecture\/(\d+))?/);
    if (match) {
      platform = "udemy";
      try {
        platformCourseId = JSON.parse(document.querySelector('[data-module-id="course-taking"]')?.getAttribute("data-module-args") || "{}").courseId || null;
      } catch { /* A partially mounted Udemy page can briefly have incomplete arguments. */ }
      if (!platformCourseId) {
        const report = [...document.querySelectorAll('a[href*="related_object_id="]')].find(a => /report/.test(a.href));
        platformCourseId = report ? new URL(report.href).searchParams.get("related_object_id") : null;
      }
      courseSlug = `udemy-${match[1]}`;
      const text = (selector) => document.querySelector(selector)?.textContent?.trim();
      course = text('[data-purpose="course-title"]') || text('header h1') || text('h1') || match[1].replace(/-/g, " ");
      title = text('[data-purpose="lecture-title"]') || text('[aria-current="true"] [data-purpose="item-title"]') ||
        (match[2] ? `Lecture ${match[2]}` : document.title);
      module = text('[data-purpose="section-panel"]:has([aria-current="true"]) [data-purpose="section-heading"]') || "";
      // A landing-page preview must not be saved as an enrolled lecture.
      if (!match[2]) return { hasVideo: false, url, title, course, courseSlug, module, platformCourseId, platform };
    }
  }
  if (!video) return { hasVideo: false, url, title, course, courseSlug, module, platformCourseId, platform };
  // The <video> can report a 0 height while its container is what's visible.
  let el = video, rect = el.getBoundingClientRect();
  while (el.parentElement && rect.height < 50) {
    el = el.parentElement;
    rect = el.getBoundingClientRect();
  }
  return {
    hasVideo: true, url, title, course, courseSlug, module, platformCourseId, platform,
    t: video.currentTime, duration: isFinite(video.duration) ? video.duration : null, paused: video.paused,
    rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}

// These functions deliberately do not require a <video> or navigate lessons.
// They run inside the signed-in Udemy tab; cookies never leave the browser.
export async function fetchUdemyCurriculum(courseId) {
  if (!/(^|\.)udemy\.com$/.test(location.hostname) || !/^\d+$/.test(String(courseId)))
    return { error: "Open the signed-in Udemy course first." };
  try {
    let next = `/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=200`;
    const seen = new Set(), rows = [];
    let expected = null;
    while (next) {
      const url = new URL(next, location.origin);
      if (url.origin !== location.origin || url.pathname !== `/api-2.0/courses/${courseId}/subscriber-curriculum-items/` || seen.has(url.href))
        throw new Error("The curriculum returned an invalid or repeated page.");
      seen.add(url.href);
      const response = await fetch(url.href, { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Udemy curriculum request failed (${response.status}). Sign in and retry.`);
      const data = await response.json();
      if (!Array.isArray(data.results) || !Number.isInteger(data.count) || (expected !== null && expected !== data.count))
        throw new Error("The course list changed while syncing. Retry the sync.");
      expected = data.count;
      rows.push(...data.results);
      if (rows.length > 20000 || seen.size > 200) throw new Error("The curriculum is larger than supported.");
      next = data.next;
    }
    if (rows.length !== expected) throw new Error("Some curriculum pages are missing. Retry the sync.");
    const sections = [];
    let section = null;
    for (const item of rows) {
      if (item._class === "chapter") {
        section = { id: String(item.id), title: item.title, items: [] };
        sections.push(section);
      } else {
        if (!section) throw new Error("A lesson has no section. The course list could not be verified.");
        const kind = item._class === "quiz" ? "quiz" : item.asset?.asset_type === "Video" ? "video"
          : item.asset?.asset_type === "Article" ? "article" : "other";
        section.items.push({ id: String(item.id), title: item.title, kind });
      }
    }
    return { sections, item_count: rows.length, complete: true };
  } catch (e) { return { error: e.message }; }
}

export async function fetchUdemyCaption(courseId, lectureId) {
  if (!/(^|\.)udemy\.com$/.test(location.hostname) || !/^\d+$/.test(String(courseId)) || !/^\d+$/.test(String(lectureId)))
    return { error: "A signed-in Udemy course tab is needed." };
  try {
    const response = await fetch(`/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=asset&fields[asset]=captions`,
      { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Udemy caption request failed (${response.status}). Sign in and retry.`);
    const lecture = await response.json();
    const captions = (lecture.asset?.captions || []).filter(c => c.url && c.status !== 0);
    const caption = captions.find(c => /^en/i.test(c.locale_id || c.language || "")) || captions[0];
    if (!caption) return { noCaptions: true, error: "No captions are available for this video." };
    const get = async url => {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`Caption download failed (${r.status}). Retry to refresh its link.`);
      return r.text();
    };
    let vtt = await get(caption.url);
    if (!vtt.trimStart().startsWith("WEBVTT")) {
      if (!vtt.trimStart().startsWith("#EXTM3U")) throw new Error("The caption format is not supported.");
      const segments = vtt.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));
      const parts = [];
      for (const segment of segments) {
        const part = await get(new URL(segment, caption.url).href);
        parts.push(parts.length ? part.replace(/^WEBVTT[^\n]*\n(?:X-TIMESTAMP[^\n]*\n)?/, "") : part);
      }
      vtt = parts.join("\n\n");
    }
    return { vtt, src: caption.url };
  } catch (e) { return { error: e.message }; }
}

export function controlVideo(action, value) {
  const video = [...document.querySelectorAll("video")]
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!video) return false;
  if (action === "pause") video.pause();
  if (action === "play") video.play().catch(() => {});
  if (action === "seek") video.currentTime = value;
  return true;
}

export function videoTime() {
  const video = [...document.querySelectorAll("video")]
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  return video ? { t: video.currentTime, paused: video.paused } : null;
}

export async function fetchTranscript() {
  const video = [...document.querySelectorAll("video")]
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!video) return { error: "no video on this page" };
  const get = async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${r.status} for ${u}`);
    return r.text();
  };
  const isEnglish = (s) => /^en/i.test(s || "");
  // A subtitle URL may be a .vtt file or an HLS playlist pointing at .vtt segments.
  const loadSubs = async (src) => {
    const text = await get(src);
    if (text.startsWith("WEBVTT")) return text;
    const segs = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const parts = await Promise.all(segs.map((s) => get(new URL(s, src).href)));
    // Join segments: keep the first header, strip later ones.
    return parts.map((p, i) => (i ? p.replace(/^WEBVTT[^\n]*\n(X-TIMESTAMP[^\n]*\n)?/, "") : p)).join("\n\n");
  };
  try {
    // Udemy's Shaka player renders captions itself, without native <track> elements.
    // Ask for the current lecture only; earlier lectures' resource URLs can remain loaded.
    if (/(^|\.)udemy\.com$/.test(location.hostname)) {
      const lectureId = location.pathname.match(/\/learn\/lecture\/(\d+)/)?.[1];
      const root = document.querySelector('[data-module-id="course-taking"]');
      const courseId = JSON.parse(root?.getAttribute("data-module-args") || "{}").courseId;
      if (!lectureId || !courseId) return { error: "Udemy lecture is still loading", retry: true };
      const endpoint = `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=asset&fields[asset]=captions`;
      const lecture = JSON.parse(await get(endpoint));
      const captions = (lecture.asset?.captions || []).filter((c) => c.url && c.status !== 0);
      const caption = captions.find((c) => isEnglish(c.locale_id || c.language)) || captions[0];
      if (!caption) return { error: "No captions available for this Udemy lecture" };
      const vtt = await loadSubs(caption.url);
      if (location.pathname.match(/\/learn\/lecture\/(\d+)/)?.[1] !== lectureId)
        return { error: "Lecture changed while loading captions", retry: true };
      return { vtt, src: caption.url };
    }
    // 1. <track> elements (logged-out preview of DLAI, many other sites).
    const track = [...video.querySelectorAll("track")].find((t) => isEnglish(t.srclang)) || video.querySelector("track");
    if (track?.src) return { vtt: await loadSubs(track.src), src: track.src };
    // 2. HLS master playlist with SUBTITLES renditions (logged-in DLAI).
    let master = /\.m3u8/.test(video.currentSrc) ? video.currentSrc : null;
    if (!master) {
      // hls.js plays from a blob: URL, so find the playlist among loaded resources. The site is a
      // single-page app, so earlier lessons' playlists are there too: prefer the one whose URL
      // shares the most words with this lesson's slug, then the most recent.
      const slug = decodeURIComponent(location.pathname.split("/").pop() || "").toLowerCase();
      const words = slug.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      let best = -1;
      for (const e of performance.getEntriesByType("resource")) {
        if (!/master\.m3u8/.test(e.name)) continue;
        const score = words.filter((w) => e.name.toLowerCase().includes(w)).length;
        if (score >= best) [best, master] = [score, e.name];
      }
      // Right after an in-app navigation only the previous lesson's playlist may be loaded.
      if (master && words.length && best === 0) return { error: "video playlist not loaded yet", retry: true };
    }
    if (master) {
      const lines = (await get(master)).split("\n").filter((l) => /TYPE=SUBTITLES/.test(l));
      const pick = lines.find((l) => /LANGUAGE="en/i.test(l)) || lines[0];
      const uri = pick?.match(/URI="([^"]+)"/)?.[1];
      if (uri) {
        const src = new URL(uri, master).href;
        return { vtt: await loadSubs(src), src };
      }
    }
    return { error: "no subtitles found for this video", retry: !master };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
