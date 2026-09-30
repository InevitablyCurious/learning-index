"use strict";
/* Backgammon client. Talks to the Node/TS backend which is authoritative for
   rules; the client keeps a per-checker location model so movement animates. */

const BAR = 0, OFF = 25;
const $ = (id) => document.getElementById(id);

// ---- board layout: which point sits in each grid cell ----
// Top row (row1) cols 1..6 then bar then cols 8..13; bottom row similar.
const TOP_LEFT = [13, 14, 15, 16, 17, 18];
const TOP_RIGHT = [19, 20, 21, 22, 23, 24];
const BOT_LEFT = [12, 11, 10, 9, 8, 7];
const BOT_RIGHT = [6, 5, 4, 3, 2, 1];

let state = null;               // latest server state
let model = { white: [], black: [] }; // each entry: 1..24 | "bar" | "off"
let checkerEls = { white: [], black: [] };
let pointDivs = {};             // point number -> div
let barDiv = null, trayDiv = null;
let selected = null;            // { from } currently selected source
let busy = false;               // AI animating / transitions in flight
let openingDiceActive = false;  // current dice are the opening roll's [playerDie, computerDie]
let endTimer = null;
let csize = 30;

// ---------- build the static board ----------
function buildBoard() {
  const pf = $("playfield");
  pf.innerHTML = "";
  const hintLayer = $("pointHints");
  hintLayer.innerHTML = "";
  $("checkerLayer").innerHTML = "";
  pointDivs = {};

  const makePoint = (num, row, col, isTop) => {
    const d = document.createElement("div");
    const colorClass = (col % 2 === (isTop ? 0 : 1)) ? "a" : "b";
    d.className = `point ${isTop ? "top" : "bottom"} ${colorClass}`;
    d.style.gridRow = String(row);
    d.style.gridColumn = String(col);
    d.dataset.testid = "point";
    d.dataset.point = String(num);
    const lbl = document.createElement("div");
    lbl.className = "plabel";
    lbl.textContent = num;
    d.appendChild(lbl);
    pf.appendChild(d);
    pointDivs[num] = d;
  };

  // top row
  TOP_LEFT.forEach((n, i) => makePoint(n, 1, i + 1, true));
  TOP_RIGHT.forEach((n, i) => makePoint(n, 1, i + 8, true));
  // bottom row
  BOT_LEFT.forEach((n, i) => makePoint(n, 2, i + 1, false));
  BOT_RIGHT.forEach((n, i) => makePoint(n, 2, i + 8, false));

  // bar
  barDiv = document.createElement("div");
  barDiv.className = "bar barcol";
  barDiv.dataset.testid = "bar";
  barDiv.style.gridColumn = "7";
  barDiv.style.gridRow = "1 / span 2";
  pf.appendChild(barDiv);

  // off tray
  trayDiv = document.createElement("div");
  trayDiv.className = "offtray";
  trayDiv.dataset.testid = "off-tray";
  trayDiv.innerHTML =
    '<div class="offhalf top" data-testid="off-ai"><div class="offlabel">AI off</div></div>' +
    '<div class="offhalf bottom" data-testid="off-you"><div class="offlabel">Your off</div></div>';
  pf.appendChild(trayDiv);

  // pre-create 15 checker elements per color
  checkerEls = { white: [], black: [] };
  for (const color of ["white", "black"]) {
    for (let i = 0; i < 15; i++) {
      const c = document.createElement("div");
      c.className = `checker ${color}`;
      c.dataset.testid = "checker";
      c.dataset.color = color;
      c.style.transform = "translate(-100px,-100px)";
      $("checkerLayer").appendChild(c);
      checkerEls[color].push(c);
    }
  }
}

// ---------- geometry ----------
function computeSizes() {
  const sample = pointDivs[6];
  if (!sample) return;
  const pw = sample.offsetWidth;
  const ph = sample.offsetHeight;
  csize = Math.min(pw * 0.86, (ph * 0.94) / 5.2);
  csize = Math.max(14, csize);
  $("checkerLayer").style.setProperty("--csize", csize + "px");
  $("pointHints").style.setProperty("--csize", csize + "px");
}

