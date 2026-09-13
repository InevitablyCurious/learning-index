// ── FACET FILTERS — pick what you want to SEE, not what to hide ─────────────
//
// ── THE MODEL THAT WAS WRONG ────────────────────────────────────────────────
//
// The event feed's chips began every session with all seven kinds ON, and a
// click REMOVED that kind from the feed. So the control read as "hide this",
// and the only way to answer the question an operator actually asks — "show me
// just the errors" — was to click six other chips off, one at a time, and then
// click them all back on afterwards to undo it. The work scaled with the number
// of kinds you did NOT want, which is backwards: a filter should cost one click
// for the thing you DO want.
//
// ── THE MODEL HERE ──────────────────────────────────────────────────────────
//
// The same one every faceted list uses, because it is the one people already
// know:
//
//   NOTHING SELECTED  →  everything is shown. This is the resting state and it
//                        is NOT "all filters on" — no filter is engaged at all.
//   ONE SELECTED      →  only that. One click, from any starting point.
//   SEVERAL SELECTED  →  the UNION of them, never the intersection. A row has
//                        exactly one kind, so an intersection would always be
//                        empty and every second click would blank the feed.
//
// ── THREE VISUAL STATES, NOT TWO ────────────────────────────────────────────
//
// The old control had on/off, which cannot express the resting state: with
// every chip lit, "no filter" and "everything explicitly included" look
// identical, and an operator cannot tell whether a filter is engaged. So:
//
//   neutral    nothing is selected anywhere — no filter is engaged
//   picked     this value is selected
//   muted      something else is selected, so this one is excluded
//
// `muted` inherits the old `off` reasoning verbatim: absence is drawn as
// absence — hollow and dim — never as a second colour, which would read as a
// second category of event rather than as an exclusion.
//
// ── ALWAYS ESCAPABLE ────────────────────────────────────────────────────────
//
// Clicking the last picked value returns to neutral, and `clearFacet` backs the
// CLEAR control that appears only while a filter is engaged. A filter an
// operator cannot see is engaged, and cannot leave in one action, is a filter
// they will mistake for an empty feed.

/**
 * One facet's selection. `values` is the closed set it can hold, in the order
 * the chips are drawn — the caller owns that order so the chip row is stable
 * from render to render rather than reordering as things are picked.
 */
export function createFacet(values) {
  return { values: [...values], selected: new Set() };
}

/** Add or remove one value. Unknown values are ignored, never added. */
export function toggleFacet(facet, value) {
  if (!facet || !facet.values.includes(value)) return;
  if (facet.selected.has(value)) facet.selected.delete(value);
  else facet.selected.add(value);
}

/** Back to the resting state: no filter engaged, everything shown. */
export function clearFacet(facet) {
  facet?.selected.clear();
}

/** Whether any filter is engaged. Drives the CLEAR control and the neutral look. */
export function facetActive(facet) {
  return (facet?.selected.size ?? 0) > 0;
}

/**
 * Does this row survive the filter?
 *
 * AN EMPTY SELECTION ACCEPTS EVERYTHING. That is the whole inversion: no
 * selection is not "nothing passes", it is "nothing is being filtered".
 */
export function facetAccepts(facet, value) {
  if (!facetActive(facet)) return true;
  return facet.selected.has(value);
}

/**
 * The visual state for one chip: `picked` · `muted` · `neutral`.
 *
 * Derived here rather than in each panel so two feeds cannot disagree about
 * what a chip means.
 */
export function facetState(facet, value) {
  if (!facetActive(facet)) return "neutral";
  return facet.selected.has(value) ? "picked" : "muted";
}

/**
 * A stable signature of the selection, for render-skipping.
 *
 * Sorted, so picking A then B and picking B then A produce the same signature —
 * they are the same filter, and a repaint that depended on click ORDER would be
 * a repaint nobody asked for.
 */
export function facetSignature(facet) {
  return [...(facet?.selected ?? [])].sort().join(",");
}

/** Selected values in the facet's own display order, for prose. */
export function facetPicked(facet) {
  return facet.values.filter((v) => facet.selected.has(v));
}
