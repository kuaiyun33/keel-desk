window.__ModuleLoader__.load({ id: "dsh-quick-commands", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/dsh-quick-commands/src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  internals: () => internals
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_react_dom = require("react-dom");

// plugins/dsh-quick-commands/src/quick-commands-core.mjs
var QUICK_COMMANDS_FILTER_THRESHOLD = 12;
function isPinned(command) {
  return command.pinned === true;
}
function parseImportPayload(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "\u6587\u4EF6\u4E0D\u662F\u5408\u6CD5 JSON" };
  }
  const list = Array.isArray(data) ? data : typeof data === "object" && data !== null && Array.isArray(data.commands) ? data.commands : null;
  if (list === null) return { ok: false, error: "\u6587\u4EF6\u5F62\u72B6\u4E0D\u7B26\uFF1A\u5E94\u4E3A\u6307\u4EE4\u6570\u7EC4\u6216\u542B commands \u5B57\u6BB5\u7684\u5BF9\u8C61" };
  const texts = [];
  let dropped = 0;
  for (const item of list) {
    const text = typeof item === "object" && item !== null ? item.text : void 0;
    if (typeof text !== "string") return { ok: false, error: "\u5B58\u5728\u7F3A\u5931 text \u5B57\u6BB5\u7684\u6761\u76EE\uFF0C\u5DF2\u6574\u4F53\u62D2\u7EDD\u5BFC\u5165" };
    const trimmed = text.trim();
    if (trimmed === "") dropped += 1;
    else texts.push(trimmed);
  }
  return { ok: true, texts, dropped };
}
function filterQuickCommands(commands, query) {
  const q = query.trim().toLowerCase();
  if (q === "") return [...commands];
  return commands.filter((command) => command.text.toLowerCase().includes(q));
}
function appendQuickCommandText(current, snippet) {
  return current.trim() === "" ? snippet : `${current}
${snippet}`;
}
var QUICK_COMMAND_OVERLAY_GAP = 8;
var QUICK_COMMAND_OVERLAY_MARGIN = 8;
var QUICK_COMMAND_OVERLAY_MIN_VERTICAL = 200;
function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}
function resolveQuickCommandPlacement({
  anchor,
  panelWidth,
  panelHeight,
  viewport,
  margin = QUICK_COMMAND_OVERLAY_MARGIN,
  gap = QUICK_COMMAND_OVERLAY_GAP,
  inset = {}
}) {
  const safe = {
    top: Math.max(margin, inset.top ?? margin),
    right: viewport.width - Math.max(margin, inset.right ?? margin),
    bottom: viewport.height - Math.max(margin, inset.bottom ?? margin),
    left: Math.max(margin, inset.left ?? margin)
  };
  const space = {
    above: Math.max(0, anchor.top - gap - safe.top),
    below: Math.max(0, safe.bottom - anchor.bottom - gap),
    left: Math.max(0, anchor.left - gap - safe.left),
    right: Math.max(0, safe.right - anchor.right - gap)
  };
  const verticalBest = Math.max(space.above, space.below);
  const horizontalBest = Math.max(space.left, space.right);
  const minVertical = Math.min(panelHeight, QUICK_COMMAND_OVERLAY_MIN_VERTICAL);
  let side;
  if (verticalBest < minVertical && horizontalBest > verticalBest) {
    side = space.right >= space.left ? "right" : "left";
  } else if (panelHeight <= space.below) {
    side = "down";
  } else if (space.above > space.below) {
    side = "up";
  } else {
    side = "down";
  }
  if (side === "up" || side === "down") {
    let maxHeight2 = side === "up" ? space.above : space.below;
    let height2 = Math.min(panelHeight, maxHeight2);
    let top2 = side === "up" ? anchor.top - gap - height2 : anchor.bottom + gap;
    top2 = clamp(top2, safe.top, Math.max(safe.top, safe.bottom - height2));
    maxHeight2 = Math.max(0, side === "up" ? anchor.top - gap - top2 : safe.bottom - top2);
    height2 = Math.min(height2, maxHeight2);
    const maxWidth2 = Math.max(0, safe.right - safe.left);
    const width2 = Math.min(panelWidth, maxWidth2);
    const overflowRight = anchor.left + width2 > safe.right;
    const left2 = clamp(
      overflowRight ? anchor.right - width2 : anchor.left,
      safe.left,
      Math.max(safe.left, safe.right - width2)
    );
    return { top: top2, left: left2, maxHeight: maxHeight2, maxWidth: maxWidth2, side };
  }
  const maxWidth = side === "left" ? space.left : space.right;
  const width = Math.min(panelWidth, maxWidth);
  const left = clamp(
    side === "left" ? anchor.left - gap - width : anchor.right + gap,
    safe.left,
    Math.max(safe.left, safe.right - width)
  );
  const maxHeight = Math.max(0, safe.bottom - safe.top);
  const height = Math.min(panelHeight, maxHeight);
  const top = clamp(anchor.top, safe.top, Math.max(safe.top, safe.bottom - height));
  return { top, left, maxHeight, maxWidth, side };
}