// x,y (top-left of checker) for a given location + stack index
function xyFor(color, loc, index, count) {
  if (loc === "bar") {
    const bx = barDiv.offsetLeft + barDiv.offsetWidth / 2 - csize / 2;
    const bh = barDiv.offsetHeight;
    const step = csize * 0.9;
    if (color === "white") return { x: bx, y: bh / 2 + 4 + index * step };
    return { x: bx, y: bh / 2 - csize - 4 - index * step };
  }
  if (loc === "off") {
    const tx = trayDiv.offsetLeft + trayDiv.offsetWidth / 2 - csize / 2;
    const th = trayDiv.offsetHeight;
    const step = csize * 0.30;
    if (color === "white") return { x: tx, y: th - csize - 6 - index * step };
    return { x: tx, y: 6 + index * step };
  }
  // point 1..24
  const d = pointDivs[loc];
  const isTop = loc >= 13;
  const x = d.offsetLeft + d.offsetWidth / 2 - csize / 2;
  const usable = d.offsetHeight * 0.96;
  let step = csize;
  if (count > 5) step = Math.min(csize, (usable - csize) / (count - 1));
  if (isTop) return { x, y: d.offsetTop + 2 + index * step };
  return { x, y: d.offsetTop + d.offsetHeight - csize - 2 - index * step };
}

// ---------- render checkers from model ----------
function render() {
  computeSizes();
  for (const color of ["white", "black"]) {
    // group indices by location
    const byLoc = {};
    model[color].forEach((loc, i) => {
      (byLoc[loc] = byLoc[loc] || []).push(i);
    });
    // reset all badges
    checkerEls[color].forEach((el) => {
      const b = el.querySelector(".countbadge");
      if (b) b.remove();
    });
    for (const loc in byLoc) {
      const idxs = byLoc[loc];
      const count = idxs.length;
      // J8: a numbered point draws at most 6 pieces; bar/off are never capped.
      const drawn = (loc === "bar" || loc === "off") ? count : Math.min(count, 6);
      idxs.forEach((ci, stackPos) => {
        const el = checkerEls[color][ci];
        if (stackPos >= drawn) {
          // surplus beyond the cap: unplaced — untagged, no data-loc,
          // parked off-board at buildBoard's transform, no zIndex. It goes
          // there without sliding: a player never sees a piece leave the board.
          delete el.dataset.testid;
          delete el.dataset.loc;
          el.style.transition = "none";
          el.style.transform = "translate(-100px,-100px)";
          el.style.zIndex = "";
          return;
        }
        // re-tag every render: a former 7th piece that becomes 6th must
        // regain data-testid="checker" — and appears in its slot without
        // sliding in from its off-board parking spot.
        const wasParked = !el.dataset.loc;
        el.dataset.testid = "checker";
        el.dataset.loc = String(loc);
        const { x, y } = xyFor(color, loc === "bar" || loc === "off" ? loc : Number(loc), stackPos, drawn);
        el.style.width = csize + "px";
        el.style.height = csize + "px";
        if (wasParked) el.style.transition = "none";
        el.style.transform = `translate(${x}px, ${y}px)`;
        if (wasParked) {
          void el.offsetWidth;
          el.style.transition = "";
        }
        el.style.zIndex = String(10 + stackPos);
        // J8: count badge rides the 6th (top) drawn piece when 7+ on the point
        if (count > 6 && stackPos === drawn - 1) {
          const badge = document.createElement("div");
          badge.className = "countbadge";
          badge.dataset.testid = "checkerCount";
          badge.textContent = count;
          el.appendChild(badge);
        }
      });
    }
  }
  applySelectable();
}

