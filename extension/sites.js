export function isSupportedSite(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "learn.deeplearning.ai" ||
      url.hostname === "udemy.com" || url.hostname.endsWith(".udemy.com"));
  } catch { return false; }
}

export function isLessonUrl(value) {
  if (!isSupportedSite(value)) return false;
  const url = new URL(value);
  return url.hostname === "learn.deeplearning.ai"
    ? /^\/courses\/[^/]+\/lesson\//.test(url.pathname)
    : /^\/course\/[^/]+\/learn\/lecture\/\d+(?:\/|$)/.test(url.pathname);
}
