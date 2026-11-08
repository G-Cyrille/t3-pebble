#include <pebble.h>
#include "thread-list.h"
#include "i18n-generated.h"
#define tr(id) i18n_text(s_language, id)
#define LANGUAGE_KEY 100
static int s_language;

#define TEXT_SIZE 1200
#define DRAFT_SIZE 901
#define HEADER_HEIGHT 25
#define FOOTER_HEIGHT 22

typedef enum { VIEW_LIST, VIEW_LOADING, VIEW_READ, VIEW_ACTIONS, VIEW_DRAFT,
               VIEW_ERROR, VIEW_SENT, VIEW_MANAGE, VIEW_SNOOZE } View;
typedef enum { CMD_LIST = 1, CMD_READ, CMD_SEND, CMD_POLL, CMD_RETRY, CMD_ORGANIZE, CMD_SEEN } Command;
typedef enum { MSG_LIST = 1, MSG_ROW, MSG_READ, MSG_ERROR, MSG_SENT, MSG_NOTICE, MSG_CONNECTED, MSG_RESET, MSG_UPDATED } Kind;

static Window *s_window;
static MenuLayer *s_menu;
static Layer *s_tabs;
static int s_category, s_list_selection;
static bool s_manage_from_list, s_manage_thread;
static const TextId s_categories[] = {T_TAB_FINISHED, T_TAB_WORKING, T_TAB_SNOOZED, T_TAB_SETTLED};
static const TextId s_snooze_labels[] = {T_SNOOZE_HOUR, T_SNOOZE_THREE, T_SNOOZE_TOMORROW};
static ScrollLayer *s_scroll;
static TextLayer *s_header, *s_body, *s_footer;
static DictationSession *s_dictation;
static AppTimer *s_timeout, *s_poll, *s_apply, *s_seen_timer;
static time_t s_last_refresh, s_last_input;
static bool s_auto_refresh, s_dirty;
static char s_read_token[17];
static int s_seen_attempts;
static View s_view = VIEW_LOADING, s_manage_origin = VIEW_LIST, s_snooze_origin = VIEW_MANAGE, s_reply_origin = VIEW_READ;
static ThreadList s_list;
static ListMode s_list_mode;
static char s_revision[17], s_incoming_revision[17];
static bool s_list_error;
static int s_page, s_pages;
static int s_request, s_last_command, s_last_offset, s_last_action;
static bool s_busy, s_read_only, s_pending;
static char s_route[17], s_thread_title[256], s_text[TEXT_SIZE], s_draft[DRAFT_SIZE];
static char s_header_text[96], s_footer_text[96], s_notice[160];

static const TextId s_action_labels[] = {
  T_REPLY_SUMMARY, T_REPLY_DICTATE, T_REPLY_CONTINUE, T_REPLY_WAITING,
  T_REPLY_RECOMMEND, T_REPLY_COMPUTER, T_REPLY_LATEST
};
static const TextId s_preset_text[] = {
  T_PROMPT_SUMMARY,
  T_EMPTY,
  T_PROMPT_CONTINUE,
  T_PROMPT_WAITING,
  T_PROMPT_RECOMMEND,
  T_PROMPT_COMPUTER
};

static void show(View view);
static void request(Command command, int offset, int action);
static void show_replies(void) {
  if (s_view != VIEW_ACTIONS) s_reply_origin = s_view == VIEW_DRAFT ? VIEW_DRAFT : VIEW_READ;
  show(VIEW_ACTIONS);
}
static void dictate(void);
static void menu_select(MenuLayer *menu, MenuIndex *index, void *context);
static void maybe_prefetch(int direction);
static uint16_t row_count(MenuLayer *menu, uint16_t section, void *context);
static void list_redraw(void);
static void list_footer(void);
static void apply_refresh(void *context);
static void send_seen(void *context);
static int list_top(void) { return s_list.base < PAGE_SIZE ? s_list.base : PAGE_SIZE; }
static int list_bottom(void) {
  if (s_list.has_more) {
    int remaining = s_list.total - s_list.base - s_list.count;
    return remaining < PAGE_SIZE ? remaining : PAGE_SIZE;
  }
  return !s_list.count ? s_busy || s_list_error ? PAGE_SIZE : 1 : 0;
}
static int list_index(void) { return menu_layer_get_selected_index(s_menu).row - list_top(); }

