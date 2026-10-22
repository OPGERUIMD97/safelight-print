// ── Safelight Print Module ────────────────────────────────────────────────────
// Top-level Print tab (registerModule) with a WYSIWYG page preview.
// Photos are rendered through api.export.renderPhotos (develop pipeline).
// Falls back to Library thumbnails if export is unavailable.
// OS printing uses a hidden iframe (no window.open).

const PAPER_SIZES = [
  { id: "a4",     label: "A4",         w: 210,   h: 297 },
  { id: "a3",     label: "A3",         w: 297,   h: 420 },
  { id: "a5",     label: "A5",         w: 148,   h: 210 },
  { id: "10x15",  label: "10 × 15 cm", w: 100,   h: 150 },
  { id: "13x18",  label: "13 × 18 cm", w: 130,   h: 180 },
  { id: "20x30",  label: "20 × 30 cm", w: 200,   h: 300 },
  { id: "letter", label: "Letter",     w: 215.9, h: 279.4 },
];

const LAYOUTS = [
  { id: "1x1", label: "1 photo per page", cols: 1, rows: 1 },
  { id: "2x1", label: "2 per page",       cols: 2, rows: 1 },
  { id: "2x2", label: "4 per page",       cols: 2, rows: 2 },
  { id: "3x2", label: "6 per page",       cols: 3, rows: 2 },
  { id: "4x3", label: "Contact sheet",    cols: 4, rows: 3 },
];

const PRINT_PPI = 300;
const PREVIEW_LONG_EDGE = 1600;
const PRINT_FRAME_ID = "safelight-print-frame";
const MODULE_ID = "print";
const PANEL_ID = "safelight-print.settings";

function paperDims(paperId, orientation) {
  const def = PAPER_SIZES.find(p => p.id === paperId) || PAPER_SIZES[0];
  return orientation === "portrait"
    ? { w: def.w, h: def.h, def }
    : { w: def.h, h: def.w, def };
}

function layoutDef(id) {
  return LAYOUTS.find(l => l.id === id) || LAYOUTS[0];
}

function cellLongEdgeMm(pageW, pageH, marginMm, cols, rows) {
  const innerW = Math.max(1, pageW - marginMm * 2);
  const innerH = Math.max(1, pageH - marginMm * 2);
  const cellW = innerW / cols;
  const cellH = innerH / rows;
  return Math.max(cellW, cellH);
}

function mmToPx(mm, ppi) {
  return Math.max(1, Math.round(mm * ppi / 25.4));
}

function captionFor(photo, showFilename, showDate) {
  const parts = [];
  if (showFilename && photo.filename) parts.push(photo.filename);
  if (showDate && photo.dateCreated) {
    parts.push(new Date(photo.dateCreated).toLocaleDateString("en-US"));
  }
  return parts.join(" · ");
}

function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      listeners.forEach(fn => fn(state));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read image"));
    reader.readAsDataURL(blob);
  });
}

async function srcToDataUrl(src) {
  if (!src) return "";
  if (typeof src !== "string") {
    if (src instanceof Blob) return blobToDataUrl(src);
    return "";
  }
  if (src.startsWith("data:")) return src;
  try {
    const res = await fetch(src);
    if (!res.ok) return src;
    return blobToDataUrl(await res.blob());
  } catch {
    return src;
  }
}

function waitForImages(doc) {
  const imgs = Array.from(doc.images || []);
  return Promise.all(imgs.map(img => new Promise(resolve => {
    const done = () => resolve();
    if (img.complete && img.naturalWidth > 0) {
      if (typeof img.decode === "function") img.decode().then(done, done);
      else done();
      return;
    }
    img.addEventListener("load", () => {
      if (typeof img.decode === "function") img.decode().then(done, done);
      else done();
    }, { once: true });
    img.addEventListener("error", done, { once: true });
  })));
}

async function printHtmlInIframe(html) {
  const existing = document.getElementById(PRINT_FRAME_ID);
  if (existing) existing.remove();

  const iframe = document.createElement("iframe");
  iframe.id = PRINT_FRAME_ID;
  iframe.setAttribute("aria-hidden", "true");
  // Must have a real layout box: 0×0 / visibility:hidden prints a blank page in Electron.
  iframe.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:800px",
    "height:1100px",
    "border:0",
    "opacity:0",
    "pointer-events:none",
    "z-index:-1",
  ].join(";");
  document.body.appendChild(iframe);

  const win = iframe.contentWindow;
  const doc = iframe.contentDocument || (win && win.document);
  if (!win || !doc) {
    iframe.remove();
    throw new Error("Could not create a print frame.");
  }

  doc.open();
  doc.write(html);
  doc.close();

  await waitForImages(doc);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const cleanup = () => {
    const el = document.getElementById(PRINT_FRAME_ID);
    if (el) el.remove();
  };
  win.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(cleanup, 120000);
  win.focus();
  win.print();
}

