// Excalidraw editor for one note: /draw/?note=<id>
// Screenshots open as a locked background image to draw on; sketches start blank.
// Saves the scene (editable later) plus a PNG render (for the timeline and markdown).
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, convertToExcalidrawElements, exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./style.css";

const noteId = new URLSearchParams(location.search).get("note");
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
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

// Open ready to draw: pen tool, thinnest line, fully opaque (red on slides, dark on blank sketches).
const PEN = { currentItemStrokeWidth: 1, currentItemOpacity: 100, currentItemRoughness: 0, currentItemStrokeStyle: "solid" };

async function loadInitialData(note) {
  if (note.scene) {
    const { elements = [], appState = {}, files = {} } = note.scene;
    const onSlide = elements.some((e) => e.type === "image" && !e.isDeleted);
    return {
      elements, files, scrollToContent: true,
      appState: { ...PEN, viewBackgroundColor: appState.viewBackgroundColor || "#ffffff", currentItemStrokeColor: onSlide ? "#e03131" : "#1e1e1e" },
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
      appState: { ...PEN, viewBackgroundColor: "#ffffff", currentItemStrokeColor: "#e03131" },
      scrollToContent: true,
    };
  }
  return { elements: [], appState: { ...PEN, viewBackgroundColor: "#ffffff", currentItemStrokeColor: "#1e1e1e" } };
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
  const onChange = useCallback((elements) => {
    const dirty = savedSig.current !== signature(elements);
    setStatus((s) => (s === "saving" || s === "error" ? s : dirty ? "unsaved" : savedOnce.current ? "saved" : ""));
  }, []);

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
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
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
        <button onClick={() => save()}>Save</button>
        <button className="primary" onClick={saveAndClose}>Save &amp; close</button>
      </div>
      <div className="canvas">
        <Excalidraw
          excalidrawAPI={(api) => {
            apiRef.current = api;
            setTimeout(() => api.setActiveTool({ type: "freedraw" }), 0); // pen selected on open
          }}
          initialData={initialData}
          onChange={onChange}
          theme={dark ? "dark" : "light"}
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