static void copy(char *to, size_t capacity, const char *from) {
  size_t length = strlen(from);
  if (length >= capacity) {
    length = capacity - 1;
    while (length && ((uint8_t)from[length] & 0xc0) == 0x80) length--;
  }
  memcpy(to, from, length); to[length] = '\0';
}
static void header(const char *value) { copy(s_header_text, sizeof(s_header_text), value); text_layer_set_text(s_header, s_header_text); }
static void footer(const char *value) { copy(s_footer_text, sizeof(s_footer_text), value); text_layer_set_text(s_footer, s_footer_text); }
static void body(const char *value) {
  copy(s_text, sizeof(s_text), value);
  text_layer_set_text(s_body, s_text);
  GRect bounds = layer_get_bounds(scroll_layer_get_layer(s_scroll));
  text_layer_set_size(s_body, GSize(bounds.size.w - 16, 2000));
  GSize size = text_layer_get_content_size(s_body);
  int height = size.h + 16;
  text_layer_set_size(s_body, GSize(bounds.size.w - 16, height));
  scroll_layer_set_content_size(s_scroll, GSize(bounds.size.w, height));
  scroll_layer_set_content_offset(s_scroll, GPoint(0, 0), false);
}
static void clear_timeout(void) { if (s_timeout) { app_timer_cancel(s_timeout); s_timeout = NULL; } s_busy = false; }
static void fail(const char *message) {
  clear_timeout(); s_list.receiving = false;
  if (s_auto_refresh) { s_auto_refresh = false; if (s_view == VIEW_LIST) footer(tr(T_REFRESH_UNAVAILABLE)); return; }
  if (s_last_command == CMD_LIST) {
    s_list_error = true;
    if (s_view == VIEW_LIST || s_view == VIEW_LOADING) { show(VIEW_LIST); footer(message); }
    return;
  }
  body(message); show(VIEW_ERROR);
}
static void timed_out(void *context) { s_timeout = NULL; fail(tr(T_PHONE_TIMEOUT)); }

