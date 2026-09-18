// DOM PATCH — morph the board in place instead of replacing innerHTML, so
// scroll positions inside panes, focus and caret, and text selection survive the
// 2s refresh. Panels still emit HTML strings; this is only the apply step.
//
// Reconciliation is by position with tag identity (the board's structure is
// static), or by `data-k` key where rows reorder. `data-preserve` marks a
// subtree whose children another painter owns (the event feed, the TUI).

/** Attribute marking a subtree whose children are managed elsewhere. */
export const PRESERVE_ATTR = "data-preserve";

/** Attribute carrying a stable row identity for keyed reconciliation. */
export const KEY_ATTR = "data-k";

/**
 * Patch `container`'s children to match `html`, parsed in a detached
 * <template> so nothing half-built is ever attached.
 */
export function patch(container, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  patchChildren(container, tpl.content);
}

/**
 * Reconcile one level, then recurse: keyed when every child has data-k,
 * otherwise positional.
 */
function patchChildren(oldParent, newParent) {
  const newNodes = [...newParent.childNodes];
  const oldNodes = [...oldParent.childNodes];

  if (isKeyed(newNodes) && isKeyed(oldNodes)) {
    patchKeyed(oldParent, oldNodes, newNodes);
    return;
  }

  const n = Math.max(oldNodes.length, newNodes.length);
  for (let i = 0; i < n; i += 1) {
    const oldNode = oldNodes[i];
    const newNode = newNodes[i];

    if (!newNode) {
      // Surplus old node.
      oldNode?.remove();
      continue;
    }
    if (!oldNode) {
      oldParent.appendChild(newNode.cloneNode(true));
      continue;
    }
    patchNode(oldParent, oldNode, newNode);
  }
}

/** Every element child carries a key, and there is at least one. */
function isKeyed(nodes) {
  const els = nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE);
  return els.length > 0 && els.length === nodes.length && els.every((e) => e.hasAttribute(KEY_ATTR));
}

/**
 * Keyed: existing rows are moved, not rebuilt, so they keep scroll, focus and
 * selection.
 */
function patchKeyed(parent, oldNodes, newNodes) {
  const byKey = new Map();
  for (const o of oldNodes) byKey.set(o.getAttribute(KEY_ATTR), o);

  const seen = new Set();
  let cursor = null;

  for (const n of newNodes) {
    const key = n.getAttribute(KEY_ATTR);
    seen.add(key);
    let target = byKey.get(key);

    if (target) {
      patchElement(target, n);
    } else {
      target = n.cloneNode(true);
    }

    // Insert after the cursor (a no-op when already in place).
    const next = cursor ? cursor.nextSibling : parent.firstChild;
    if (next !== target) parent.insertBefore(target, next);
    cursor = target;
  }

  for (const o of oldNodes) {
    if (!seen.has(o.getAttribute(KEY_ATTR))) o.remove();
  }
}

/** Patch a single node in place, or replace it if it cannot be reconciled. */
function patchNode(parent, oldNode, newNode) {
  // Different kind or tag: replace.
  if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
    parent.replaceChild(newNode.cloneNode(true), oldNode);
    return;
  }

  if (oldNode.nodeType === Node.TEXT_NODE || oldNode.nodeType === Node.COMMENT_NODE) {
    // Compare first: assigning an identical string can collapse a selection.
    if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
    return;
  }

  if (oldNode.nodeType === Node.ELEMENT_NODE) patchElement(oldNode, newNode);
}

function patchElement(oldEl, newEl) {
  patchAttrs(oldEl, newEl);

  // Owned by another painter: attributes synced above, children left alone.
  if (oldEl.hasAttribute(PRESERVE_ATTR)) return;

  patchFormState(oldEl, newEl);
  patchChildren(oldEl, newEl);
}

function patchAttrs(oldEl, newEl) {
  for (const { name, value } of [...newEl.attributes]) {
    if (oldEl.getAttribute(name) !== value) oldEl.setAttribute(name, value);
  }
  for (const { name } of [...oldEl.attributes]) {
    if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
  }
}

/**
 * Form state lives in properties, synced explicitly — never on the focused
 * element, whose value is the operator's until they leave it.
 */
function patchFormState(oldEl, newEl) {
  const tag = oldEl.nodeName;
  if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") return;
  if (document.activeElement === oldEl) return;

  if (tag === "SELECT") {
    const want = newEl.querySelector("option[selected]")?.getAttribute("value") ?? newEl.value;
    if (want !== null && oldEl.value !== want) oldEl.value = want;
    return;
  }
  if (tag === "INPUT" && (oldEl.type === "checkbox" || oldEl.type === "radio")) {
    const want = newEl.hasAttribute("checked");
    if (oldEl.checked !== want) oldEl.checked = want;
    return;
  }
  const want = newEl.getAttribute("value");
  if (want !== null && oldEl.value !== want) oldEl.value = want;
}