// ---------- model sync with authoritative counts ----------
function desiredLocs(color, s) {
  const arr = [];
  const sign = color === "white" ? 1 : -1;
  for (let p = 1; p <= 24; p++) {
    const v = s.points[p] * sign;
    for (let k = 0; k < v; k++) arr.push(p);
  }
  const bar = color === "white" ? s.bar.white : s.bar.black;
  for (let k = 0; k < bar; k++) arr.push("bar");
  const off = color === "white" ? s.off.white : s.off.black;
  for (let k = 0; k < off; k++) arr.push("off");
  return arr;
}
function reconcile(s) {
  for (const color of ["white", "black"]) {
    const need = desiredLocs(color, s);
    const cur = model[color];
    const result = new Array(15).fill(null);
    const used = new Array(need.length).fill(false);
    for (let i = 0; i < 15; i++) {
      const li = cur.length > i ? cur[i] : null;
      let found = -1;
      for (let j = 0; j < need.length; j++) {
        if (!used[j] && need[j] === li) { found = j; break; }
      }
      if (found >= 0) { used[found] = true; result[i] = li; }
    }
    const leftover = [];
    for (let j = 0; j < need.length; j++) if (!used[j]) leftover.push(need[j]);
    for (let i = 0; i < 15; i++) if (result[i] === null) result[i] = leftover.pop();
    model[color] = result;
  }
}

function applyLocalMove(color, from, to, hit) {
  const fromLoc = from === BAR ? "bar" : from;
  const toLoc = to === OFF ? "off" : to;
  if (hit) {
    const opp = color === "white" ? "black" : "white";
    const oi = model[opp].findIndex((l) => l === to);
    if (oi >= 0) model[opp][oi] = "bar";
  }
  // J1: the piece that leaves a point is the TOP of its stack as drawn — on a
  // 7+ point the 6th entry at fromLoc (the surplus is parked, never seen);
  // otherwise the LAST entry (greatest index = farthest from the board edge).
  const fromIdxs = [];
  model[color].forEach((l, k) => { if (l === fromLoc) fromIdxs.push(k); });
  const fromDrawn = (fromLoc === "bar" || fromLoc === "off") ? fromIdxs.length : Math.min(fromIdxs.length, 6);
  const i = fromIdxs.length ? fromIdxs[fromDrawn - 1] : -1;
  if (i >= 0) {
    model[color][i] = toLoc;
    // J2: an arrival joins at the TOP (far end) — re-pack so the moved entry
    // becomes the LAST index among all entries equal to toLoc. No-op when it
    // is already last. "off"/"bar" are ordinary group values here.
    // The re-pack rotates model AND checkerEls together: the moved ENTRY
    // (element + value) travels to index `last`, the entries in between shift
    // one index toward the front. Every other element keeps drawing the very
    // same location and slot; only the mover's slot changes — render draws it
    // at the highest stackPos of the group (the far end, farthest from the
    // board edge). DOM order is untouched; element identity survives.
    // On a point already drawing six, the arrival takes the top drawn slot
    // and the piece it displaces joins the parked surplus behind the count.
    const arr = model[color];
    const els = checkerEls[color];
    arr.splice(i, 1);
    const [moverEl] = els.splice(i, 1);
    const members = [];
    arr.forEach((l, k) => { if (l === toLoc) members.push(k); });
    const size = members.length + 1;
    const rank = (toLoc === "bar" || toLoc === "off") ? size - 1 : Math.min(size, 6) - 1;
    const at = rank < members.length ? members[rank] : members.length ? members[members.length - 1] + 1 : i;
    arr.splice(at, 0, toLoc);
    els.splice(at, 0, moverEl);
  }
}

