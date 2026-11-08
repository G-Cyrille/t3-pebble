#pragma once
#include <stdbool.h>
#define PAGE_SIZE 6
#define LIST_CAPACITY 60

typedef struct { char route[17]; char title[256]; char subtitle[84]; bool ready; } Row;
typedef enum { LIST_REPLACE, LIST_APPEND, LIST_PREPEND } ListMode;
typedef struct {
  Row rows[LIST_CAPACITY], staging[LIST_CAPACITY];
  int count, base, total, selected;
  int expected, received, offset, incoming_total, incoming_selected;
  bool has_more, receiving;
  ListMode mode;
} ThreadList;
bool thread_list_begin(ThreadList *list, ListMode mode, int count, int offset, int total, int selected);
// Fill staging[index], then accept it. Duplicated Bluetooth packets do not count twice.
bool thread_list_accept(ThreadList *list, int index);
bool thread_list_commit(ThreadList *list);
