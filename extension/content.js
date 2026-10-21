// Jump to a timestamp when a lesson is opened from the review page (link ends in #sn_t=<seconds>).
(() => {
  let timer;
  const seekFromHash = () => {
    const m = location.hash.match(/sn_t=(\d+(?:\.\d+)?)/);
    if (!m) return;
    clearInterval(timer);
    const t = parseFloat(m[1]);
    const path = location.pathname;
    let tries = 0, stable = 0, sought = false;
    // Capture the hash at document_start: Udemy replaces it during player setup.
    // The player's resume position can also arrive after loadedmetadata, so verify
    // that the requested position survives setup before retiring the seek.
    timer = setInterval(() => {
      if (location.pathname !== path || ++tries > 60) return clearInterval(timer);
      const v = [...document.querySelectorAll("video")]
        .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      if (v && v.readyState >= 1) {
        const target = Number.isFinite(v.duration) ? Math.min(t, v.duration) : t;
        if (!sought || v.currentTime < target - 0.5 || v.currentTime > target + 5) {
          v.currentTime = target;
          sought = true;
          stable = 0;
        } else if (++stable >= 4) {
          const hash = location.hash.replace(/(?:[&?])?sn_t=\d+(?:\.\d+)?/, "");
          history.replaceState(null, "", location.pathname + location.search + (hash === "#" ? "" : hash));
          clearInterval(timer);
        }
      }
    }, 500);
  };
  seekFromHash();
  window.addEventListener("hashchange", seekFromHash);
})();