// plugins/dsh-quick-commands/src/client.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "dsh-quick-commands";
var CLIENT_BUNDLE_ID = "dsh-quick-commands";
var ROUTE_PREFIX = "/dsh-quick-commands";
var SLASH_FILTER_ENABLED = false;
var zh = {
  "button": "\u5FEB\u6377\u6307\u4EE4",
  "panel.title": "\u5FEB\u6377\u6307\u4EE4",
  "panel.filter": "\u7B5B\u9009\u6307\u4EE4\u2026",
  "panel.empty": "\u8FD8\u6CA1\u6709\u5FEB\u6377\u6307\u4EE4",
  "panel.emptyFiltered": "\u6CA1\u6709\u5339\u914D\u7684\u6307\u4EE4",
  "panel.new": "\u65B0\u5EFA\u4E00\u6761\u5FEB\u6377\u6307\u4EE4\u2026",
  "panel.add": "\u6DFB\u52A0",
  "panel.saveCurrent": "\u5B58\u4E3A\u8F93\u5165",
  "panel.import": "\u5BFC\u5165",
  "panel.export": "\u5BFC\u51FA",
  "panel.reset": "\u6062\u590D\u9ED8\u8BA4",
  "panel.resetConfirm": "\u6062\u590D\u4E3A\u9ED8\u8BA4\u4E94\u6761\uFF1F\u73B0\u6709\u6307\u4EE4\u5C06\u88AB\u66FF\u6362\u3002",
  "panel.shared": "\u4E0E Pchat \u52A9\u624B\u5171\u4EAB",
  "row.insert": "\u63D2\u5165\u5230\u8F93\u5165\u6846",
  "row.pin": "\u7F6E\u9876",
  "row.unpin": "\u53D6\u6D88\u7F6E\u9876",
  "row.edit": "\u7F16\u8F91",
  "row.delete": "\u5220\u9664",
  "row.deleteConfirm": "\u5220\u9664\u8FD9\u6761\u5FEB\u6377\u6307\u4EE4\uFF1F",
  "row.save": "\u4FDD\u5B58",
  "row.cancel": "\u53D6\u6D88",
  "row.drag": "\u62D6\u52A8\u6392\u5E8F",
  "import.mode": "\u5BFC\u5165\u65B9\u5F0F",
  "import.replace": "\u66FF\u6362\u5168\u90E8",
  "import.merge": "\u5408\u5E76\u8FFD\u52A0",
  "import.confirm": "\u5BFC\u5165",
  "import.cancel": "\u53D6\u6D88",
  "import.preview": "\u5171 {count} \u6761\u53EF\u5BFC\u5165",
  "import.dropped": "\uFF08{dropped} \u6761\u7A7A\u767D\u5DF2\u5FFD\u7565\uFF09",
  "import.done": "\u5DF2\u5BFC\u5165 {imported} \u6761\uFF0C\u8DF3\u8FC7 {skipped} \u6761",
  "import.empty": "\u6587\u4EF6\u91CC\u6CA1\u6709\u53EF\u5BFC\u5165\u7684\u6307\u4EE4",
  "slash.hint": "\u5FEB\u6377\u6307\u4EE4 \u2014 \u2191\u2193 \u9009\u62E9 \xB7 Enter \u63D2\u5165 \xB7 Esc \u5173\u95ED",
  "error.generic": "\u64CD\u4F5C\u5931\u8D25"
};
var en = {
  "button": "Quick commands",
  "panel.title": "Quick commands",
  "panel.filter": "Filter commands\u2026",
  "panel.empty": "No quick commands yet",
  "panel.emptyFiltered": "No matching commands",
  "panel.new": "New quick command\u2026",
  "panel.add": "Add",
  "panel.saveCurrent": "Save input",
  "panel.import": "Import",
  "panel.export": "Export",
  "panel.reset": "Reset defaults",
  "panel.resetConfirm": "Reset to the five defaults? Existing commands will be replaced.",
  "panel.shared": "Shared with Pchat",
  "row.insert": "Insert into input",
  "row.pin": "Pin",
  "row.unpin": "Unpin",
  "row.edit": "Edit",
  "row.delete": "Delete",
  "row.deleteConfirm": "Delete this quick command?",
  "row.save": "Save",
  "row.cancel": "Cancel",
  "row.drag": "Drag to reorder",
  "import.mode": "Import mode",
  "import.replace": "Replace all",
  "import.merge": "Merge",
  "import.confirm": "Import",
  "import.cancel": "Cancel",
  "import.preview": "{count} command(s) ready",
  "import.dropped": " ({dropped} blank ignored)",
  "import.done": "Imported {imported}, skipped {skipped}",
  "import.empty": "No importable commands in the file",
  "slash.hint": "Quick commands \u2014 \u2191\u2193 select \xB7 Enter insert \xB7 Esc close",
  "error.generic": "Operation failed"
};
function fallbackTranslate(key, params) {
  const dict = typeof navigator !== "undefined" && navigator.language.startsWith("zh") ? zh : en;
  let text = dict[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v));
  return text;
}
async function call(path, init) {
  const res = await fetch(`${ROUTE_PREFIX}${path}`, init);
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
var post = (path, body) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function Glyph({ d, size = 16 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d, stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }) });
}
var ICON = {
  pin: "M6 2h4l-.5 3.5L11.5 8H4l2-2.5L6 2Zm2 6v6",
  edit: "M11 2.5 13.5 5 6 12.5l-3 .5.5-3L11 2.5Z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5",
  close: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  drag: "M6 4.5h.01M10 4.5h.01M6 8h.01M10 8h.01M6 11.5h.01M10 11.5h.01",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm3.6-1.4L14 14",
  importSvg: "M8 2v8m0 0L5 7m3 3 3-3M3 13h10",
  exportSvg: "M8 10V2m0 0L5 5m3-3 3 3M3 13h10"
};
var QUICK_COMMANDS_PATHS = [
  "M230.4 690.688c-16.384 0-30.208 13.312-30.208 30.208s13.312 30.208 30.208 30.208h281.6c16.384 0 30.208-13.312 30.208-30.208s-13.312-30.208-30.208-30.208H230.4zM695.808 296.96c0-16.384-13.312-30.208-29.696-30.208H230.4c-16.384 0-30.208 13.312-30.208 30.208s13.312 30.208 30.208 30.208h435.2c16.384-0.512 30.208-13.824 30.208-30.208zM636.928 508.928c0-16.384-13.312-30.208-30.208-30.208H230.4c-16.384 0-30.208 13.312-30.208 30.208s13.312 30.208 30.208 30.208h376.32c16.384-0.512 30.208-13.824 30.208-30.208z",
  "M583.68 912.896H108.544c-8.192 0-15.36-6.144-16.384-14.336V125.952c0-2.048 0.512-4.608 2.048-6.656 3.584-5.632 9.728-8.704 15.872-8.704h676.352c6.656 0 12.8 3.584 15.872 9.216 1.024 2.048 1.536 4.096 1.536 6.144v316.416c-0.512 16.896 12.288 30.72 29.184 31.744 16.896 0.512 30.72-12.288 31.744-29.184V126.464c0-19.456-7.68-37.888-21.504-51.712-15.36-14.848-35.328-23.552-56.832-23.552H109.568C66.56 51.2 31.232 84.992 31.232 126.464v771.584c0 41.472 35.328 75.264 78.848 75.264H583.68c16.384-0.512 29.184-14.848 28.672-31.232-0.512-15.872-13.312-28.672-28.672-29.184z",
  "M977.92 523.776l-22.016-22.016c-19.968-19.968-52.224-19.968-72.192 0l-264.704 264.192L593.92 885.76l120.32-24.576 264.192-264.704c19.456-19.968 19.456-52.224-0.512-72.704z m-31.232 40.96l-254.976 254.976-41.472 9.728 9.728-41.472 254.976-254.976c2.56-2.56 7.168-2.56 9.728 0l22.016 22.016c1.536 1.536 2.048 3.072 2.048 5.12s-1.024 3.584-2.048 4.608z"
];
function measureChrome(anchorEl, viewport) {
  const trigger = anchorEl.getBoundingClientRect();
  const column = anchorEl.closest("[data-phase]");
  const header = column?.querySelector(":scope > header");
  const seat = anchorEl.closest("[data-composer-seat]");
  const headerRect = header instanceof HTMLElement && header.offsetParent !== null ? header.getBoundingClientRect() : null;
  const seatRect = seat instanceof HTMLElement ? seat.getBoundingClientRect() : null;
  const inset = {
    top: headerRect !== null && headerRect.height > 1 ? headerRect.bottom + QUICK_COMMAND_OVERLAY_MARGIN : QUICK_COMMAND_OVERLAY_MARGIN,
    right: QUICK_COMMAND_OVERLAY_MARGIN,
    bottom: QUICK_COMMAND_OVERLAY_MARGIN + 8,
    left: QUICK_COMMAND_OVERLAY_MARGIN
  };
  return {
    inset,
    anchor: {
      top: seatRect?.top ?? trigger.top,
      bottom: seatRect?.bottom ?? trigger.bottom,
      left: trigger.left,
      right: trigger.right,
      width: trigger.width,
      height: (seatRect?.bottom ?? trigger.bottom) - (seatRect?.top ?? trigger.top)
    },
    maxBand: Math.max(80, viewport.height - inset.top - inset.bottom)
  };
}
function QuickCommandsGlyph({ size = 17 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { width: size, height: size, viewBox: "0 0 1024 1024", fill: "currentColor", "aria-hidden": true, children: QUICK_COMMANDS_PATHS.map((d, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d }, index)) });
}
function Row({
  command,
  t,
  onInsert,
  onPin,
  onEdit,
  onDelete,
  drag
}) {
  const [editing, setEditing] = (0, import_react.useState)(false);
  const [text, setText] = (0, import_react.useState)(command.text);
  const areaRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    if (editing) {
      areaRef.current?.focus();
      areaRef.current?.select();
    }
  }, [editing]);
  const commitEdit = () => {
    const next = text.trim();
    if (next !== "" && next !== command.text) onEdit(next);
    setEditing(false);
  };
  if (editing) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "dqc-row dqc-row-editing", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "textarea",
        {
          ref: areaRef,
          className: "dqc-edit",
          value: text,
          rows: Math.min(8, Math.max(2, text.split("\n").length)),
          onChange: (event) => {
            setText(event.target.value);
          },
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setText(command.text);
              setEditing(false);
            } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              commitEdit();
            }
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-edit-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-btn dqc-btn-primary", onClick: commitEdit, children: t("row.save") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-btn", onClick: () => {
          setText(command.text);
          setEditing(false);
        }, children: t("row.cancel") })
      ] })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "li",
    {
      className: `dqc-row${drag.dragging ? " dqc-row-dragging" : ""}${isPinned(command) ? " dqc-row-pinned" : ""}`,
      draggable: true,
      onDragStart: drag.onDragStart,
      onDragOver: drag.onDragOver,
      onDrop: drag.onDrop,
      onDragEnd: drag.onDragEnd,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dqc-handle", title: t("row.drag"), "aria-hidden": true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.drag }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-text", title: t("row.insert"), onClick: onInsert, children: command.text }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dqc-row-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: `dqc-icon${isPinned(command) ? " dqc-icon-on" : ""}`, title: isPinned(command) ? t("row.unpin") : t("row.pin"), "aria-label": isPinned(command) ? t("row.unpin") : t("row.pin"), onClick: onPin, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.pin }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-icon", title: t("row.edit"), "aria-label": t("row.edit"), onClick: () => {
            setText(command.text);
            setEditing(true);
          }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.edit }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-icon dqc-icon-danger", title: t("row.delete"), "aria-label": t("row.delete"), onClick: () => {
            if (window.confirm(t("row.deleteConfirm"))) onDelete();
          }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.trash }) })
        ] })
      ]
    }
  );
}
function Panel({
  t,
  commands,
  error,
  onClose,
  currentDraft,
  overlayRef,
  onInsert,
  onCreate,
  onUpdate,
  onDelete,
  onPin,
  onReorder,
  onImport,
  onReset,
  onExport
}) {
  const [query, setQuery] = (0, import_react.useState)("");
  const [draftNew, setDraftNew] = (0, import_react.useState)("");
  const [adding, setAdding] = (0, import_react.useState)(false);
  const [order, setOrder] = (0, import_react.useState)(commands);
  const dragId = (0, import_react.useRef)(null);
  const fileRef = (0, import_react.useRef)(null);
  const pendingFile = (0, import_react.useRef)(null);
  const [importMode, setImportMode] = (0, import_react.useState)("merge");
  const [pickedFile, setPickedFile] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    setOrder(commands);
  }, [commands]);
  const filtered = (0, import_react.useMemo)(() => filterQuickCommands(order, query), [order, query]);
  const showFilter = order.length > QUICK_COMMANDS_FILTER_THRESHOLD;
  const dndEnabled = query.trim() === "";
  const sameRegion = (a, b) => {
    const ca = order.find((c) => c.id === a);
    const cb = order.find((c) => c.id === b);
    return ca !== void 0 && cb !== void 0 && isPinned(ca) === isPinned(cb);
  };
  const dragOver = (overId) => (event) => {
    event.preventDefault();
    const id = dragId.current;
    if (id === null || id === overId || !sameRegion(id, overId)) return;
    setOrder((prev) => {
      const from = prev.findIndex((c) => c.id === id);
      const to = prev.findIndex((c) => c.id === overId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const commitOrder = () => {
    dragId.current = null;
    const ids = order.map((c) => c.id);
    const original = commands.map((c) => c.id);
    if (ids.length === original.length && ids.some((id, i) => id !== original[i])) onReorder(ids);
  };
  const beginImport = () => fileRef.current?.click();
  const onFilePicked = (event) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (file === null) return;
    pendingFile.current = file;
    setPickedFile(file);
  };
  const confirmImport = () => {
    if (pickedFile !== null) onImport(pickedFile, importMode);
    setPickedFile(null);
    pendingFile.current = null;
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { ref: overlayRef, className: "dqc-panel", role: "dialog", "aria-label": t("panel.title"), onMouseDown: (event) => event.stopPropagation(), children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-panel-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dqc-panel-title", children: t("panel.title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dqc-panel-shared", children: t("panel.shared") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-icon", "aria-label": t("row.cancel"), onClick: onClose, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.close }) })
    ] }),
    showFilter && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dqc-filter", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dqc-filter-glyph", "aria-hidden": true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.search }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "dqc-filter-input", value: query, placeholder: t("panel.filter"), onChange: (event) => {
        setQuery(event.target.value);
      } })
    ] }),
    error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dqc-error", children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dqc-list", children: filtered.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { className: "dqc-list-empty", children: query.trim() === "" ? t("panel.empty") : t("panel.emptyFiltered") }) : filtered.map((command) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Row,
      {
        command,
        t,
        onInsert: () => onInsert(command),
        onPin: () => onPin(command.id, !isPinned(command)),
        onEdit: (text) => onUpdate(command.id, text),
        onDelete: () => onDelete(command.id),
        drag: dndEnabled ? {
          onDragStart: () => {
            dragId.current = command.id;
          },
          onDragOver: dragOver(command.id),
          onDrop: commitOrder,
          onDragEnd: commitOrder,
          dragging: false
        } : {
          onDragStart: () => {
          },
          onDragOver: () => {
          },
          onDrop: () => {
          },
          onDragEnd: () => {
          },
          dragging: false
        }
      },
      command.id
    )) }),
    adding && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-new", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "textarea",
        {
          className: "dqc-new-input",
          value: draftNew,
          placeholder: t("panel.new"),
          autoFocus: true,
          rows: Math.min(6, Math.max(2, draftNew.split("\n").length)),
          onChange: (event) => {
            setDraftNew(event.target.value);
          },
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setDraftNew("");
              setAdding(false);
            } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && draftNew.trim() !== "") {
              event.preventDefault();
              onCreate(draftNew.trim());
              setDraftNew("");
              setAdding(false);
            }
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-new-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-btn dqc-btn-primary", disabled: draftNew.trim() === "", onClick: () => {
          onCreate(draftNew.trim());
          setDraftNew("");
          setAdding(false);
        }, children: t("panel.add") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-btn", onClick: () => {
          setDraftNew("");
          setAdding(false);
        }, children: t("row.cancel") })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-foot", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "dqc-btn dqc-btn-ghost", "data-active": adding, onClick: () => setAdding((value) => !value), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.plus, size: 14 }),
        " ",
        t("panel.add")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-btn dqc-btn-ghost", disabled: currentDraft.trim() === "", title: t("panel.saveCurrent"), onClick: () => onCreate(currentDraft.trim()), children: t("panel.saveCurrent") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dqc-foot-spacer" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-icon", title: t("panel.import"), "aria-label": t("panel.import"), onClick: beginImport, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.importSvg, size: 15 }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-icon", title: t("panel.export"), "aria-label": t("panel.export"), onClick: onExport, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.exportSvg, size: 15 }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-btn dqc-btn-ghost", title: t("panel.reset"), onClick: () => {
        if (window.confirm(t("panel.resetConfirm"))) onReset();
      }, children: t("panel.reset") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { ref: fileRef, type: "file", accept: "application/json,.json", hidden: true, onChange: onFilePicked }),
    pickedFile !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-import", onMouseDown: (event) => event.stopPropagation(), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dqc-import-name", children: pickedFile.name }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-import-modes", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "radio", name: "dqc-import-mode", checked: importMode === "merge", onChange: () => setImportMode("merge") }),
          " ",
          t("import.merge")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "radio", name: "dqc-import-mode", checked: importMode === "replace", onChange: () => setImportMode("replace") }),
          " ",
          t("import.replace")
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-import-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-btn dqc-btn-primary", onClick: confirmImport, children: t("import.confirm") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dqc-btn", onClick: () => {
          setPickedFile(null);
          pendingFile.current = null;
        }, children: t("import.cancel") })
      ] })
    ] })
  ] });
}
function SlashOverlay({ t, matches, active, onPick, overlayRef }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { ref: overlayRef, className: "dqc-slash", role: "listbox", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dqc-slash-hint", children: t("slash.hint") }),
    matches.map((command, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        role: "option",
        "aria-selected": index === active,
        className: `dqc-slash-item${index === active ? " dqc-slash-item-active" : ""}`,
        onMouseDown: (event) => {
          event.preventDefault();
          onPick(command);
        },
        children: [
          isPinned(command) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dqc-slash-pin", "aria-hidden": true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Glyph, { d: ICON.pin, size: 12 }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dqc-slash-text", children: command.text })
        ]
      },
      command.id
    ))
  ] });
}
function QuickCommands({ input, inputActions, useInput, t: injected }) {
  const t = injected ?? fallbackTranslate;
  const [open, setOpen] = (0, import_react.useState)(false);
  const [commands, setCommands] = (0, import_react.useState)([]);
  const [error, setError] = (0, import_react.useState)(null);
  const rootRef = (0, import_react.useRef)(null);
  const triggerRef = (0, import_react.useRef)(null);
  const panelRef = (0, import_react.useRef)(null);
  const slashRef = (0, import_react.useRef)(null);
  const lastPlace = (0, import_react.useRef)("");
  const placeOverlay = (0, import_react.useCallback)((overlayEl) => {
    const anchorEl = triggerRef.current ?? rootRef.current;
    if (anchorEl === null) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const chrome = measureChrome(anchorEl, viewport);
    overlayEl.style.position = "fixed";
    overlayEl.style.right = "auto";
    overlayEl.style.bottom = "auto";
    overlayEl.style.maxHeight = `${chrome.maxBand}px`;
    overlayEl.style.maxWidth = `${Math.max(0, viewport.width - chrome.inset.left - chrome.inset.right)}px`;
    const place = resolveQuickCommandPlacement({
      anchor: chrome.anchor,
      panelWidth: overlayEl.offsetWidth,
      panelHeight: overlayEl.offsetHeight,
      viewport,
      inset: chrome.inset
    });
    const key = `${place.side}:${place.top}:${place.left}:${place.maxHeight}:${place.maxWidth}`;
    if (lastPlace.current === key) return;
    lastPlace.current = key;
    overlayEl.style.top = `${place.top}px`;
    overlayEl.style.left = `${place.left}px`;
    overlayEl.style.maxHeight = `${place.maxHeight}px`;
    overlayEl.style.maxWidth = `${place.maxWidth}px`;
    overlayEl.dataset.side = place.side;
  }, []);
  const reactiveDraft = useInput ? useInput((state) => state?.draft ?? "") : input.draft;
  const draft = typeof reactiveDraft === "string" ? reactiveDraft : input.draft;
  const refresh = (0, import_react.useCallback)(async () => {
    try {
      const data = await call("/list");
      setCommands(data.commands);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.generic"));
    }
  }, [t]);
  (0, import_react.useEffect)(() => {
    if (open) void refresh();
  }, [open, refresh]);
  const run = (0, import_react.useCallback)(async (work) => {
    try {
      const data = await work;
      if (Array.isArray(data.commands)) setCommands(data.commands);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.generic"));
      void refresh();
    }
  }, [refresh, t]);
  const insert = (0, import_react.useCallback)((command) => {
    inputActions.setDraft(appendQuickCommandText(input.draft, command.text));
    setOpen(false);
  }, [inputActions, input]);
  const exportAll = (0, import_react.useCallback)(async () => {
    try {
      const data = await call("/export");
      const blob = new Blob([`${JSON.stringify(data.payload, null, 2)}
`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.fileName ?? "quick_commands.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.generic"));
    }
  }, [t]);
  const importFile = (0, import_react.useCallback)(async (file, mode) => {
    try {
      const parsed = parseImportPayload(await file.text());
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      if (parsed.texts.length === 0) {
        setError(t("import.empty"));
        return;
      }
      await run(post("/import", { texts: parsed.texts, mode }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.generic"));
    }
  }, [run, t]);
  (0, import_react.useEffect)(() => {
    if (!open) return;
    const onDown = (event) => {
      const target = event.target;
      const inTrigger = rootRef.current !== null && rootRef.current.contains(target);
      const inPanel = panelRef.current !== null && panelRef.current.contains(target);
      if (!inTrigger && !inPanel) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const slashQuery = SLASH_FILTER_ENABLED && !open && draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1) : null;
  const [dismissedSlash, setDismissedSlash] = (0, import_react.useState)(null);
  const [slashActive, setSlashActive] = (0, import_react.useState)(0);
  const slashMatches = (0, import_react.useMemo)(
    () => slashQuery === null ? [] : filterQuickCommands(commands, slashQuery).slice(0, 8),
    [slashQuery, commands]
  );
  const slashOpen = slashQuery !== null && draft !== dismissedSlash && slashMatches.length > 0;
  (0, import_react.useLayoutEffect)(() => {
    const overlayEl = open ? panelRef.current : slashOpen ? slashRef.current : null;
    if (overlayEl === null) {
      lastPlace.current = "";
      return;
    }
    const run2 = () => placeOverlay(overlayEl);
    run2();
    window.addEventListener("resize", run2);
    const observer = new ResizeObserver(run2);
    observer.observe(overlayEl);
    return () => {
      window.removeEventListener("resize", run2);
      observer.disconnect();
    };
  }, [open, slashOpen, commands, error, placeOverlay]);
  (0, import_react.useEffect)(() => {
    if (slashQuery !== null && commands.length === 0) void refresh();
  }, [slashQuery, commands.length, refresh]);
  (0, import_react.useEffect)(() => {
    setSlashActive(0);
  }, [slashQuery]);
  const pickSlash = (0, import_react.useCallback)((command) => {
    inputActions.setDraft(command.text);
    setDismissedSlash(null);
  }, [inputActions]);
  (0, import_react.useEffect)(() => {
    if (!slashOpen) return;
    const onKey = (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActive((index) => Math.min(index + 1, slashMatches.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActive((index) => Math.max(index - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const command = slashMatches[slashActive];
        if (command) pickSlash(command);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlash(draft);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [slashOpen, slashMatches, slashActive, pickSlash, draft]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dqc-root", ref: rootRef, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        ref: triggerRef,
        type: "button",
        className: `dqc-trigger${open ? " dqc-trigger-on" : ""}`,
        "aria-label": t("button"),
        "aria-expanded": open,
        title: t("button"),
        onClick: () => setOpen((value) => !value),
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(QuickCommandsGlyph, {})
      }
    ),
    open && (0, import_react_dom.createPortal)(
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        Panel,
        {
          t,
          commands,
          error,
          currentDraft: draft,
          overlayRef: panelRef,
          onClose: () => setOpen(false),
          onInsert: insert,
          onCreate: (text) => run(post("/create", { text })),
          onUpdate: (id, text) => run(post("/update", { id, text })),
          onDelete: (id) => run(post("/remove", { id })),
          onPin: (id, pinned) => run(post("/pin", { id, pinned })),
          onReorder: (ids) => run(post("/reorder", { ids })),
          onImport: importFile,
          onReset: () => run(post("/reset", {})),
          onExport: exportAll
        }
      ),
      document.body
    ),
    slashOpen && (0, import_react_dom.createPortal)(
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SlashOverlay, { t, matches: slashMatches, active: slashActive, onPick: pickSlash, overlayRef: slashRef }),
      document.body
    )
  ] });
}
var STYLES = String.raw`
.dqc-root{position:relative;display:inline-flex}
.dqc-trigger{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
.dqc-trigger:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-trigger-on{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-panel{position:fixed;z-index:1200;display:flex;flex-direction:column;width:min(420px,calc(100vw - 32px));max-height:min(60vh,520px);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2);overflow:hidden}
.dqc-panel-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dqc-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dqc-panel-shared{flex:1;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dqc-filter{display:flex;align-items:center;gap:6px;margin:8px 12px 0;padding:0 8px;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dqc-filter-glyph{display:flex;color:var(--dsw-alias-label-tertiary)}
.dqc-filter-input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dqc-error{margin:8px 12px 0;padding:6px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dqc-list{flex:1;min-height:0;overflow-y:auto;margin:8px 0 0;padding:0 8px;list-style:none;display:flex;flex-direction:column;gap:2px}
.dqc-list-empty{padding:20px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dqc-row{position:relative;display:flex;align-items:center;gap:4px;padding:4px 4px 4px 2px;border-radius:8px}
.dqc-row:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-row-pinned{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
.dqc-row-dragging{opacity:.5}
.dqc-handle{display:flex;align-items:center;color:var(--dsw-alias-label-tertiary);cursor:grab}
.dqc-text{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding:2px 4px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;white-space:pre-wrap}
.dqc-row-actions{position:absolute;top:3px;right:3px;display:flex;align-items:center;gap:1px;padding:1px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-solid);box-shadow:0 0 0 5px var(--dsw-alias-interactive-bg-hover-solid);opacity:0;pointer-events:none;transition:opacity .1s}
.dqc-row:hover .dqc-row-actions{opacity:1;pointer-events:auto}
.dqc-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:6px;color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer}
.dqc-icon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-icon-on{color:var(--dsw-alias-brand-primary)}
.dqc-icon-danger:hover{color:var(--dsw-alias-state-error-primary)}
.dqc-row-editing{flex-direction:column;align-items:stretch;gap:6px;padding:8px}
.dqc-edit{width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px}
.dqc-edit-actions,.dqc-new-actions,.dqc-import-actions,.dqc-import-modes{display:flex;gap:8px;align-items:center}
.dqc-btn{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:12px;cursor:pointer}
.dqc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-btn:disabled{opacity:.5;cursor:default}
.dqc-btn-primary{border-color:transparent;color:#fff;background:var(--dsw-alias-brand-primary)}
.dqc-btn-primary:hover:not(:disabled){filter:brightness(1.05);color:#fff}
.dqc-btn-ghost{border-color:transparent;background:transparent}
.dqc-btn-ghost[data-active='true']{color:var(--dsw-alias-brand-primary)}
.dqc-new{display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dqc-new-input{width:100%;box-sizing:border-box;resize:vertical;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px}
.dqc-foot{display:flex;align-items:center;gap:4px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dqc-foot-spacer{flex:1}
.dqc-import{display:flex;flex-direction:column;gap:8px;padding:12px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dqc-import-name{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dqc-import-modes{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dqc-slash{position:fixed;z-index:1200;display:flex;flex-direction:column;width:min(460px,calc(100vw - 32px));max-height:320px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2);padding:4px}
.dqc-slash-hint{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dqc-slash-item{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.dqc-slash-item:hover,.dqc-slash-item-active{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dqc-slash-pin{display:flex;color:var(--dsw-alias-brand-primary);padding-top:2px}
.dqc-slash-text{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
`;
function installStyles() {
  if (document.querySelector(`style[data-plugin="${CLIENT_BUNDLE_ID}"]`) !== null) return () => {
  };
  const style = document.createElement("style");
  style.dataset.plugin = CLIENT_BUNDLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-quick-commands: dictionaries");
  ctx.effect(installStyles, "dsh-quick-commands: styles");
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
    { name: "conversation.input.left", id: "dsh-quick-commands", order: 100, locale: NS },
    QuickCommands
  ));
}
var internals = { QuickCommands, Panel, Row };
return module.exports; } });
//# sourceMappingURL=client.js.map
