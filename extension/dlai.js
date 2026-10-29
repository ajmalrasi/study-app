// Self-contained: Chrome serializes this function into the signed-in page.
// Read only the course/lesson payload from HTML; never return session data.
export async function fetchDlaiCourse(action, targetUrl) {
  try {
    if (location.hostname !== "learn.deeplearning.ai") throw new Error("Open the signed-in DeepLearning.AI course first.");
    const target = new URL(targetUrl, location.origin);
    const match = target.pathname.match(/^\/courses\/([a-zA-Z0-9_-]+)(?:\/lesson\/([a-zA-Z0-9_-]+)\/[^/]+)?\/?$/);
    const currentCourse = location.pathname.match(/^\/courses\/([^/]+)/)?.[1];
    if (target.origin !== location.origin || !match || match[1] !== currentCourse)
      throw new Error("Choose a lesson from the course open in this tab.");
    target.hash = "";
    target.search = "";
    const response = await fetch(target.href, { credentials: "same-origin", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`DeepLearning.AI request failed (${response.status}). Sign in and retry.`);
    const finalUrl = new URL(response.url || target.href);
    if (finalUrl.origin !== target.origin || !(finalUrl.pathname === `/courses/${match[1]}` || finalUrl.pathname.startsWith(`/courses/${match[1]}/`)))
      throw new Error("DeepLearning.AI redirected to sign-in or another course. Sign in and retry.");
    const page = new DOMParser().parseFromString(await response.text(), "text/html");
    const script = page.querySelector('script[id="__NEXT_DATA__"]');
    if (!script) throw new Error("The course page format changed. Its complete outline could not be verified.");
    const props = JSON.parse(script.textContent).props?.pageProps;
    const queries = props?.trpcState?.json?.queries;
    if (!Array.isArray(queries)) throw new Error("Course data is unavailable. Sign in and retry.");
    const course = queries.map(q => q.state?.data).find(d => d?.slug === match[1] && d.lessons && Array.isArray(d.listing));
    if (!course || props.courseName !== match[1]) throw new Error("The response does not identify the requested course.");
    if (action === "curriculum") {
      const lessons = course.lessons;
      const ids = Object.keys(lessons);
      if (!ids.length || ids.length > 20000 || !course.listing.length) throw new Error("The course has no verifiable lesson inventory.");
      const seen = new Set(), sections = [], sectionIds = new Set();
      const links = new Map();
      for (const link of page.querySelectorAll('a[href]')) {
        const url = new URL(link.getAttribute("href"), target.origin);
        const path = url.pathname.match(/^\/courses\/([^/]+)\/lesson\/([^/]+)\/[^/]+\/?$/);
        if (url.origin === target.origin && path?.[1] === course.slug) links.set(path[2], url.href);
      }
      for (const [index, module] of course.listing.entries()) {
        if (!Array.isArray(module.content) || !module.content.length) throw new Error("A module is empty or incomplete. Sync was not saved.");
        const id = (module.moduleLabel || `section-${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!id || sectionIds.has(id)) throw new Error("Module identifiers are ambiguous. Sync was not saved.");
        sectionIds.add(id);
        const section = { id, title: [module.moduleLabel, module.name].filter(Boolean).join(": ") || `Section ${index + 1}`, items: [] };
        for (const entry of module.content) {
          const lesson = lessons[entry.key];
          if (entry.type !== "lesson" || !lesson || lesson.slug !== entry.key || seen.has(entry.key) || !/^[a-zA-Z0-9_-]+$/.test(entry.key))
            throw new Error("The module outline is incomplete or contains duplicate lessons. Sync was not saved.");
          if (!lesson.name || !lesson.type) throw new Error("Some lesson metadata is missing.");
          seen.add(entry.key);
          const kind = lesson.type === "video" ? "video" : lesson.type === "quiz" ? "quiz"
            : lesson.type === "reading_material" ? "article" : "other";
          const url = links.get(entry.key) || `${target.origin}/courses/${course.slug}/lesson/${entry.key}/${encodeURIComponent(lesson.name.toLowerCase().replace(/\s+/g, "-"))}`;
          section.items.push({ id: entry.key, title: lesson.name, kind, url });
        }
        sections.push(section);
      }
      if (seen.size !== ids.length || ids.some(id => !seen.has(id))) throw new Error("Some lessons are absent from the module outline. Sync was not saved.");
      return { platform: "deeplearning", platform_course_id: String(course.courseId), course_slug: course.slug,
        course_title: course.name, sections, item_count: sections.length + seen.size, complete: true };
    }
    if (action !== "caption" || !match[2]) throw new Error("Choose a video lesson to import.");
    const lesson = course.lessons[match[2]];
    if (props.lessonId !== match[2] || !lesson || lesson.type !== "video") throw new Error("The response is not the requested video lesson.");
    const video = queries.map(q => q.state?.data?.video).find(v => v && String(v.videoId) === String(lesson.videoId));
    if (!video) throw new Error("This video's captions are not accessible in the current session. Check your course access and retry.");
    let tracks = (video.tracks || []).filter(t => t.src && ["subtitles", "captions"].includes(t.kind));
    if (!tracks.length && video.subtitle) {
      const subtitles = typeof video.subtitle === "string" ? JSON.parse(video.subtitle) : video.subtitle;
      tracks = Object.entries(subtitles).filter(([,t]) => t?.URI).map(([language,t]) => ({ src: t.URI, srcLang: language }));
    }
    const track = tracks.find(t => /^en/i.test(t.srcLang || t.srclang || "")) || tracks[0];
    if (!track) return { noCaptions: true, error: "No captions are available for this video." };
    const load = async (address, depth = 0) => {
      const url = new URL(address, target.origin);
      if (url.protocol !== "https:" || !["video.deeplearning.ai", "learn.deeplearning.ai"].includes(url.hostname) || depth > 2)
        throw new Error("The caption URL is outside the supported video service.");
      const r = await fetch(url.href, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`Caption download failed (${r.status}). Retry to refresh its link.`);
      const text = (await r.text()).trimStart();
      if (text.startsWith("WEBVTT")) return text;
      if (!text.startsWith("#EXTM3U")) throw new Error("The caption format is not supported.");
      const segments = text.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));
      if (!segments.length || segments.length > 1000) throw new Error("The subtitle playlist is incomplete or too large.");
      const parts = [];
      for (const segment of segments) {
        const part = await load(new URL(segment, url).href, depth + 1);
        parts.push(parts.length ? part.replace(/^WEBVTT[^\n]*\n(?:X-TIMESTAMP[^\n]*\n)?/, "") : part);
      }
      return parts.join("\n\n");
    };
    return { vtt: await load(track.src), src: track.src };
  } catch (e) { return { error: e.message }; }
}
