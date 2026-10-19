// Jump to a timestamp when a lesson is opened from the review page (link ends in #sn_t=<seconds>).
(() => {
  const seekFromHash = () => {
    const m = location.hash.match(/sn_t=(\d+(?:\.\d+)?)/);
    if (!m) return;
    const t = parseFloat(m[1]);
    let tries = 0;
    const timer = setInterval(() => {
      const v = document.querySelector("video");
      if (v && v.readyState >= 1) {
        v.currentTime = t;
        history.replaceState(null, "", location.pathname + location.search);
        clearInterval(timer);
      } else if (++tries > 60) clearInterval(timer);
    }, 500);
  };
  seekFromHash();
  window.addEventListener("hashchange", seekFromHash);
})();