static void request(Command command, int offset, int action) {
  bool background = command == CMD_POLL || command == CMD_SEEN;
  if (s_busy && background) return;
  if (!background) {
    APP_LOG(APP_LOG_LEVEL_INFO, "Request command=%d offset=%d", command, offset);
    clear_timeout(); s_request = (s_request + 1) & 0x7fffffff;
    s_auto_refresh = command == CMD_LIST && action == 4;
    if (command == CMD_LIST && (action == 1 || action == 4)) s_last_refresh = time(NULL);
    if (command == CMD_LIST && action != 4) s_dirty = false;
    s_last_command = command; s_last_offset = offset; s_last_action = action;
    s_list.receiving = false;
    if (command == CMD_LIST) s_list_mode = action == 2 ? LIST_APPEND : action == 3 ? LIST_PREPEND : LIST_REPLACE;
    else if (command == CMD_ORGANIZE) s_list_mode = LIST_REPLACE;
    s_list_error = false;
    s_busy = true;
  }
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    if (!background) fail(tr(T_LINK_BUSY));
    return;
  }
  dict_write_int32(out, MESSAGE_KEY_Command, command);
  dict_write_int32(out, MESSAGE_KEY_Request, s_request);
  dict_write_int32(out, MESSAGE_KEY_Offset, offset);
  dict_write_int32(out, MESSAGE_KEY_Action, action);
  dict_write_int32(out, MESSAGE_KEY_Category, s_category);
  dict_write_cstring(out, MESSAGE_KEY_Revision, s_revision);
  if (command != CMD_LIST) dict_write_cstring(out, MESSAGE_KEY_Route, s_route);
  else if ((action == 0 || action == 1) && s_list.count) dict_write_cstring(out, MESSAGE_KEY_Route, s_list.rows[s_list.selected].route);
  if (command == CMD_LIST || command == CMD_ORGANIZE) {
    dict_write_int32(out, MESSAGE_KEY_Limit, s_list_mode == LIST_PREPEND ? s_list.base - offset : s_list_mode == LIST_REPLACE && s_list.count ? s_list.count : PAGE_SIZE);
    dict_write_int32(out, MESSAGE_KEY_Index, s_list.selected);
  }
  if (command == CMD_SEND) dict_write_cstring(out, MESSAGE_KEY_Message, s_draft);
  if (command == CMD_SEEN) dict_write_cstring(out, MESSAGE_KEY_Message, s_read_token);
  AppMessageResult result = app_message_outbox_send();
  if (!background) {
    if (result != APP_MSG_OK) { fail(tr(T_PHONE_DISCONNECTED)); return; }
    if (command == CMD_LIST && !s_auto_refresh) { if (s_view != VIEW_LIST) show(VIEW_LIST); else if (!s_list.count) list_redraw(); footer(action == 1 ? tr(T_REFRESHING) : tr(T_LOADING)); }
    else if (!s_auto_refresh) show(VIEW_LOADING);
    s_timeout = app_timer_register(120000, timed_out, NULL);
  }
}
static void scroll_by(int direction) {
  GPoint offset = scroll_layer_get_content_offset(s_scroll);
  GRect bounds = layer_get_bounds(scroll_layer_get_layer(s_scroll));
  GSize content = scroll_layer_get_content_size(s_scroll);
  int bottom = content.h > bounds.size.h ? content.h - bounds.size.h : 0;
  if (s_view == VIEW_READ && ((direction > 0 && -offset.y >= bottom) || (direction < 0 && offset.y == 0))) {
    int next = s_page + direction;
    if (next >= 0 && next < s_pages) request(CMD_READ, next, 0);
    return;
  }
  int y = offset.y - direction * (bounds.size.h - 28);
  if (y > 0) y = 0;
  if (y < -bottom) y = -bottom;
  scroll_layer_set_content_offset(s_scroll, GPoint(0, y), false);
}
static bool menu_visible(void) { return s_view == VIEW_LIST || s_view == VIEW_ACTIONS || s_view == VIEW_MANAGE || s_view == VIEW_SNOOZE; }
static void up(ClickRecognizerRef recognizer, void *context) {
  s_last_input = time(NULL);
  if (s_view == VIEW_LIST && s_busy && !s_auto_refresh && s_list_mode == LIST_REPLACE) return;
  if (menu_visible()) {
    MenuIndex index = menu_layer_get_selected_index(s_menu);
    if (index.row > 0) menu_layer_set_selected_index(s_menu, MenuIndex(0, index.row - 1), MenuRowAlignCenter, false);
    maybe_prefetch(-1);
  }
  else scroll_by(-1);
}
static void down(ClickRecognizerRef recognizer, void *context) {
  s_last_input = time(NULL);
  if (s_view == VIEW_LIST && s_busy && !s_auto_refresh && s_list_mode == LIST_REPLACE) return;
  if (menu_visible()) {
    MenuIndex index = menu_layer_get_selected_index(s_menu);
    if (index.row + 1 < row_count(s_menu, 0, NULL)) menu_layer_set_selected_index(s_menu, MenuIndex(0, index.row + 1), MenuRowAlignCenter, false);
    maybe_prefetch(1);
  }
  else scroll_by(1);
}
static void select_click(ClickRecognizerRef recognizer, void *context) {
  s_last_input = time(NULL);
  if (menu_visible()) { MenuIndex index = menu_layer_get_selected_index(s_menu); menu_select(s_menu, &index, NULL); }
  else if (s_view == VIEW_READ) show_replies();
  else if (s_view == VIEW_DRAFT) request(CMD_SEND, 0, 0);
  else if (s_view == VIEW_ERROR) request(s_last_command ? s_last_command : CMD_LIST, s_last_offset, s_last_action);
  else if (s_view == VIEW_SENT) {
    if (s_route[0]) request(CMD_READ, -1, 1); else request(CMD_LIST, 0, 1);
  }
}
static void back(ClickRecognizerRef recognizer, void *context) {
  s_last_input = time(NULL);
  clear_timeout(); s_list.receiving = false; s_auto_refresh = false; s_request++;
  if (s_view == VIEW_SNOOZE) show(s_snooze_origin);
  else if (s_view == VIEW_MANAGE) {
    if (s_manage_from_list) {
      s_route[0] = '\0'; show(VIEW_LIST);
    } else if (s_manage_origin == VIEW_DRAFT) { body(s_draft); show(VIEW_DRAFT); }
    else if (s_manage_origin == VIEW_ACTIONS) show(VIEW_ACTIONS);
    else request(CMD_READ, s_page, 0);
  }
  else if (s_view == VIEW_ACTIONS && s_reply_origin == VIEW_DRAFT) { body(s_draft); show(VIEW_DRAFT); }
  else if (s_view == VIEW_DRAFT || s_view == VIEW_ACTIONS) request(CMD_READ, s_page, 0);
  else if (s_route[0]) { s_route[0] = '\0'; request(CMD_LIST, s_list.base, 0); }
  else window_stack_pop(true);
}
static void long_up(ClickRecognizerRef recognizer, void *context) {
  s_last_input = time(NULL);
  s_category = (s_category + 1) % ARRAY_LENGTH(s_categories);
  s_route[0] = '\0'; s_draft[0] = '\0';
  memset(&s_list, 0, sizeof(s_list)); request(CMD_LIST, 0, 0);
}
static void long_select(ClickRecognizerRef recognizer, void *context) {
  s_last_input = time(NULL);
  if (s_view != VIEW_LIST && s_view != VIEW_READ && s_view != VIEW_ACTIONS && s_view != VIEW_DRAFT) return;
  if (s_view != VIEW_LIST) { show_replies(); return; }
  s_manage_origin = s_view;
  s_manage_from_list = s_view == VIEW_LIST;
  s_manage_thread = !s_manage_from_list;
  if (s_manage_from_list) {
    s_list_selection = list_index();
    s_route[0] = '\0';
    if (s_list_selection >= 0 && s_list_selection < s_list.count && s_list.rows[s_list_selection].ready) {
      Row *row = &s_list.rows[s_list_selection];
      copy(s_route, sizeof(s_route), row->route);
      copy(s_thread_title, sizeof(s_thread_title), row->title);
      s_manage_thread = true;
    }
  }
  show(VIEW_MANAGE);
}
static void clicks(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up);
  window_long_click_subscribe(BUTTON_ID_UP, 600, long_up, NULL);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 180, down);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 600, long_select, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, back);
}
static int management_count(bool thread) {
  if (!thread) return 1;
  return s_read_only ? 2 : s_category == 3 ? 3 : 4;
}
static const char *management_label(int row, bool thread) {
  if (row == 0) return tr(T_REFRESH_ALL);
  if (row == management_count(thread) - 1) return tr(T_MARK_UNREAD);
  if (row == 1) return s_category == 3 ? tr(T_UNSETTLE) : tr(T_SETTLE);
  return s_category == 2 ? tr(T_WAKE) : tr(T_SNOOZE);
}
static void management_select(int row, bool thread) {
  if (row == 0) { s_route[0] = '\0'; request(CMD_LIST, s_list.base, 1); }
  else if (thread && row == management_count(thread) - 1) {
    // An already queued display receipt must not undo the user's explicit action.
    if (s_seen_timer) { app_timer_cancel(s_seen_timer); s_seen_timer = NULL; }
    s_read_token[0] = '\0';
    request(CMD_ORGANIZE, s_list.base, 7);
  }
  else if (row == 1) request(CMD_ORGANIZE, s_list.base, s_category == 3 ? 5 : 1);
  else if (s_category == 2) request(CMD_ORGANIZE, s_list.base, 6);
  else { s_snooze_origin = s_view; show(VIEW_SNOOZE); }
}
static uint16_t row_count(MenuLayer *menu, uint16_t section, void *context) {
  if (s_view == VIEW_SNOOZE) return ARRAY_LENGTH(s_snooze_labels);
  if (s_view == VIEW_MANAGE) return management_count(s_manage_thread);
  if (s_view == VIEW_ACTIONS) return management_count(true) + (s_read_only ? 1 : ARRAY_LENGTH(s_action_labels) + (s_pending ? 1 : 0));
  return list_top() + s_list.count + list_bottom();
}
static void draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *context) {
  const char *title = "", *subtitle = NULL;
  int row = index->row - (s_view == VIEW_LIST ? list_top() : 0);
  if (s_view == VIEW_SNOOZE) title = tr(s_snooze_labels[row]);
  else if (s_view == VIEW_MANAGE) title = management_label(row, s_manage_thread);
  else if (s_view == VIEW_ACTIONS) {
    int actions = management_count(true);
    title = row < actions ? management_label(row, true) : s_read_only ? tr(T_REFRESH) : row - actions == 7 ? tr(T_RETRY_SEND) : tr(s_action_labels[row - actions]);
  }
  else if (row >= 0 && row < s_list.count) {
    title = s_list.rows[row].ready ? s_list.rows[row].title : tr(T_LOADING);
    subtitle = s_list.rows[row].subtitle;
  } else {
    title = s_list_error ? tr(T_RETRY) : !s_list.count && !s_busy ? tr(T_NO_THREADS) : tr(T_LOADING);
    subtitle = s_list_error ? tr(T_SELECT_RETRY) : NULL;
  }
  if (s_view == VIEW_LIST) {
    GRect bounds = layer_get_bounds(cell);
    graphics_context_set_text_color(ctx, menu_cell_layer_is_highlighted(cell) ? GColorWhite : GColorBlack);
    graphics_draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
      GRect(6, 0, bounds.size.w - 16, 42), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    graphics_draw_text(ctx, subtitle ? subtitle : "", fonts_get_system_font(FONT_KEY_GOTHIC_14),
      GRect(6, 44, bounds.size.w - 16, 18), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  } else {
    menu_cell_basic_draw(ctx, cell, title, subtitle, NULL);
    if (s_view == VIEW_ACTIONS && index->row == management_count(true)) {
      GRect bounds = layer_get_bounds(cell);
      graphics_context_set_stroke_color(ctx, menu_cell_layer_is_highlighted(cell) ? GColorWhite : GColorBlack);
      graphics_draw_line(ctx, GPoint(6, 4), GPoint(bounds.size.w - 6, 4));
    }
  }
}
static int16_t row_height(MenuLayer *menu, MenuIndex *index, void *context) {
  return s_view == VIEW_LIST ? 66 : s_view == VIEW_ACTIONS && index->row == management_count(true) ? 53 : 44;
}
static void draw_tabs(Layer *layer, GContext *ctx) {
  const int widths[] = {38, 54, 56, 52};
  int x = 0;
  for (int i = 0; i < 4; i++) {
    GRect rect = GRect(x, 0, widths[i], HEADER_HEIGHT);
    graphics_context_set_fill_color(ctx, i == s_category ? GColorBlack : GColorWhite);
    graphics_fill_rect(ctx, rect, 0, GCornerNone);
    graphics_context_set_text_color(ctx, i == s_category ? GColorWhite : GColorBlack);
    graphics_draw_text(ctx, tr(s_categories[i]), fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
      GRect(x, 3, widths[i], HEADER_HEIGHT - 3), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    x += widths[i];
  }
}
static void dictation_result(DictationSession *session, DictationSessionStatus status, char *transcription, void *context) {
  if (status != DictationSessionStatusSuccess) {
    if (status == DictationSessionStatusFailureTranscriptionRejected) { request(CMD_READ, s_page, 0); return; }
    fail(tr(T_DICTATION_UNAVAILABLE)); return;
  }
  if (strlen(transcription) >= sizeof(s_draft)) { fail(tr(T_DICTATION_LONG)); return; }
  copy(s_draft, sizeof(s_draft), transcription);
  body(s_draft); show(VIEW_DRAFT);
}
static void dictate(void) {
  if (!s_dictation) { fail(tr(T_NO_MICROPHONE)); return; }
  DictationSessionStatus result = dictation_session_start(s_dictation);
  if (result != DictationSessionStatusSuccess) fail(tr(T_DICTATION_FAILED));
}
static void menu_select(MenuLayer *menu, MenuIndex *index, void *context) {
  int row = index->row;
  if (s_view == VIEW_MANAGE) { management_select(row, s_manage_thread); return; }
  if (s_view == VIEW_SNOOZE) { request(CMD_ORGANIZE, s_list.base, row + 2); return; }
  if (s_view == VIEW_ACTIONS) {
    int actions = management_count(true);
    if (row < actions) { management_select(row, true); return; }
    row -= actions;
    if (!s_read_only && row == 7) { request(CMD_RETRY, 0, 0); return; }
    if (s_read_only || row == 6) { request(CMD_READ, -1, 1); return; }
    if (row == 1) { dictate(); return; }
    copy(s_draft, sizeof(s_draft), tr(s_preset_text[row])); body(s_draft); show(VIEW_DRAFT); return;
  }
  row -= list_top();
  if (row >= 0 && row < s_list.count) {
    if (!s_list.rows[row].ready) return;
    s_list.selected = row;
    copy(s_route, sizeof(s_route), s_list.rows[row].route);
    copy(s_thread_title, sizeof(s_thread_title), s_list.rows[row].title);
    s_draft[0] = '\0'; request(CMD_READ, -1, 0); return;
  }
  if (!s_busy && s_list_error && !s_list.count) request(CMD_LIST, 0, 1);
  else if (!s_busy) { s_list_error = false; maybe_prefetch(row < 0 ? -1 : 1); }
}
static void list_footer(void) {
  footer(s_list_error ? tr(T_PAGE_UNAVAILABLE) : s_busy && !s_auto_refresh ? tr(T_LOADING) : s_notice[0] ? s_notice : s_list.count ? tr(T_LIST_HINT) : tr(T_EMPTY_HINT));
}
static void list_redraw(void) {
  menu_layer_reload_data(s_menu);
  menu_layer_set_selected_index(s_menu, MenuIndex(0, list_top() + s_list.selected), MenuRowAlignCenter, false);
}
static void maybe_prefetch(int direction) {
  if (s_view != VIEW_LIST) return;
  int row = list_index();
  if (row >= 0 && row < s_list.count) s_list.selected = row;
  if (s_busy || s_list_error) return;
  if (s_dirty) { request(CMD_LIST, s_list.base, 0); return; }
  if (direction < 0 && s_list.base > 0 && row <= 2)
    request(CMD_LIST, s_list.base > PAGE_SIZE ? s_list.base - PAGE_SIZE : 0, 3);
  else if (direction > 0 && s_list.has_more && row >= s_list.count - 3)
    request(CMD_LIST, s_list.base + s_list.count, 2);
}

static void show(View view) {
  s_view = view;
  bool is_menu = menu_visible();
  layer_set_hidden(s_tabs, view != VIEW_LIST);
  layer_set_hidden(text_layer_get_layer(s_header), view == VIEW_LIST);
  layer_mark_dirty(s_tabs);
  layer_set_hidden(menu_layer_get_layer(s_menu), !is_menu);
  layer_set_hidden(scroll_layer_get_layer(s_scroll), is_menu);
  if (is_menu) {
    menu_layer_reload_data(s_menu);
    menu_layer_set_selected_index(s_menu, MenuIndex(0, view == VIEW_LIST ? list_top() + s_list.selected : view == VIEW_ACTIONS ? management_count(true) : 0), view == VIEW_LIST ? MenuRowAlignCenter : MenuRowAlignTop, false);
  }
  window_set_click_config_provider(s_window, clicks);
  if (view == VIEW_LIST) {
    list_footer();
    if (s_dirty && !s_apply) s_apply = app_timer_register(2000, apply_refresh, NULL);
  } else if (view == VIEW_MANAGE) { header(s_manage_thread ? s_thread_title : tr(T_ACTIONS)); footer(s_read_only ? tr(T_READ_ONLY) : tr(T_CHOOSE_BACK)); }
  else if (view == VIEW_SNOOZE) { header(tr(T_SNOOZE)); footer(tr(T_SNOOZE_UNTIL)); }
  else if (view == VIEW_ACTIONS) { header(s_thread_title); footer(tr(T_REPLIES_HINT)); }
  else if (view == VIEW_DRAFT) { header(s_thread_title); footer(tr(T_DRAFT_HINT)); }
  else if (view == VIEW_LOADING) { header(s_route[0] ? s_thread_title : tr(s_categories[s_category])); body(tr(T_LOADING)); footer(tr(T_BACK_CANCEL)); }
  else if (view == VIEW_ERROR) { header(tr(T_CONNECTION)); footer(tr(T_RETRY_BACK)); }
  else if (view == VIEW_SENT) { header(s_thread_title); footer(tr(T_SENT_HINT)); }
}
static int number(DictionaryIterator *message, uint32_t key, int fallback) {
  Tuple *value = dict_find(message, key); return value ? value->value->int32 : fallback;
}
static const char *string(DictionaryIterator *message, uint32_t key) {
  Tuple *value = dict_find(message, key); return value && value->type == TUPLE_CSTRING ? value->value->cstring : "";
}
static void inbox(DictionaryIterator *message, void *context) {
  const char *language = string(message, MESSAGE_KEY_Language);
  if (language[0]) {
    int next = i18n_language(language);
    if (next != s_language) { s_language = next; persist_write_string(LANGUAGE_KEY, i18n_languages[next]); layer_mark_dirty(s_tabs); menu_layer_reload_data(s_menu); }
  }
  int kind = number(message, MESSAGE_KEY_Kind, 0);
  int id = number(message, MESSAGE_KEY_Request, 0);
  if (id && id != s_request) return;
  if (kind == MSG_CONNECTED) {
    s_read_only = number(message, MESSAGE_KEY_Action, 0);
    s_route[0] = '\0'; s_draft[0] = '\0';
    request(CMD_LIST, 0, 1);
    return;
  }
  if (kind == MSG_NOTICE) {
    const char *notice = string(message, MESSAGE_KEY_Text);
    s_read_only = number(message, MESSAGE_KEY_Action, s_read_only);
    if (id && s_view == VIEW_READ) {
      if (strcmp(s_notice, notice)) { copy(s_notice, sizeof(s_notice), notice); footer(notice); vibes_short_pulse(); }
    } else if (!id && !s_busy) {
      if (!strcmp(notice, tr(T_READY)) && !s_list.count) request(CMD_LIST, 0, 1);
      else { body(notice); show(VIEW_SENT); }
    }
    return;
  }
  if (kind == MSG_UPDATED && s_busy && s_auto_refresh) {
    clear_timeout(); s_auto_refresh = false; s_dirty = true;
    if (s_apply) app_timer_cancel(s_apply);
    s_apply = app_timer_register(2000, apply_refresh, NULL);
    return;
  }
  if (kind == MSG_RESET && s_busy && s_last_command == CMD_LIST) { request(CMD_LIST, s_list.base, 0); return; }
  if (kind == MSG_ERROR) { fail(string(message, MESSAGE_KEY_Text)); return; }
  if (kind == MSG_LIST) {
    APP_LOG(APP_LOG_LEVEL_INFO, "List id=%d category=%d count=%d", id, number(message, MESSAGE_KEY_Category, -1), number(message, MESSAGE_KEY_Count, -1));
    if (!s_busy || (s_last_command != CMD_LIST && s_last_command != CMD_ORGANIZE) ||
        number(message, MESSAGE_KEY_Category, -1) != s_category) return;
    int count = number(message, MESSAGE_KEY_Count, -1);
    if (!thread_list_begin(&s_list, s_list_mode, count, number(message, MESSAGE_KEY_Offset, -1),
        number(message, MESSAGE_KEY_Total, -1), number(message, MESSAGE_KEY_Index, 0))) {
      fail(tr(T_INVALID_LIST)); return;
    }
    copy(s_incoming_revision, sizeof(s_incoming_revision), string(message, MESSAGE_KEY_Revision));
    s_read_only = number(message, MESSAGE_KEY_Action, s_read_only) != 0;
    copy(s_notice, sizeof(s_notice), string(message, MESSAGE_KEY_Notice));
  } else if (kind == MSG_ROW && s_list.receiving) {
    int index = number(message, MESSAGE_KEY_Index, -1);
    if (index < 0 || index >= s_list.expected) return;
    Row *row = &s_list.staging[index];
    copy(row->route, sizeof(row->route), string(message, MESSAGE_KEY_Route));
    copy(row->title, sizeof(row->title), string(message, MESSAGE_KEY_Title));
    copy(row->subtitle, sizeof(row->subtitle), string(message, MESSAGE_KEY_Subtitle));
    thread_list_accept(&s_list, index);
  }
  if ((kind == MSG_LIST || kind == MSG_ROW) && s_list.receiving && s_list.received == s_list.expected) {
    int global_selection = s_list.base + (s_view == VIEW_LIST ? list_index() : s_list.selected);
    if (!thread_list_commit(&s_list)) { fail(tr(T_INCONSISTENT_LIST)); return; }
    if (s_list_mode != LIST_REPLACE) {
      s_list.selected = global_selection - s_list.base;
      if (s_list.selected < 0) s_list.selected = 0;
      if (s_list.selected >= s_list.count) s_list.selected = s_list.count ? s_list.count - 1 : 0;
    }
    copy(s_revision, sizeof(s_revision), s_incoming_revision);
    clear_timeout(); s_list_error = false;
    if (s_view == VIEW_LIST || s_last_command == CMD_ORGANIZE) s_route[0] = '\0';
    if (s_view == VIEW_LIST) { list_redraw(); list_footer(); }
    else if (s_last_command == CMD_ORGANIZE) show(VIEW_LIST);
    return;
  } else if (kind == MSG_READ) {
    clear_timeout(); s_list.receiving = false;
    int flags = number(message, MESSAGE_KEY_Action, 0);
    s_read_only = (flags & 1) != 0; s_pending = (flags & 2) != 0;
    s_page = number(message, MESSAGE_KEY_Offset, 0); s_pages = number(message, MESSAGE_KEY_Total, 1);
    copy(s_read_token, sizeof(s_read_token), string(message, MESSAGE_KEY_Message));
    s_seen_attempts = 0;
    if (s_seen_timer) app_timer_cancel(s_seen_timer);
    if (s_read_token[0]) s_seen_timer = app_timer_register(250, send_seen, NULL);
    show(VIEW_READ); header(string(message, MESSAGE_KEY_Title)); body(string(message, MESSAGE_KEY_Text));
    char label[96]; snprintf(label, sizeof(label), tr(T_READ_FOOTER), s_page + 1, s_pages, s_read_only ? tr(T_VERB_REFRESH) : tr(T_VERB_REPLY)); footer(label);
    s_notice[0] = '\0';
  } else if (kind == MSG_SENT) {
    clear_timeout(); s_pending = false; body(string(message, MESSAGE_KEY_Text)); show(VIEW_SENT); vibes_short_pulse();
  }
}
static void outbox_failed(DictionaryIterator *message, AppMessageResult reason, void *context) {
  if (s_busy && number(message, MESSAGE_KEY_Request, -1) == s_request) fail(tr(T_PHONE_DISCONNECTED));
}
static void send_seen(void *context) {
  s_seen_timer = NULL;
  if (s_view != VIEW_READ || !s_read_token[0] || ++s_seen_attempts > 3) return;
  request(CMD_SEEN, 0, 0);
  s_seen_timer = app_timer_register(750, send_seen, NULL);
}
static void apply_refresh(void *context) {
  s_apply = NULL;
  if (!s_dirty || s_view != VIEW_LIST) return;
  if (s_busy || time(NULL) - s_last_input < 2) {
    s_apply = app_timer_register(500, apply_refresh, NULL); return;
  }
  request(CMD_LIST, s_list.base, 0);
}
static void poll(void *context) {
  s_poll = NULL;
  if (s_view == VIEW_READ && !s_busy) request(CMD_POLL, 0, 0);
  else if (s_view == VIEW_LIST && !s_busy && !s_dirty &&
      time(NULL) - s_last_refresh >= 60 && time(NULL) - s_last_input >= 2)
    request(CMD_LIST, s_list.base, 4);
  s_poll = app_timer_register(20000, poll, NULL);
}
static void initial_request(void *context) { if (!s_request) request(CMD_LIST, 0, 1); }
static void load(Window *window) {
  Layer *root = window_get_root_layer(window); GRect bounds = layer_get_bounds(root);
  GRect content = GRect(0, HEADER_HEIGHT, bounds.size.w, bounds.size.h - HEADER_HEIGHT - FOOTER_HEIGHT);
  s_header = text_layer_create(GRect(7, 0, bounds.size.w - 14, HEADER_HEIGHT));
  text_layer_set_font(s_header, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_overflow_mode(s_header, GTextOverflowModeTrailingEllipsis);
  s_footer = text_layer_create(GRect(7, bounds.size.h - FOOTER_HEIGHT, bounds.size.w - 14, FOOTER_HEIGHT));
  text_layer_set_font(s_footer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  s_scroll = scroll_layer_create(content);
  s_body = text_layer_create(GRect(8, 0, content.size.w - 16, 2000));
  text_layer_set_font(s_body, fonts_get_system_font(FONT_KEY_GOTHIC_24));
  text_layer_set_overflow_mode(s_body, GTextOverflowModeWordWrap);
  scroll_layer_add_child(s_scroll, text_layer_get_layer(s_body));
  s_tabs = layer_create(GRect(0, 0, bounds.size.w, HEADER_HEIGHT));
  layer_set_update_proc(s_tabs, draw_tabs);
  s_menu = menu_layer_create(content);
  menu_layer_set_normal_colors(s_menu, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_menu, GColorBlack, GColorWhite);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks){.get_num_rows = row_count, .get_cell_height = row_height, .draw_row = draw_row, .select_click = menu_select});
  layer_add_child(root, text_layer_get_layer(s_header));
  layer_add_child(root, s_tabs);
  layer_add_child(root, scroll_layer_get_layer(s_scroll));
  layer_add_child(root, menu_layer_get_layer(s_menu));
  layer_add_child(root, text_layer_get_layer(s_footer));
  show(VIEW_LIST);
}
static void unload(Window *window) {
  if (s_poll) app_timer_cancel(s_poll);
  if (s_apply) app_timer_cancel(s_apply);
  if (s_seen_timer) app_timer_cancel(s_seen_timer);
  clear_timeout();
  if (s_dictation) dictation_session_destroy(s_dictation);
  text_layer_destroy(s_header); text_layer_destroy(s_footer); text_layer_destroy(s_body);
  scroll_layer_destroy(s_scroll); menu_layer_destroy(s_menu); layer_destroy(s_tabs);
}
int main(void) {
  char language[16] = "en";
  persist_read_string(LANGUAGE_KEY, language, sizeof(language));
  s_language = i18n_language(language);
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_window_handlers(s_window, (WindowHandlers){.load = load, .unload = unload});
  app_message_register_inbox_received(inbox); app_message_register_outbox_failed(outbox_failed);
  app_message_open(2048, 1200);
  s_dictation = dictation_session_create(DRAFT_SIZE, dictation_result, NULL);
  if (s_dictation) dictation_session_enable_confirmation(s_dictation, false);
  window_stack_push(s_window, true);
  app_timer_register(1000, initial_request, NULL);
  s_poll = app_timer_register(20000, poll, NULL);
  app_event_loop(); window_destroy(s_window);
}
