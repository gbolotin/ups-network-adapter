// Acceptance cleanup may remove only the complete queue it actually owns.
export function assertOwnedTestQueue(queue, items, ownedItemIds) {
  if (!Number.isSafeInteger(queue.items) || queue.items < 0 || !Array.isArray(items)
      || queue.items !== items.length || !Array.isArray(ownedItemIds)) {
    throw new Error('Incomplete queue readback; preserve the current queue');
  }
  const owned = new Set(ownedItemIds);
  const current = new Set();
  for (const item of items) {
    if (typeof item.queue_item_id !== 'string' || !item.queue_item_id
        || !owned.has(item.queue_item_id) || current.has(item.queue_item_id)) {
      throw new Error('Another controller changed the queue; preserve its data and inspect cleanup');
    }
    current.add(item.queue_item_id);
  }
}