// ---------- selectable checkers + hints ----------
function clearHints() {
  $("pointHints").innerHTML = "";
  checkerEls.white.forEach((e) => e.classList.remove("selected"));
  checkerEls.black.forEach((e) => e.classList.remove("selected"));
}
// J5/J6: column click handlers live on the point divs (1..24); clear them
// wherever checker click handlers are cleared so stale handlers never fire.
function clearPointClicks() {
  for (let n = 1; n <= 24; n++) if (pointDivs[n]) pointDivs[n].onclick = null;
}
function applySelectable() {
  checkerEls.white.forEach((e) => { e.classList.remove("selectable"); e.onclick = null; });
  checkerEls.black.forEach((e) => { e.classList.remove("selectable"); e.onclick = null; });
  clearPointClicks();
  if (busy || !state || state.turn !== "white" || state.phase !== "move") return;
  const froms = new Set(state.legalMoves.map((m) => m.from));
  // mark topmost white checker of each legal source
  froms.forEach((from) => {
    const loc = from === BAR ? "bar" : from;
    // topmost checker at loc — the topmost DRAWN one. With the J8 cap a 7+
    // stack parks its surplus entries off-board as UNPLACED; an unplaced
    // element is not a click target. For stacks of six or fewer this picks
    // exactly the last index, as before.
    const cap = (loc === "bar" || loc === "off") ? 15 : 6;
    let topIdx = -1, topPos = -1;
    model.white.forEach((l, i) => {
      if (l === loc) { topPos++; if (topPos < cap) topIdx = i; }
    });
    if (topIdx >= 0) {
      const el = checkerEls.white[topIdx];
      el.classList.add("selectable");
      el.onclick = () => selectSource(from);
      // J6: the point's whole COLUMN also picks up its top piece. BAR has no
      // column — it stays checker-click (+ J7 auto-show).
      if (from !== BAR) pointDivs[from].onclick = () => selectSource(from);
    }
  });
}

function selectSource(from) {
  if (busy) return;
  selected = from;
  clearHints();
  // J5 precedence: with a piece selected, point columns become DESTINATION
  // handlers only — the J6 pick-up handlers bound by applySelectable go first.
  clearPointClicks();
  // J6 with a piece picked up: another movable piece's column picks that
  // piece up instead — unless it is a destination of this one (bound below).
  new Set(state.legalMoves.map((m) => m.from)).forEach((f) => {
    if (f !== BAR && f !== from) pointDivs[f].onclick = () => selectSource(f);
  });
  // highlight selected source's topmost DRAWN checker
  const loc = from === BAR ? "bar" : from;
  const idxs = [];
  model.white.forEach((l, i) => { if (l === loc) idxs.push(i); });
  const shown = (loc === "bar" || loc === "off") ? idxs.length : Math.min(idxs.length, 6);
  if (idxs.length) checkerEls.white[idxs[shown - 1]].classList.add("selected");

  const dests = state.legalMoves.filter((m) => m.from === from);
  const hintLayer = $("pointHints");
  // group by destination to know stack index and combine dice labels
  const byTo = {};
  dests.forEach((m) => { (byTo[m.to] = byTo[m.to] || []).push(m.die); });
  for (const toStr in byTo) {
    const to = Number(toStr);
    const dice = byTo[toStr];
    const loc = to === OFF ? "off" : to;
    // count existing white checkers at destination to stack the hint on top
    const cnt = model.white.filter((l) => l === (loc === "off" ? "off" : to)).length;
    const { x, y } = xyFor("white", loc === "off" ? "off" : to, cnt, cnt + 1);
    const h = document.createElement("div");
    h.className = "hint";
    h.dataset.testid = "hint";
    // NOTE: positioned via left/top (NOT transform) because the .hint pulse
    // animation drives `transform` and would override an inline translate.
    h.style.left = `${x}px`;
    h.style.top = `${y}px`;
    h.textContent = to === OFF ? "off" : dice.join("/");
    h.title = to === OFF ? "Bear off (die " + dice.join(" or ") + ")" : "Move here using die " + dice.join(" or ");
    h.onclick = () => doMove(from, to, dice[0]);
    hintLayer.appendChild(h);
    // J5: the destination point's whole COLUMN plays the same move (same die
    // as the hint). OFF has no column — bear-off stays hint-only.
    if (to !== OFF) pointDivs[to].onclick = () => doMove(from, to, dice[0]);
  }
}

// ---------- server calls ----------
async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

