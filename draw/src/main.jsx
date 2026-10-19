// Excalidraw editor for one note: /draw/?note=<id>
// Screenshots open as a locked background image to draw on; sketches start blank.
// Saves the scene (editable later) plus a PNG render (for the timeline and markdown).
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, convertToExcalidrawElements, exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./style.css";

const noteId = new URLSearchParams(location.search).get("note");
const SCENE_WIDTH = 1000; // screenshots are placed at this width in scene units

const fmtT = (t) => {
  if (t == null) return "";
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
};

const blobToDataUrl = (blob) =>
  new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });

const imageSize = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = src;
  });

// Marker-pen colours and widths for the top bar. Excalidraw draws a pen line about 4.25 px per unit
// of stroke width, and its thinnest menu option (1) looks bold, so Fine/Medium go below it.
const COLORS = [
  { name: "Red", v: "#ff1a1a" }, { name: "Green", v: "#00b33c" }, { name: "Blue", v: "#1660ff" }, { name: "Black", v: "#111111" },
];
const WIDTHS = [{ name: "Fine", v: 0.25 }, { name: "Medium", v: 0.5 }, { name: "Bold", v: 1 }];

// Last choices, remembered in this browser (colour separately for slides and blank sketches).
const remembered = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const remember = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
};

// Open ready to draw: pen tool, fully opaque. Zen mode hides the style panel (colour/width/opacity/
// layers) that Excalidraw shows for every tool.
const pen = (onSlide) => ({
  currentItemStrokeWidth: remembered("sn-pen-width", WIDTHS[0].v),
  currentItemStrokeColor: remembered(onSlide ? "sn-pen-color-slide" : "sn-pen-color-sketch", onSlide ? COLORS[0].v : COLORS[3].v),
  currentItemOpacity: 100, currentItemRoughness: 0, currentItemStrokeStyle: "solid", zenModeEnabled: true,
});

async function loadInitialData(note) {
  if (note.scene) {
    const { elements = [], appState = {}, files = {} } = note.scene;
    const onSlide = elements.some((e) => e.type === "image" && !e.isDeleted);
    return {
      elements, files, scrollToContent: true,
      appState: { ...pen(onSlide), viewBackgroundColor: appState.viewBackgroundColor || "#ffffff" },
    };
  }
  if (note.image) {
    const blob = await (await fetch(`/files/${note.image}`)).blob();
    const dataURL = await blobToDataUrl(blob);
    const { w, h } = await imageSize(dataURL);
    const fileId = `shot-${note.id}`;
    const [image] = convertToExcalidrawElements([
      { type: "image", fileId, x: 0, y: 0, width: SCENE_WIDTH, height: Math.round((SCENE_WIDTH * h) / w) },
    ]);
    image.locked = true; // draw on top without accidentally moving the slide
    return {
      elements: [image],
      files: { [fileId]: { id: fileId, dataURL, mimeType: blob.type || "image/jpeg", created: Date.now() } },
      appState: { ...pen(true), viewBackgroundColor: "#ffffff" },
      scrollToContent: true,
    };
  }
  return { elements: [], appState: { ...pen(false), viewBackgroundColor: "#ffffff" } };
}

/** Zoom so the screenshot fills the window (it was placed at a fixed size, which looks tiny in a big window). */
function fitSlide(api) {
  const slide = api?.getSceneElements().find((e) => e.type === "image" && !e.isDeleted);
  if (slide) api.scrollToContent(slide, { fitToViewport: true, viewportZoomFactor: 0.95, animate: false });
}

const signature = (elements) => elements.reduce((s, e) => s + e.version * 31 + (e.isDeleted ? 7 : 1), elements.length);

