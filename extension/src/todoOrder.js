// The order of the To do tab's take-down and price items (popup.js viewTodo):
// the scan's own order, or oldest first. An item is as old as the open pilot
// flag the numbers keep for it (src/pilot.js noteFlags), so an item with no
// open flag goes last, in the scan's order. The pilot numbers time only the
// salesperson's own items, so a colleague's, an unmarked car's, and a take-down
// for a car now called new, demo or loaner have none: with "Oldest first" such
// an item sits after the timed ones, whatever its age.
// This website's setting (settings.js todoOrder), chosen from the tab; the
// default is the scan's own order.

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

// One kind of item (take-downs or price changes) in the order chosen: oldest
// first by each item's open flag of that kind, or the scan's own order.
export function orderedTodo(items, kind, flags, order) {
  if (todoOrderOf(order) !== 'oldest') return Array.isArray(items) ? [...items] : [];
  return oldestFirst(items, (it) => openFlagTime(flags, it.vin, kind));
}

// The To do tab's order control: a select of the two orders with the one
// chosen selected, drawn only when there are two or more items to order.
// The labels are constants, so nothing here needs escaping.
export function todoOrderControl(order, count) {
  if (!(count > 1)) return '';
  const picked = todoOrderOf(order);
  const options = TODO_ORDERS.map((o) => `<option value="${o.id}"${o.id === picked ? ' selected' : ''}>${o.label}</option>`).join('');
  return `<div class="toolbar listControls"><label class="control"><span>Order</span><select id="todoOrder">${options}</select></label></div>`;
}