// ---------- actions ----------
async function doRoll() {
  if (busy || !state || state.turn !== "white" ||
      (state.phase !== "roll" && state.phase !== "openingRoll")) return;
  const wasOpening = state.phase === "openingRoll";
  busy = true;
  animateDiceRolling();
  const s = await api("/api/roll");
  await sleep(480);
  state = s;
  // The opening roll's dice are [playerDie, computerDie] and keep their
  // data-owner marks through the move that follows — but only while the
  // player acts on them (computer win → turn "black" → runAi renders its own
  // dice). A normal roll (entered from phase "roll") clears the marks.
  openingDiceActive = wasOpening && s.turn === "white";
  reconcile(s);
  render();
  busy = false;
  updateUI();
  clearHints();
  // Opening roll: if the computer won, it plays its opening move right away
  // (the backend already set turn "black" / phase "move" with the opening dice).
  if (state.turn === "black") {
    await runAi();
    return;
  }
  // J7: when the roll leaves a bar entry to make, show the entry hints right
  // away — no click on the bar piece needed. MUST run after clearHints() above
  // (updateUI->applySelectable also clears point clicks) or the hints are wiped.
  // The bar checker's own click still works: it re-runs selectSource(BAR),
  // which re-shows the same hints rather than hiding them.
  if (!busy && state && state.turn === "white" && state.phase === "move" &&
      state.legalMoves.some((m) => m.from === BAR)) {
    selectSource(BAR);
  }
  maybeAutoEnd();
}

async function doMove(from, to, die) {
  if (busy) return;
  cancelAutoEnd();
  // optimistic local move (compute hit locally)
  const hit = to !== OFF && model.black.filter((l) => l === to).length === 1;
  applyLocalMove("white", from, to, hit);
  selected = null;
  clearHints();
  render();
  const s = await api("/api/move", { from, to, die });
  state = s;
  reconcile(s);
  render();
  updateUI();

  if (s.winner) {
    showGameOver(s);
  }
}

async function doUndo() {
  if (busy) return;
  cancelAutoEnd();
  const s = await api("/api/undo");
  state = s;
  reconcile(s);
  render();
  selected = null;
  clearHints();
  updateUI();
}

function maybeAutoEnd() {
  if (state && state.turn === "white" && state.phase === "move" && state.turnOver) {
    endTimer = setTimeout(() => doEndTurn(), 1500);
  }
}
function cancelAutoEnd() { if (endTimer) { clearTimeout(endTimer); endTimer = null; } }

async function doEndTurn() {
  cancelAutoEnd();
  if (busy) return;
  if (!state || state.turn !== "white" || !state.turnOver) return;
  openingDiceActive = false; // the opening move is over; the next white roll is a normal roll
  const s = await api("/api/endturn");
  state = s;
  updateUI();
  clearHints();
  await runAi();
}

async function doDouble() {
  if (busy || !state || !state.canDouble) return;
  const s = await api("/api/double");
  // s.accepted / s.cubeReasoning
  if (s.winner) {
    state = s; reconcile(s); render(); updateUI();
    showModal("You Win — Double Declined", `<p>The AI declined your double.</p><p>${escapeHtml(s.message)}</p>`, gameOverButtons());
    return;
  }
  state = s; updateUI();
  showModal("Double Accepted", `<p>The AI accepted your double. The cube is now <b>${s.cube.value}</b>.</p>`, [
    { label: "Roll the dice", primary: true, onClick: () => { hideModal(); } },
  ]);
}

// ---------- AI turn ----------
function showAiDoubleOffer(s) {
  showModal(
    `AI offers a double`,
    `<p>The AI wants to raise the stake to <b>${s.cube.value * 2}</b>.</p>` +
    `<p>If you decline, the AI wins <b>${s.cube.value}</b> point${s.cube.value === 1 ? "" : "s"}.</p>`,
    [
      { label: `Accept (play for ${s.cube.value * 2})`, primary: true, onClick: async () => { hideModal(); await respondDouble(true); } },
      { label: "Decline", onClick: async () => { hideModal(); await respondDouble(false); } },
    ],
  );
}

async function runAi() {
  busy = true;
  updateUI();
  await sleep(500);
  const s = await api("/api/ai");

  if (s.aiDoubled) {
    // AI offers a double; player decides
    busy = false;
    state = s; updateUI();
    showAiDoubleOffer(s);
    return;
  }

  // animate AI dice + moves
  if (s.aiDice) animateDiceRolling();
  await sleep(520);
  if (s.aiDice) renderDice(s.aiDice, []);
  await sleep(1000);
  const moves = s.aiMoves || [];
  for (const m of moves) {
    applyLocalMove("black", m.from, m.to, m.hit);
    render();
    await sleep(500);
  }
  state = s;
  reconcile(s);
  render();
  busy = false;
  updateUI();

  if (s.winner) {
    showGameOver(s);
  }
}