function App() {
  const [note, setNote] = useState(null);
  const [initialData, setInitialData] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const apiRef = useRef(null);
  const savedSig = useRef(null);
  const savedOnce = useRef(false);
  const saving = useRef(null);
  const onSlide = useRef(false);
  const [penState, setPenState] = useState({ color: null, width: null });

  useEffect(() => {
    if (!noteId) return setError("Missing ?note=<id> in the URL.");
    (async () => {
      const res = await fetch(`/api/notes/${noteId}`);
      if (!res.ok) throw new Error(res.status === 404 ? "Note not found." : `Server error ${res.status}`);
      const n = await res.json();
      setNote(n);
      document.title = `Draw · ${n.lesson.title}`;
      const data = await loadInitialData(n);
      // Nothing to save until something is drawn (a bare screenshot is already stored).
      savedSig.current = signature(data.elements);
      onSlide.current = data.elements.some((e) => e.type === "image" && !e.isDeleted);
      setPenState({ color: data.appState.currentItemStrokeColor, width: data.appState.currentItemStrokeWidth });
      setInitialData(data);
      savedOnce.current = Boolean(n.scene);
      setStatus(n.scene ? "saved" : "");
    })().catch((e) => setError(e.message));
  }, []);

  const save = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    if (saving.current) return saving.current;
    saving.current = (async () => {
      const elements = api.getSceneElements();
      const sig = signature(elements);
      const appState = api.getAppState();
      const used = new Set(elements.map((e) => e.fileId).filter(Boolean));
      const files = Object.fromEntries(Object.entries(api.getFiles()).filter(([id]) => used.has(id)));
      setStatus("saving");
      try {
        const blob = await exportToBlob({
          elements, files, mimeType: "image/png", exportPadding: 12,
          appState: { ...appState, exportBackground: true, exportWithDarkMode: false, exportScale: 2 },
        });
        const scene = JSON.parse(serializeAsJSON(elements, appState, files, "local"));
        const res = await fetch(`/api/notes/${noteId}/drawing`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scene, png: await blobToDataUrl(blob) }),
        });
        if (!res.ok) throw new Error(`save failed (${res.status})`);
        savedSig.current = sig;
        savedOnce.current = true;
        setStatus(signature(api.getSceneElements()) === sig ? "saved" : "unsaved");
      } catch (e) {
        setStatus("error");
        setError(e.message);
      }
    })().finally(() => (saving.current = null));
    return saving.current;
  }, []);

  // No autosave: nothing is kept unless you click Save (closing discards a new drawing).
  const onChange = useCallback((elements, appState) => {
    const dirty = savedSig.current !== signature(elements);
    setStatus((s) => (s === "saving" || s === "error" ? s : dirty ? "unsaved" : savedOnce.current ? "saved" : ""));
    // Keep the top-bar buttons in sync if the colour/width is changed from the style panel.
    setPenState((p) => (p.color === appState.currentItemStrokeColor && p.width === appState.currentItemStrokeWidth ? p
      : { color: appState.currentItemStrokeColor, width: appState.currentItemStrokeWidth }));
  }, []);

  const setPen = (patch) => {
    const api = apiRef.current;
    if (!api) return;
    const appState = {};
    if (patch.color) {
      appState.currentItemStrokeColor = patch.color;
      remember(onSlide.current ? "sn-pen-color-slide" : "sn-pen-color-sketch", patch.color);
    }
    if (patch.width) {
      appState.currentItemStrokeWidth = patch.width;
      remember("sn-pen-width", patch.width);
    }
    api.updateScene({ appState });
    api.setActiveTool({ type: "freedraw" });
  };

  const saveAndClose = async () => {
    await save();
    if (apiRef.current && savedSig.current === signature(apiRef.current.getSceneElements())) window.close();
  };

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    const onLeave = (e) => {
      if (apiRef.current && savedSig.current !== signature(apiRef.current.getSceneElements())) e.preventDefault();
    };
    let resizeTimer;
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => fitSlide(apiRef.current), 150); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("resize", onResize);
    };
  }, [save]);

  if (error && !initialData) return <div className="message">⚠ {error}</div>;
  if (!initialData) return <div className="message">Loading…</div>;

  return (
    <div className="page">
      <div className="bar">
        <div className="info">
          <b>{note.lesson.title}</b>
          {note.t != null && <span className="ts">{fmtT(note.t)}</span>}
          {note.context && <span className="context" title={note.context}>“{note.context}”</span>}
        </div>
        <span className={`status ${status}`}>
          {{ saved: "✓ Saved", saving: "Saving…", unsaved: "● Not saved", error: `⚠ ${error}` }[status] || ""}
        </span>
        <div className="pen" role="group" aria-label="Pen colour">
          {COLORS.map((c) => (
            <button key={c.v} className={`swatch${penState.color === c.v ? " on" : ""}`} title={c.name}
              style={{ "--c": c.v }} onClick={() => setPen({ color: c.v })} />
          ))}
        </div>
        <div className="pen" role="group" aria-label="Pen width">
          {WIDTHS.map((w) => (
            <button key={w.v} className={`width${penState.width === w.v ? " on" : ""}`} title={w.name} onClick={() => setPen({ width: w.v })}>
              <span style={{ height: `${Math.max(1, w.v * 4)}px` }} />
            </button>
          ))}
        </div>
        <button title="More options: other colours, opacity, layers" onClick={() => {
          const api = apiRef.current;
          api?.updateScene({ appState: { zenModeEnabled: !api.getAppState().zenModeEnabled } });
        }}>🎨 Style</button>
        <button onClick={() => save()}>Save</button>
        <button className="primary" onClick={saveAndClose}>Save &amp; close</button>
      </div>
      <div className="canvas">
        <Excalidraw
          excalidrawAPI={(api) => {
            apiRef.current = api;
            setTimeout(() => {
              api.setActiveTool({ type: "freedraw" }); // pen selected on open
              fitSlide(api);
            }, 50);
          }}
          initialData={initialData}
          onChange={onChange}
          theme="light" // dark mode colour-shifts the canvas, which turns bright red into muted orange
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
