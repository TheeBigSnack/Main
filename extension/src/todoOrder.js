// The order of the To do tab's take-down and price items (popup.js viewTodo):
// the scan's own order, or oldest first. An item is as old as the open pilot
// flag the numbers keep for it (src/pilot.js noteFlags); an item with no open
// flag goes last, in the scan's order. This website's setting (settings.js
// todoOrder), chosen from the tab; the default is the scan's own order.

export const TODO_ORDERS = Object.freeze([
  Object.freeze({ id: 'listed', label: 'As the scan lists them' }),
  Object.freeze({ id: 'oldest', label: 'Oldest first' }),
]);
export const DEFAULT_TODO_ORDER = 'listed';

export function todoOrderOf(value) {
  return value === 'oldest' ? 'oldest' : DEFAULT_TODO_ORDER;
}

// A new array, sorted by the time flaggedAtOf(item) gives (an ISO string or
// null). Ties and items without a usable time keep the order they came in.
export function oldestFirst(items, flaggedAtOf) {
  const list = Array.isArray(items) ? items : [];
  const when = (item) => {
    const t = Date.parse(flaggedAtOf(item) || '');
    return Number.isNaN(t) ? null : t;
  };
  return list
    .map((item, i) => ({ item, i, t: when(item) }))
    .sort((a, b) => (a.t === null) - (b.t === null) || (a.t ?? 0) - (b.t ?? 0) || a.i - b.i)
    .map((x) => x.item);
}

// The time an item first appeared: the flagged-at time of its open pilot flag
// (the same vin and kind, not yet done), or null when it has none.
export function openFlagTime(flags, vin, kind) {
  const list = Array.isArray(flags) ? flags : [];
  const f = list.find((x) => x && !x.doneAt && x.vin === vin && x.kind === kind);
  return f ? f.flaggedAt || null : null;
}