async function respondDouble(accept) {
  const s = await api("/api/double/respond", { accept });
  state = s; reconcile(s); render(); updateUI();
  if (s.winner) {
    showGameOver(s);
    return;
  }
  if (accept) {
    // AI still needs to roll & move
    await runAi();
  }
}

async function doNewGame() {
  cancelAutoEnd();
  openingDiceActive = false;
  const diff = $("difficulty").value;
  const s = await api("/api/new", { difficulty: diff });
  state = s;
  model = { white: [], black: [] };
  reconcile(s);
  render();
  busy = false;
  hideModal();
  updateUI();
}

// ---------- dice rendering ----------
const DICE_DOTS = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};
function dieEl(value, used, rolling) {
  const d = document.createElement("div");
  d.className = "die" + (used ? " used" : "") + (rolling ? " rolling" : "");
  d.dataset.testid = "die";
  const on = new Set(DICE_DOTS[value] || []);
  for (let i = 0; i < 9; i++) {
    const dot = document.createElement("div");
    dot.className = "dot" + (on.has(i) ? "" : " hidden");
    d.appendChild(dot);
  }
  return d;
}
function renderDice(dice, remaining) {
  const box = $("dice");
  box.innerHTML = "";
  if (!dice || dice.length === 0) return;
  const isDouble = dice.length === 4;
  if (isDouble) {
    const total = 4, left = remaining.length;
    // Two dice on screen, four moves (Jerry, 2026-09-25: "only 2 dice should be visible on the front end").
    for (let i = 0; i < 2; i++) box.appendChild(dieEl(dice[0], i >= left, false));
  } else {
    // two distinct dice; a die is "used" if its value not remaining
    const rem = remaining.slice();
    dice.forEach((v) => {
      const idx = rem.indexOf(v);
      const used = idx < 0;
      if (!used) rem.splice(idx, 1);
      box.appendChild(dieEl(v, used, false));
    });
  }
}
// Opening roll renders ONE die per side: dice = [playerDie, computerDie] (the
// ONE unsorted place). Mark each with data-owner so the player can tell whose
// is whose — "you" for dice[0], "ai" for dice[1]. Never identify by DOM position.
// The marks survive the opening resolving to phase "move" (player win) via the
// openingDiceActive flag. `remaining` — pass it only in the move phase — drives
// the same "used" dimming as renderDice; null/omitted → no dimming (tie re-roll).
function renderOpeningDice(dice, remaining) {
  const box = $("dice");
  box.innerHTML = "";
  if (!dice || dice.length < 2) return;
  const rem = Array.isArray(remaining) ? remaining.slice() : null;
  const isUsed = (v) => {
    if (!rem) return false;
    const idx = rem.indexOf(v);
    if (idx < 0) return true;
    rem.splice(idx, 1);
    return false;
  };
  const you = dieEl(dice[0], isUsed(dice[0]), false);
  you.dataset.owner = "you";
  box.appendChild(you);
  const ai = dieEl(dice[1], isUsed(dice[1]), false);
  ai.dataset.owner = "ai";
  box.appendChild(ai);
}
function animateDiceRolling() {
  const box = $("dice");
  box.innerHTML = "";
  const n = 2;
  const els = [];
  for (let i = 0; i < n; i++) { const e = dieEl(1 + Math.floor(Math.random() * 6), false, true); box.appendChild(e); els.push(e); }
  let ticks = 0;
  const iv = setInterval(() => {
    ticks++;
    els.forEach((e) => {
      const v = 1 + Math.floor(Math.random() * 6);
      const on = new Set(DICE_DOTS[v]);
      [...e.children].forEach((dot, i) => dot.className = "dot" + (on.has(i) ? "" : " hidden"));
    });
    if (ticks > 6) clearInterval(iv);
  }, 70);
}

