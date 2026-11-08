#include "thread-list.h"
#include <string.h>

static int clamp(int value, int count) { return value < 0 || count == 0 ? 0 : value >= count ? count - 1 : value; }
bool thread_list_begin(ThreadList *list, ListMode mode, int count, int offset, int total, int selected) {
  if (count < 0 || count > LIST_CAPACITY || offset < 0 || total < offset + count ||
      (mode == LIST_APPEND && offset != list->base + list->count) ||
      (mode == LIST_PREPEND && offset + count != list->base)) return false;
  list->mode = mode; list->expected = count; list->received = 0;
  list->offset = offset; list->incoming_total = total; list->incoming_selected = selected;
  memset(list->staging, 0, sizeof(list->staging)); list->receiving = true;
  return true;
}
bool thread_list_accept(ThreadList *list, int index) {
  if (!list->receiving || index < 0 || index >= list->expected) return false;
  if (!list->staging[index].ready) { list->staging[index].ready = true; list->received++; }
  return true;
}
bool thread_list_commit(ThreadList *list) {
  if (!list->receiving || list->received != list->expected) return false;
  list->receiving = false;
  // Reject overlaps and corrupt batches before touching the visible rows.
  for (int i = 0; i < list->expected; i++) {
    if (!list->staging[i].route[0]) return false;
    for (int j = 0; j < i; j++) if (!strcmp(list->staging[i].route, list->staging[j].route)) return false;
    if (list->mode != LIST_REPLACE) for (int j = 0; j < list->count; j++)
      if (!strcmp(list->staging[i].route, list->rows[j].route)) return false;
  }
  int count = list->expected;
  if (list->mode == LIST_REPLACE) {
    memcpy(list->rows, list->staging, count * sizeof(Row));
    list->count = count; list->base = list->offset;
    list->selected = clamp(list->incoming_selected, count);
  } else {
    int drop = list->count + count - LIST_CAPACITY;
    if (drop < 0) drop = 0;
    if (list->mode == LIST_APPEND) {
      // The user may have moved away while the next batch was in flight.
      // Leave it in the phone cache if applying it would evict their selection.
      if (list->selected < drop) return true;
      memmove(list->rows, list->rows + drop, (list->count - drop) * sizeof(Row));
      memcpy(list->rows + list->count - drop, list->staging, count * sizeof(Row));
      list->base += drop; list->selected -= drop;
    } else {
      if (list->selected >= list->count - drop && list->count) return true;
      memmove(list->rows + count, list->rows, (list->count - drop) * sizeof(Row));
      memcpy(list->rows, list->staging, count * sizeof(Row));
      list->base = list->offset; list->selected += count;
    }
    list->count += count - drop;
  }
  list->total = list->incoming_total;
  list->has_more = list->base + list->count < list->total;
  return true;
}
