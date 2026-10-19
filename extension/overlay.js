// Quick-note box shown over the lesson page (Alt+N). Injected on demand into the
// isolated world; resolves with {text, important} or null when cancelled.
window.__studyNotesOverlay ??= (label) =>
  new Promise((resolve) => {
    document.getElementById("__study-notes-overlay")?.remove();
    const host = Object.assign(document.createElement("div"), { id: "__study-notes-overlay" });
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .box { position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%); z-index: 2147483647;
          width: min(560px, calc(100vw - 32px)); background: #1c1c1f; color: #f2f2f4; border-radius: 12px;
          box-shadow: 0 12px 40px rgba(0,0,0,.45); padding: 12px; font: 14px/1.4 system-ui, sans-serif; }
        .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; color: #a8a8b0; font-size: 12px; }
        .top b { color: #8fb3ff; font-weight: 600; }
        textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; background: #2a2a2f; color: inherit;
          border: 1px solid #3a3a41; border-radius: 8px; padding: 8px 10px; font: inherit; outline: none; }
        textarea:focus { border-color: #6c9cff; }
        label { display: flex; gap: 6px; align-items: center; cursor: pointer; user-select: none; }
        .hint { margin-top: 6px; font-size: 11px; color: #85858e; }
      </style>
      <div class="box">
        <div class="top"><b></b><label><input type="checkbox" id="imp"> ⭐ important</label></div>
        <textarea placeholder="Type your note…"></textarea>
        <div class="hint">Enter to save · Shift+Enter new line · Esc to cancel</div>
      </div>`;
    root.querySelector("b").textContent = label;
    const ta = root.querySelector("textarea");
    const done = (value) => {
      host.remove();
      resolve(value);
    };
    // Keep the page (video player shortcuts like space/k/f) from seeing our keystrokes.
    ["keydown", "keyup", "keypress"].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation()));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const text = ta.value.trim();
        done(text ? { text, important: root.getElementById("imp").checked } : null);
      }
    });
    document.documentElement.appendChild(host);
    setTimeout(() => ta.focus(), 0);
  });
