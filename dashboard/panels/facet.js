// FACET FILTERS — pick what you want to see (the model every faceted list
// uses):
//   nothing selected  everything shown (no filter engaged)
//   one selected      only that
//   several selected  their union (a row has one kind, so an intersection would
//                     always be empty)
// Chip states: neutral (no filter engaged), picked, muted (excluded — drawn
// hollow and dim, never as a second colour). Clicking the last picked value, or
// CLEAR, returns to neutral.

/**
 * One facet's selection. `values` is the closed set, in the caller's fixed
 * chip order.
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

/** Does this row survive? An empty selection accepts everything. */
export function facetAccepts(facet, value) {
  if (!facetActive(facet)) return true;
  return facet.selected.has(value);
}

/** A chip's visual state, derived here so two feeds can't disagree. */
export function facetState(facet, value) {
  if (!facetActive(facet)) return "neutral";
  return facet.selected.has(value) ? "picked" : "muted";
}

/**
 * A sorted signature of the selection (click order doesn't matter), for
 * skipping repaints.
 */
export function facetSignature(facet) {
  return [...(facet?.selected ?? [])].sort().join(",");
}

/** Selected values in the facet's own display order, for prose. */
export function facetPicked(facet) {
  return facet.values.filter((v) => facet.selected.has(v));
}