// ---------- UI state sync ----------
function updateUI() {
  if (!state) return;
  $("scoreWhite").textContent = state.score.white;
  $("scoreBlack").textContent = state.score.black;
  $("pipWhite").textContent = state.pip.white;
  $("pipBlack").textContent = state.pip.black;
  $("cubeVal").textContent = state.cube.value;
  $("cubeOwner").textContent = state.cube.owner === null ? "center" : (state.cube.owner === "white" ? "yours" : "AI");

  const ti = $("turnIndicator");
  const yourTurn = state.turn === "white";
  ti.textContent = state.phase === "gameover" ? "—" : (yourTurn ? "You" : "AI");
  ti.className = "turnchip " + (yourTurn ? "you" : "ai");

  const msg = $("message");
  msg.innerHTML = escapeHtml(state.message || "");
  msg.className = "";
  if (state.winner === "white") msg.className = "good";
  else if (state.winner === "black") msg.className = "bad";

  // dice — the opening roll's dice carry data-owner marks in EVERY opening
  // outcome: tie (phase still "openingRoll") and player win (phase already
  // "move", held by openingDiceActive from doRoll). Used-dimming applies only
  // in the move phase; on a tie remainingDice is empty and must not dim.
  if (state.turn === "white" && (openingDiceActive || state.phase === "openingRoll")) {
    renderOpeningDice(state.dice, state.phase === "move" ? state.remainingDice : null);
  } else if (state.phase === "move" && state.turn === "white") renderDice(state.dice, state.remainingDice);
  else if (state.phase !== "move" && state.turn === "white" && (!state.dice || state.dice.length === 0)) $("dice").innerHTML = "";

  // buttons
  const over = state.phase === "gameover";
  $("rollBtn").disabled = busy || over || !(state.turn === "white" && (state.phase === "roll" || state.phase === "openingRoll"));
  $("doubleBtn").disabled = busy || over || !state.canDouble;
  $("undoBtn").disabled = busy || over || !(state.turn === "white" && state.phase === "move" && hasHistory());
  $("endTurnBtn").disabled = busy || over || !(state.turn === "white" && state.turnOver);
  $("endTurnBtn").classList.toggle("primary", !$("endTurnBtn").disabled);
  $("rollBtn").classList.toggle("primary", !$("rollBtn").disabled);

  applySelectable();
}
// we don't get history array in serialized state; infer undo availability from remaining vs dice
function hasHistory() {
  if (!state.dice || state.dice.length === 0) return false;
  return state.remainingDice.length < state.dice.length;
}

// ---------- modal ----------
function showModal(title, bodyHtml, buttons) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = bodyHtml;
  const bc = $("modalBtns");
  bc.innerHTML = "";
  (buttons || []).forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "btn" + (b.primary ? " primary" : "");
    btn.textContent = b.label;
    btn.onclick = b.onClick;
    bc.appendChild(btn);
  });
  $("modalOverlay").classList.remove("hidden");
}
function hideModal() { $("modalOverlay").classList.add("hidden"); }
function gameOverButtons() {
  return [{ label: "New Game", primary: true, onClick: () => doNewGame() }];
}
function showGameOver(s) {
  const won = s.winner === "white";
  const title = won ? "🎉 You Win!" : "AI Wins";
  const body = `<p><b>${escapeHtml(s.message)}</b></p>`;
  showModal(title, body, gameOverButtons());
}

// ---------- utils ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- init ----------
async function init() {
  buildBoard();
  $("rollBtn").onclick = doRoll;
  $("undoBtn").onclick = doUndo;
  $("endTurnBtn").onclick = doEndTurn;
  $("doubleBtn").onclick = doDouble;
  $("newGameBtn").onclick = doNewGame;
  $("difficulty").onchange = () => doNewGame();

  const s = await api("/api/state");
  state = s;
  reconcile(s);
  render();
  updateUI();

  if (s.difficulty) $("difficulty").value = s.difficulty;

  if (s.phase === "doubleOffered" && s.doubleOfferedBy === "black") {
    showAiDoubleOffer(s);
  } else if (s.turn === "black" && s.phase !== "gameover") {
    runAi();
  }

  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { render(); if (selected !== null && state && state.turn === "white" && state.phase === "move") selectSource(selected); }, 120);
  });
}
window.addEventListener("DOMContentLoaded", init);