function buildPrintDocument({ pageW, pageH, marginMm, cols, rows, pages, fitMode, showCaptions }) {
  const fit = fitMode === "cover" ? "cover" : "contain";
  let body = "";
  for (let p = 0; p < pages.length; p++) {
    const cells = pages[p].map(item => {
      const cap = item.caption
        ? `<div class="sl-caption">${item.caption}</div>`
        : "";
      const img = item.src
        ? `<img src="${item.src}" alt="" />`
        : `<div class="sl-placeholder">No preview</div>`;
      return `<div class="sl-cell">${img}${cap}</div>`;
    }).join("");
    const empties = cols * rows - pages[p].length;
    const pad = Array.from({ length: Math.max(0, empties) }, () =>
      `<div class="sl-cell sl-empty"></div>`).join("");
    body += `<div class="sl-page"><div class="sl-grid">${cells}${pad}</div></div>`;
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Safelight Print</title>
  <style>
    @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; }
    .sl-page {
      width: ${pageW}mm;
      height: ${pageH}mm;
      padding: ${marginMm}mm;
      page-break-after: always;
    }
    .sl-page:last-child { page-break-after: auto; }
    .sl-grid {
      width: 100%;
      height: 100%;
      display: grid;
      grid-template-columns: repeat(${cols}, 1fr);
      grid-template-rows: repeat(${rows}, 1fr);
      gap: 2mm;
    }
    .sl-cell {
      position: relative;
      min-width: 0; min-height: 0;
      overflow: hidden;
    }
    .sl-cell img, .sl-placeholder {
      position: absolute;
      inset: 0 0 ${showCaptions ? "10pt" : "0"} 0;
      width: 100%;
      height: 100%;
      object-fit: ${fit};
      display: block;
    }
    .sl-placeholder {
      background: #eee; color: #999;
      display: flex; align-items: center; justify-content: center;
      font: 10pt system-ui, sans-serif;
    }
    .sl-caption {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: 9pt;
      font: 7pt system-ui, sans-serif; color: #555;
      text-align: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sl-empty { visibility: hidden; }
    ${showCaptions ? "" : ".sl-caption { display: none; }"}
  </style>
</head>
<body>${body}</body>
</html>`;
}

export function activate(api) {
  const React = api.react;
  const { useState, useEffect, useMemo, useRef, useCallback } = React;
  const ce = (type, props, ...ch) => React.createElement(type, props, ...ch);
  const ui = api.ui || {};
  const tokens = ui.tokens || {};
  const t = (key, fallback) => tokens[key] || fallback;

  const settings = createStore({
    paper: "a4",
    layout: "1x1",
    orientation: "portrait",
    marginMm: 10,
    fitMode: "contain",
    showFilename: false,
    showDate: false,
  });

  const previewStatus = createStore({
    rendering: false, done: 0, total: 0, source: "thumb",
  });

  function useSettings() {
    const [s, setS] = useState(() => settings.get());
    useEffect(() => settings.subscribe(setS), []);
    const patch = useCallback(p => settings.set(p), []);
    return [s, patch];
  }

  function useSelectedPhotos() {
    const [photos, setPhotos] = useState([]);
    useEffect(() => {
      const store = api.stores.useCatalogStore;
      const sync = state => {
        const ids = state.selectedIds ? [...state.selectedIds] : [];
        const list = state.photos || [];
        const byId = new Map(list.map(p => [p.id, p]));
        setPhotos(ids.map(id => byId.get(id)).filter(Boolean));
      };
      const unsub = store.subscribe(sync);
      sync(store.getState());
      return unsub;
    }, []);
    return photos;
  }

  function usePreviewUrls(photos, longEdge) {
    const [urls, setUrls] = useState({});
    const [status, setStatus] = useState({ rendering: false, done: 0, total: 0, source: "thumb" });
    const urlsRef = useRef({});
    const genRef = useRef(0);

    useEffect(() => {
      const prev = urlsRef.current;
      Object.values(prev).forEach(entry => {
        if (entry && entry.revoke) URL.revokeObjectURL(entry.url);
      });
      urlsRef.current = {};
      setUrls({});

      if (!photos.length) {
        const idle = { rendering: false, done: 0, total: 0, source: "thumb" };
        setStatus(idle);
        previewStatus.set(idle);
        return;
      }

      const thumbs = {};
      for (const photo of photos) {
        if (api.catalog && api.catalog.requestThumbnail) {
          api.catalog.requestThumbnail(photo.id);
        }
        if (photo.thumbnailUrl) {
          thumbs[photo.id] = { url: photo.thumbnailUrl, revoke: false };
        }
      }
      urlsRef.current = thumbs;
      setUrls({ ...thumbs });

      const exportApi = api.export;
      if (!exportApi || typeof exportApi.renderPhotos !== "function") {
        const st = { rendering: false, done: photos.length, total: photos.length, source: "thumb" };
        setStatus(st);
        previewStatus.set(st);
        return;
      }

      const gen = ++genRef.current;
      let cancelled = false;
      const start = { rendering: true, done: 0, total: photos.length, source: "export" };
      setStatus(start);
      previewStatus.set(start);

      exportApi.renderPhotos(
        photos,
        { format: "image/jpeg", quality: 0.85, longEdge },
        ({ done, total }) => {
          if (!cancelled && gen === genRef.current) {
            const st = { rendering: true, done, total, source: "export" };
            setStatus(st);
            previewStatus.set(st);
          }
        }
      ).then(results => {
        if (cancelled || gen !== genRef.current) {
          results.forEach(r => { if (r.blob) {/* ignore */} });
          return;
        }
        const next = { ...urlsRef.current };
        for (const r of results) {
          const photo = r.photo;
          if (!photo) continue;
          if (r.blob) {
            const url = URL.createObjectURL(r.blob);
            const old = next[photo.id];
            if (old && old.revoke) URL.revokeObjectURL(old.url);
            next[photo.id] = { url, revoke: true };
          } else if (photo.thumbnailUrl) {
            next[photo.id] = { url: photo.thumbnailUrl, revoke: false };
          }
        }
        urlsRef.current = next;
        setUrls({ ...next });
        const done = { rendering: false, done: results.length, total: results.length, source: "export" };
        setStatus(done);
        previewStatus.set(done);
      }).catch(err => {
        console.error("[safelight-print] preview render", err);
        if (!cancelled && gen === genRef.current) {
          const st = { rendering: false, done: 0, total: photos.length, source: "thumb" };
          setStatus(st);
          previewStatus.set(st);
        }
      });

      return () => {
        cancelled = true;
      };
    }, [photos.map(p => p.id).join("|"), longEdge]);

    useEffect(() => () => {
      Object.values(urlsRef.current).forEach(entry => {
        if (entry && entry.revoke) URL.revokeObjectURL(entry.url);
      });
    }, []);

    return [urls, status];
  }

  async function renderForPrint(photos, longEdge, onProgress) {
    const exportApi = api.export;
    if (exportApi && typeof exportApi.renderPhotos === "function") {
      const results = await exportApi.renderPhotos(
        photos,
        { format: "image/jpeg", quality: 0.92, longEdge },
        onProgress
      );
      return Promise.all(results.map(async r => {
        const raw = r.blob || (r.photo && r.photo.thumbnailUrl) || "";
        const src = await srcToDataUrl(raw);
        return { photo: r.photo, src };
      }));
    }
    return Promise.all(photos.map(async photo => ({
      photo,
      src: await srcToDataUrl(photo.thumbnailUrl || ""),
    })));
  }

  function Field({ label, children }) {
    if (ui.Field) return ce(ui.Field, { label }, children);
    return ce("label", {
      style: {
        display: "flex", flexDirection: "column", gap: 4,
        fontSize: 11, color: t("textSecondary", "var(--color-text-secondary)"),
      },
    }, label, children);
  }

  function SettingsForm({ s, patch, photos, pageCount, perPage, status, printing, onPrint }) {
    const nativeSelect = (value, onChange, options) => {
      if (ui.Select) {
        return ce(ui.Select, { value, onChange, options });
      }
      return ce("select", {
        value,
        onChange: e => onChange(e.target.value),
        style: {
          width: "100%", padding: "4px 6px",
          background: t("surface3", "var(--color-surface-3)"),
          color: t("textPrimary", "var(--color-text-primary)"),
          border: `1px solid ${t("border", "var(--color-border)")}`,
          borderRadius: 4, fontSize: 11,
        },
      }, ...options.map(o => ce("option", { key: o.value, value: o.value }, o.label)));
    };

    const printBtn = ui.Button
      ? ce(ui.Button, {
          variant: "primary",
          full: true,
          disabled: printing || photos.length === 0,
          onClick: onPrint,
        }, printing ? "Printing…" : "Print")
      : ce("button", {
          type: "button",
          disabled: printing || photos.length === 0,
          onClick: onPrint,
          style: {
            width: "100%", padding: "9px 0", marginTop: 8,
            background: t("accent", "var(--color-accent)"),
            color: t("textPrimary", "var(--color-text-primary)"),
            border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600,
            cursor: printing || photos.length === 0 ? "not-allowed" : "pointer",
            opacity: printing || photos.length === 0 ? 0.5 : 1,
          },
        }, printing ? "Printing…" : "Print");

    const Section = ui.Section || (({ title, children }) => ce("div", { style: { marginBottom: 16 } },
      ce("div", {
        style: {
          fontSize: 10, fontWeight: 600, letterSpacing: "0.06em",
          textTransform: "uppercase", marginBottom: 8,
          color: t("textMuted", "var(--color-text-muted)"),
        },
      }, title),
      children
    ));

    const hint = photos.length === 0
      ? "Select photos in the Library, then open this tab."
      : `${photos.length} photo${photos.length === 1 ? "" : "s"} · ${pageCount} page${pageCount === 1 ? "" : "s"}`;

    const renderHint = status.rendering
      ? `Rendering ${status.done}/${status.total} via develop pipeline…`
      : status.source === "export"
        ? "Preview from develop pipeline (export render)."
        : "Preview from Library thumbnails (export API unavailable).";

    return ce("div", {
      style: {
        padding: 12, height: "100%", overflowY: "auto", boxSizing: "border-box",
        color: t("textPrimary", "var(--color-text-primary)"),
        fontFamily: t("fontMono", "system-ui, sans-serif"),
        fontSize: 12,
      },
    },
      ce(Section, { title: "Paper" },
        ce("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
          ce(Field, { label: "Size" },
            nativeSelect(s.paper, v => patch({ paper: v }),
              PAPER_SIZES.map(p => ({ value: p.id, label: p.label })))
          ),
          ce(Field, { label: "Orientation" },
            ui.SegmentedControl
              ? ce(ui.SegmentedControl, {
                  value: s.orientation,
                  onChange: v => patch({ orientation: v }),
                  options: [
                    { value: "portrait", label: "Portrait" },
                    { value: "landscape", label: "Landscape" },
                  ],
                })
              : nativeSelect(s.orientation, v => patch({ orientation: v }), [
                  { value: "portrait", label: "Portrait" },
                  { value: "landscape", label: "Landscape" },
                ])
          ),
          ce(Field, { label: "Margin (mm)" },
            ui.NumberInput
              ? ce(ui.NumberInput, {
                  value: s.marginMm,
                  min: 0, max: 50,
                  onChange: n => patch({ marginMm: Math.max(0, Math.min(50, n)) }),
                })
              : ce("input", {
                  type: "number", min: 0, max: 50, value: s.marginMm,
                  onChange: e => patch({ marginMm: Number(e.target.value) }),
                  style: { width: 72, padding: "4px 6px" },
                })
          )
        )
      ),
      ce(Section, { title: "Layout" },
        ce("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
          ce(Field, { label: "Arrangement" },
            nativeSelect(s.layout, v => patch({ layout: v }),
              LAYOUTS.map(l => ({ value: l.id, label: l.label })))
          ),
          ce(Field, { label: "Photo fit" },
            ui.SegmentedControl
              ? ce(ui.SegmentedControl, {
                  value: s.fitMode,
                  onChange: v => patch({ fitMode: v }),
                  options: [
                    { value: "contain", label: "Fit" },
                    { value: "cover", label: "Fill" },
                  ],
                })
              : nativeSelect(s.fitMode, v => patch({ fitMode: v }), [
                  { value: "contain", label: "Fit" },
                  { value: "cover", label: "Fill" },
                ])
          )
        )
      ),
      ce(Section, { title: "Captions" },
        ce("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          ui.Toggle
            ? ce(ui.Toggle, {
                checked: s.showFilename,
                label: "Filename",
                onChange: v => patch({ showFilename: v }),
              })
            : ce("label", { style: { display: "flex", gap: 6, alignItems: "center" } },
                ce("input", {
                  type: "checkbox", checked: s.showFilename,
                  onChange: e => patch({ showFilename: e.target.checked }),
                }),
                "Filename"
              ),
          ui.Toggle
            ? ce(ui.Toggle, {
                checked: s.showDate,
                label: "Capture date",
                onChange: v => patch({ showDate: v }),
              })
            : ce("label", { style: { display: "flex", gap: 6, alignItems: "center" } },
                ce("input", {
                  type: "checkbox", checked: s.showDate,
                  onChange: e => patch({ showDate: e.target.checked }),
                }),
                "Capture date"
              )
        )
      ),
      ce("div", {
        style: {
          fontSize: 11, lineHeight: 1.45, margin: "12px 0",
          color: t("textMuted", "var(--color-text-muted)"),
        },
      }, hint, ce("br"), renderHint, ce("br"),
        `${perPage} per page · ${PRINT_PPI} ppi on print`
      ),
      status.rendering && ui.ProgressBar && ce(ui.ProgressBar, {
        value: status.total ? status.done / status.total : 0,
      }),
      printBtn
    );
  }

  function PagePreview({ s, pagePhotos, urls }) {
    const { w: pageW, h: pageH } = paperDims(s.paper, s.orientation);
    const lay = layoutDef(s.layout);
    const showCaptions = s.showFilename || s.showDate;
    const empties = Math.max(0, lay.cols * lay.rows - pagePhotos.length);

    return ce("div", {
      style: {
        height: "100%", width: "100%", maxHeight: "100%", maxWidth: "100%",
        aspectRatio: `${pageW} / ${pageH}`,
        background: "#fff",
        color: "#111",
        padding: `${s.marginMm}mm`,
        boxSizing: "border-box",
        boxShadow: "0 12px 40px rgba(0,0,0,.45)",
        display: "grid",
        gridTemplateColumns: `repeat(${lay.cols}, 1fr)`,
        gridTemplateRows: `repeat(${lay.rows}, 1fr)`,
        gap: "2mm",
      },
    },
      ...pagePhotos.map(photo => {
        const entry = urls[photo.id];
        const src = (entry && entry.url) || photo.thumbnailUrl;
        const cap = captionFor(photo, s.showFilename, s.showDate);
        return ce("div", {
          key: photo.id,
          style: {
            minWidth: 0, minHeight: 0, overflow: "hidden",
            display: "flex", flexDirection: "column",
            background: "#f2f2f2",
          },
        },
          src
            ? ce("img", {
                src,
                alt: photo.filename || "",
                style: {
                  flex: 1, minHeight: 0, width: "100%",
                  objectFit: s.fitMode === "cover" ? "cover" : "contain",
                  display: "block",
                },
              })
            : ce("div", {
                style: {
                  flex: 1, display: "flex", alignItems: "center",
                  justifyContent: "center", color: "#999", fontSize: 11,
                },
              }, "No preview"),
          showCaptions && cap && ce("div", {
            style: {
              fontSize: 9, color: "#555", textAlign: "center",
              padding: "2px 0 0", whiteSpace: "nowrap", overflow: "hidden",
              textOverflow: "ellipsis",
            },
          }, cap)
        );
      }),
      ...Array.from({ length: empties }, (_, i) =>
        ce("div", { key: "empty-" + i, style: { background: "transparent" } })
      )
    );
  }

  function PrintModule() {
    const [s, patch] = useSettings();
    const photos = useSelectedPhotos();
    const [pageIndex, setPageIndex] = useState(0);
    const [printing, setPrinting] = useState(false);

    const { w: pageW, h: pageH } = paperDims(s.paper, s.orientation);
    const lay = layoutDef(s.layout);
    const perPage = lay.cols * lay.rows;
    const pageCount = Math.max(1, Math.ceil(photos.length / perPage) || 1);
    const safePage = Math.min(pageIndex, pageCount - 1);
    const pagePhotos = photos.slice(safePage * perPage, safePage * perPage + perPage);

    const previewEdge = useMemo(() => {
      const cellMm = cellLongEdgeMm(pageW, pageH, s.marginMm, lay.cols, lay.rows);
      return Math.min(PREVIEW_LONG_EDGE, mmToPx(cellMm, 150));
    }, [pageW, pageH, s.marginMm, lay.cols, lay.rows]);

    const printEdge = useMemo(() => {
      const cellMm = cellLongEdgeMm(pageW, pageH, s.marginMm, lay.cols, lay.rows);
      return mmToPx(cellMm, PRINT_PPI);
    }, [pageW, pageH, s.marginMm, lay.cols, lay.rows]);

    const photoKey = photos.map(p => p.id).join("|");
    const [urls, status] = usePreviewUrls(photos, previewEdge);

    useEffect(() => { setPageIndex(0); }, [photoKey, s.layout]);

    const doPrint = useCallback(async () => {
      if (!photos.length) return;
      setPrinting(true);
      let rendered = [];
      try {
        rendered = await renderForPrint(photos, printEdge);
        const pages = [];
        for (let i = 0; i < rendered.length; i += perPage) {
          const chunk = rendered.slice(i, i + perPage).map(item => ({
            src: item.src,
            caption: captionFor(item.photo, s.showFilename, s.showDate),
          }));
          pages.push(chunk);
        }
        const html = buildPrintDocument({
          pageW, pageH, marginMm: s.marginMm,
          cols: lay.cols, rows: lay.rows,
          pages, fitMode: s.fitMode,
          showCaptions: s.showFilename || s.showDate,
        });
        await printHtmlInIframe(html);
      } catch (err) {
        console.error("[safelight-print]", err);
        alert(`Print error: ${err.message || err}`);
      } finally {
        setPrinting(false);
      }
    }, [photos, printEdge, perPage, pageW, pageH, s, lay]);

    const go = dir => setPageIndex(i => Math.max(0, Math.min(pageCount - 1, i + dir)));

    const navBtn = (label, enabled, fn) => ui.Button
      ? ce(ui.Button, { size: "sm", disabled: !enabled, onClick: fn }, label)
      : ce("button", {
          type: "button", disabled: !enabled, onClick: fn,
          style: { padding: "4px 8px", fontSize: 11 },
        }, label);

    return ce("div", {
      style: {
        display: "flex", flexDirection: "column",
        height: "100%", width: "100%", minHeight: 0,
        background: t("surface0", "var(--color-surface-0)"),
        color: t("textPrimary", "var(--color-text-primary)"),
        boxSizing: "border-box",
      },
    },
      ce("div", {
        style: {
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px",
          borderBottom: `1px solid ${t("borderSubtle", "var(--color-border-subtle)")}`,
          flexShrink: 0,
        },
      },
        navBtn("‹", safePage > 0, () => go(-1)),
        ce("span", {
          style: { fontSize: 11, color: t("textSecondary", "var(--color-text-secondary)") },
        }, photos.length
          ? `Page ${safePage + 1} of ${pageCount}`
          : "No photos selected"),
        navBtn("›", safePage < pageCount - 1, () => go(1)),
        ce("span", { style: { flex: 1 } }),
        status.rendering && ce("span", {
          style: { fontSize: 11, color: t("textMuted", "var(--color-text-muted)") },
        }, `Rendering ${status.done}/${status.total}…`),
        ui.Button
          ? ce(ui.Button, {
              variant: "primary", size: "sm",
              disabled: printing || photos.length === 0,
              onClick: doPrint,
            }, printing ? "Printing…" : "Print")
          : ce("button", {
              type: "button",
              disabled: printing || photos.length === 0,
              onClick: doPrint,
              style: { padding: "4px 12px", fontSize: 11, fontWeight: 600 },
            }, printing ? "Printing…" : "Print")
      ),
      ce("div", {
        style: {
          flex: 1, minHeight: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          padding: 24, overflow: "hidden",
        },
      },
        photos.length === 0
          ? ce("div", {
              style: {
                color: t("textMuted", "var(--color-text-muted)"),
                fontSize: 13, textAlign: "center", lineHeight: 1.5,
              },
            }, "Select one or more photos in the Library,", ce("br"),
              "then return here to lay out the page.")
          : ce(PagePreview, { s, pagePhotos, urls })
      ),
      photos.length > 0 && ce("div", {
        style: {
          flexShrink: 0, height: 76, display: "flex", gap: 6,
          padding: "8px 12px", overflowX: "auto",
          borderTop: `1px solid ${t("borderSubtle", "var(--color-border-subtle)")}`,
          background: t("surface1", "var(--color-surface-1)"),
        },
      },
        ...photos.map((photo, i) => {
          const onPage = Math.floor(i / perPage) === safePage;
          const src = (urls[photo.id] && urls[photo.id].url) || photo.thumbnailUrl;
          return ce("button", {
            key: photo.id,
            type: "button",
            title: photo.filename || "",
            onClick: () => setPageIndex(Math.floor(i / perPage)),
            style: {
              padding: 0, border: onPage
                ? `2px solid ${t("accent", "var(--color-accent)")}`
                : `1px solid ${t("border", "var(--color-border)")}`,
              borderRadius: 3, background: "transparent", cursor: "pointer",
              width: 56, height: 56, overflow: "hidden", flexShrink: 0,
            },
          },
            src
              ? ce("img", {
                  src, alt: "",
                  style: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
                })
              : null
          );
        })
      )
    );
  }

  function PrintSettingsPanel() {
    const [s, patch] = useSettings();
    const photos = useSelectedPhotos();
    const [printing, setPrinting] = useState(false);
    const { w: pageW, h: pageH } = paperDims(s.paper, s.orientation);
    const lay = layoutDef(s.layout);
    const perPage = lay.cols * lay.rows;
    const pageCount = Math.max(1, Math.ceil((photos.length || 1) / perPage));
    const printEdge = mmToPx(
      cellLongEdgeMm(pageW, pageH, s.marginMm, lay.cols, lay.rows),
      PRINT_PPI
    );
    const [status, setStatus] = useState(() => previewStatus.get());
    useEffect(() => previewStatus.subscribe(setStatus), []);

    const onPrint = useCallback(async () => {
      if (!photos.length) return;
      setPrinting(true);
      let rendered = [];
      try {
        rendered = await renderForPrint(photos, printEdge);
        const pages = [];
        for (let i = 0; i < rendered.length; i += perPage) {
          pages.push(rendered.slice(i, i + perPage).map(item => ({
            src: item.src,
            caption: captionFor(item.photo, s.showFilename, s.showDate),
          })));
        }
        await printHtmlInIframe(buildPrintDocument({
          pageW, pageH, marginMm: s.marginMm,
          cols: lay.cols, rows: lay.rows,
          pages, fitMode: s.fitMode,
          showCaptions: s.showFilename || s.showDate,
        }));
      } catch (err) {
        console.error("[safelight-print]", err);
        alert(`Print error: ${err.message || err}`);
      } finally {
        setPrinting(false);
      }
    }, [photos, printEdge, perPage, pageW, pageH, s, lay]);

    return ce(SettingsForm, {
      s, patch, photos, pageCount, perPage, status, printing, onPrint,
    });
  }

  function LibraryPrintButton() {
    const go = () => {
      if (api.navigation && typeof api.navigation.goTo === "function") {
        api.navigation.goTo(MODULE_ID);
      }
    };
    if (ui.Button) {
      return ce(ui.Button, { size: "sm", onClick: go, title: "Open Print module" }, "Print");
    }
    return ce("button", { type: "button", onClick: go, style: { fontSize: 11, padding: "4px 8px" } }, "Print");
  }

  if (typeof api.registerModule === "function") {
    api.registerModule({
      id: MODULE_ID,
      label: "Print",
      component: PrintModule,
      order: 40,
      defaultLayout: {
        rails: [
          { side: "right", width: 280, panels: [PANEL_ID] },
        ],
      },
    });
  }

  api.registerPanel({
    id: PANEL_ID,
    title: "Print settings",
    component: PrintSettingsPanel,
    fill: true,
    defaultDock: {
      module: typeof api.registerModule === "function" ? MODULE_ID : "library",
      direction: "right",
      order: 1,
      width: 280,
    },
  });

  if (typeof api.registerSlot === "function") {
    api.registerSlot({
      id: "safelight-print.library-toolbar",
      slot: "library-toolbar",
      order: 80,
      component: LibraryPrintButton,
    });
  }

  if (typeof api.registerKeybinding === "function" && api.navigation) {
    api.registerKeybinding({
      id: "safelight-print.open",
      label: "Switch to Print module",
      category: "General",
      defaultCombo: "Ctrl+Shift+P",
      handler: () => api.navigation.goTo(MODULE_ID),
    });
  }
}

export function deactivate() {
  const el = document.getElementById(PRINT_FRAME_ID);
  if (el) el.remove();
}
