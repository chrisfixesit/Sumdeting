// Small DOM helpers for the account UI: element builder, accessible dialog
// stack (focus trap, Escape, inert background) and the notice toast.
// User data is only ever set as text, never as HTML.

let uid = 0;
export const nextId = (prefix = "acct") => `${prefix}-${++uid}`;

/**
 * h("button", { class: "x", type: "button", on: { click } }, "Text", child)
 * Attribute values of false/null/undefined are skipped; true sets "".
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Outline person icon (decorative). */
export function personIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "acct-person");
  const head = document.createElementNS(SVG_NS, "circle");
  head.setAttribute("cx", "12");
  head.setAttribute("cy", "8");
  head.setAttribute("r", "4");
  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute("d", "M4 21v-1a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7v1");
  svg.append(head, body);
  return svg;
}

/** An error line that screen readers announce; hidden while empty. */
export function errorLine() {
  const el = h("p", { class: "acct-error", role: "alert", hidden: true });
  el.show = (msg) => { el.textContent = msg ?? ""; el.hidden = !msg; };
  return el;
}

/** A polite status line; hidden while empty. */
export function statusLine() {
  const el = h("p", { class: "acct-status", role: "status", hidden: true });
  el.show = (msg) => { el.textContent = msg ?? ""; el.hidden = !msg; };
  return el;
}

/** Disable a button while an async action runs. */
export async function busy(button, fn) {
  if (button.disabled) return undefined;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try { return await fn(); } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

// ---- Dialog stack ----

const stack = [];
const BACKGROUND = () => [...document.querySelectorAll("body > header, body > main, body > nav")];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function syncInert() {
  const on = stack.length > 0;
  for (const el of BACKGROUND()) el.inert = on;
  stack.forEach((d, i) => { d.overlay.inert = i !== stack.length - 1; });
}

function visibleFocusables(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

document.addEventListener("keydown", (e) => {
  const top = stack.at(-1);
  if (!top) return;
  if (e.key === "Escape") {
    if (top.dismissible) { e.preventDefault(); top.close(undefined); }
    return;
  }
  if (e.key !== "Tab") return;
  const items = visibleFocusables(top.panel);
  if (!items.length) { e.preventDefault(); top.panel.focus(); return; }
  const first = items[0];
  const last = items.at(-1);
  if (e.shiftKey && (document.activeElement === first || !top.panel.contains(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !top.panel.contains(document.activeElement))) {
    e.preventDefault(); first.focus();
  }
});

/**
 * Open a modal bottom sheet. Returns a handle:
 *   render(...nodes)  replace the content (labelled by its first heading)
 *   close(result)     close it; `closed` resolves with result
 */
export function openDialog({ dismissible = true, onClose } = {}) {
  const panel = h("div", { class: "acct-sheet", role: "dialog", "aria-modal": "true", tabindex: "-1" });
  const overlay = h("div", { class: "acct-overlay" }, panel);
  const returnFocus = document.activeElement;
  let resolve;
  const handle = {
    panel,
    overlay,
    dismissible,
    open: true,
    closed: new Promise((r) => { resolve = r; }),
    render(...nodes) {
      panel.replaceChildren(...nodes.flat().filter(Boolean));
      const heading = panel.querySelector("h2");
      if (heading) {
        heading.id ||= nextId("acct-title");
        panel.setAttribute("aria-labelledby", heading.id);
      }
      const target = panel.querySelector("[data-autofocus]") ?? panel.querySelector("input:not([type=hidden]):not([type=radio]):not([type=checkbox])");
      (target ?? panel).focus({ preventScroll: true });
      panel.scrollTop = 0;
      return handle;
    },
    close(result) {
      if (!handle.open) return;
      handle.open = false;
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      overlay.remove();
      syncInert();
      try { onClose?.(result); } catch (err) { console.error(err); }
      resolve(result);
      const next = stack.at(-1);
      if (next) next.panel.focus({ preventScroll: true });
      else if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus({ preventScroll: true });
      else document.getElementById("account-btn")?.focus({ preventScroll: true });
    },
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && handle.dismissible) handle.close(undefined);
  });
  document.body.append(overlay);
  stack.push(handle);
  syncInert();
  return handle;
}

/** Close `handle` and every dialog stacked above it. */
export function closeFrom(handle) {
  while (handle.open && stack.includes(handle)) stack.at(-1).close(undefined);
}

/** Close every open dialog (for sign-out and forced sign-out). */
export function closeAllDialogs() {
  while (stack.length) stack.at(-1).close(undefined);
}

export const dialogOpen = () => stack.length > 0;

// ---- Notice toast ----

let noticeEl = null;
let noticeTimer = null;
/** Show a short notice above the bottom navigation. Stays until dismissed or replaced. */
export function showNotice(text, { timeout = 0 } = {}) {
  if (!noticeEl) {
    noticeEl = h("div", { class: "acct-notice", role: "status", "aria-live": "polite", hidden: true });
    document.body.append(noticeEl);
  }
  clearTimeout(noticeTimer);
  const msg = h("p", { text });
  const dismiss = h("button", { type: "button", class: "acct-link", on: { click: () => { noticeEl.hidden = true; } } }, "Dismiss");
  noticeEl.replaceChildren(msg, dismiss);
  noticeEl.hidden = false;
  if (timeout) noticeTimer = setTimeout(() => { noticeEl.hidden = true; }, timeout);
}

/**
 * Ask before something destructive. `lines` are paragraphs; `items` (optional)
 * is a list of exactly what will be deleted; `after` are paragraphs below it. Resolves true only on the
 * destructive button. Cancel (or `cancelLabel`) gets focus first. `irreversible` adds "This can't be undone."
 * `danger: false` styles the action as a plain primary button.
 */
export function confirmDanger({ title, lines = [], items = [], after = [], action, kicker, irreversible = false, cancelLabel = "Cancel", danger = true }) {
  const d = openDialog();
  const go = h("button", { type: "button", class: danger ? "acct-primary acct-danger" : "acct-primary", on: { click: () => d.close(true) } }, action);
  const cancel = h("button", { type: "button", class: "acct-secondary", "data-autofocus": true, on: { click: () => d.close(false) } }, cancelLabel);
  d.render(
    kicker ? h("p", { class: "acct-kicker" }, kicker) : null,
    h("h2", {}, title),
    ...lines.map((t) => h("p", { class: "acct-sub" }, t)),
    items.length ? h("ul", { class: "acct-doomed" }, ...items.map((t) => h("li", {}, t))) : null,
    ...after.map((t) => h("p", { class: "acct-sub" }, t)),
    irreversible ? h("p", { class: "acct-sub acct-warn" }, "This can't be undone.") : null,
    h("div", { class: "acct-actions" }, go, cancel),
  );
  return d.closed.then((v) => v === true);
}
