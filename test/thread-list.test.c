#include "thread-list.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static ThreadList list;
static void batch(ListMode mode, int start, int count, int total, int selected) {
  assert(thread_list_begin(&list, mode, count, start, total, selected));
  for (int i = count - 1; i >= 0; i--) {
    snprintf(list.staging[i].route, sizeof(list.staging[i].route), "thread-%d", start + i);
    assert(thread_list_accept(&list, i));
  }
  assert(thread_list_commit(&list));
}
int main(void) {
  batch(LIST_REPLACE, 0, 6, 100, 3);
  assert(list.selected == 3 && list.has_more);
  assert(thread_list_begin(&list, LIST_APPEND, 6, 6, 100, 0));
  strcpy(list.staging[0].route, "thread-6");
  assert(thread_list_accept(&list, 0)); assert(thread_list_accept(&list, 0));
  assert(list.received == 1 && !thread_list_commit(&list));
  assert(list.count == 6 && !strcmp(list.rows[3].route, "thread-3"));
  // Incomplete/cancelled transfers never become visible, nor advance the offset.
  list.receiving = false;
  assert(!thread_list_accept(&list, 1));
  batch(LIST_APPEND, 6, 6, 100, 0);
  assert(list.count == 12 && list.selected == 3 && list.base == 0);
  assert(!thread_list_begin(&list, LIST_APPEND, 6, 7, 100, 0));
  assert(!thread_list_begin(&list, LIST_REPLACE, 61, 0, 100, 0));
  assert(!thread_list_begin(&list, LIST_REPLACE, 6, 0, 5, 0));
  // An overlapping thread would shift every subsequent offset. Reject atomically.
  assert(thread_list_begin(&list, LIST_APPEND, 1, 12, 100, 0));
  strcpy(list.staging[0].route, "thread-1"); thread_list_accept(&list, 0);
  assert(!thread_list_commit(&list) && list.count == 12);
  batch(LIST_REPLACE, 0, 60, 100, 57);
  batch(LIST_APPEND, 60, 6, 100, 0);
  assert(list.base == 6 && list.count == 60 && list.selected == 51);
  assert(!strcmp(list.rows[list.selected].route, "thread-57"));
  list.selected = 1;
  batch(LIST_PREPEND, 0, 6, 100, 0);
  assert(list.base == 0 && list.count == 60 && list.selected == 7);
  assert(!strcmp(list.rows[list.selected].route, "thread-7"));
  // User reversed direction while fetching: don't evict their newly selected row.
  list.selected = 0;
  batch(LIST_APPEND, 60, 6, 100, 0);
  assert(list.base == 0 && list.selected == 0 && list.count == 60);
  batch(LIST_REPLACE, 6, 60, 100, 59);
  batch(LIST_PREPEND, 0, 6, 100, 0);
  assert(list.base == 6 && list.selected == 59);
  batch(LIST_REPLACE, 94, 6, 100, 4);
  assert(!list.has_more && list.selected == 4);
  batch(LIST_REPLACE, 0, 2, 2, 5);
  assert(list.selected == 1 && list.base == 0 && !list.has_more);
  batch(LIST_REPLACE, 0, 0, 0, 0);
  assert(list.count == 0 && list.selected == 0 && !list.has_more);
  puts("Native list: atomic batches, selection, memory bound, reverse navigation and invalid input OK.");
}
