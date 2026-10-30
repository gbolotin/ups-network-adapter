export function selectedTarget(states, selection, mapping) {
  const player = mapping[selection];
  const state = states[selection];
  if (!player || !state || ['unknown', 'unavailable'].includes(state.state)) return null;
  return Object.freeze({ entity: selection, queueId: player, name: state.attributes?.friendly_name || selection });
}

export function mutationRequest(operation, target, queue, items, offset, itemId) {
  if (!target || queue?.queue_id !== target.queueId) throw new Error('Queue target changed');
  const localIndex = items.findIndex(item => item.queue_item_id === itemId);
  if (localIndex < 0) throw new Error('Queue item is no longer visible');
  const index = offset + localIndex;
  const currentIndex = Number.isInteger(queue.current_index) ? queue.current_index : -1;
  if (index <= currentIndex) throw new Error('The current item and history are read-only');
  if (operation === 'remove') return { command: 'player_queues/delete_item', args: { queue_id: target.queueId, item_id_or_index: itemId } };
  if (operation === 'up' && index > currentIndex + 1) return { command: 'player_queues/move_item', args: { queue_id: target.queueId, queue_item_id: itemId, pos_shift: -1 } };
  if (operation === 'down' && index + 1 < queue.items) return { command: 'player_queues/move_item', args: { queue_id: target.queueId, queue_item_id: itemId, pos_shift: 1 } };
  throw new Error('Cannot move beyond the upcoming queue');
}
