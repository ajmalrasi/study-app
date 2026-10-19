// Functions injected into the lesson page (MAIN world) with chrome.scripting.executeScript.
// Each must be self-contained: Chrome serializes the function source, not its closure.
// Site-specific bits for DeepLearning.AI live here; the generic fallback is "largest <video>".

export function probePage() {
  const videos = [...document.querySelectorAll("video")];
  const video = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  const url = location.href;
  const m = location.pathname.match(/\/courses\/([^/]+)\/lesson\/[^/]+\/([^/?#]+)/);
  let title = document.title, course = "", courseSlug = "", module = "";
  if (m) {
    courseSlug = m[1];
    course = document.title.replace(/\s*-\s*DeepLearning\.AI.*$/i, "").trim() || courseSlug;
    const slug = decodeURIComponent(m[2]).replace(/-/g, " ").trim();
    title = slug.charAt(0).toUpperCase() + slug.slice(1);
    const crumb = [...document.querySelectorAll("nav, header")].map((n) => n.innerText).join(" ");
    module = (crumb.match(/Module\s+\d+/i) || [""])[0];
  }
  if (!video) return { hasVideo: false, url, title, course, courseSlug, module };
  // The <video> can report a 0 height while its container is what's visible.
  let el = video, rect = el.getBoundingClientRect();
  while (el.parentElement && rect.height < 50) {
    el = el.parentElement;
    rect = el.getBoundingClientRect();
  }
  return {
    hasVideo: true, url, title, course, courseSlug, module,
    t: video.currentTime, duration: isFinite(video.duration) ? video.duration : null, paused: video.paused,
    rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
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
