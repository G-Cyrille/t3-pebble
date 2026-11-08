'use strict';
var i18n = require('./i18n');
var sha256 = require('js-sha256').sha256;
var protocol = require('./protocol');
var text = require('./text');
var api = require('./client');
var Creation = require('./creation').Creation;
function Controller(options) {
  this.log = options.log || function () {};
  this.client = options.client; this.storage = options.storage; this.send = options.send;
  this.rows = []; this.routes = {}; this.environments = []; this.snapshot = null; this.listNotice = ''; this.revision = '';
  this.category = 0; this.documents = {}; this.generation = 0; this.request = 0;
  this.pending = this.restore('pending');
  this.creation = new Creation(this);
  this.readState = this.restore('read-state') || {}; this.receipts = {}; this.receiptSerial = 0;
}
Controller.prototype.restore = function (key) {
  try { return JSON.parse(this.storage.getItem('t3.' + key) || 'null'); } catch (_) { return null; }
};
Controller.prototype.error = function (id, error) {
  this.send({Kind: protocol.kind.ERROR, Request: id, Text: text.clip(error.message || i18n.t('connect_failed'), 400)});
};
Controller.prototype.handle = function (message) {
  var self = this, command = message.Command, id = message.Request;
  if (command === protocol.command.CREATE_ACK) return self.creation.acknowledge(message.Creation);
  if (command === protocol.command.READ && message.Creation) self.creation.acknowledge(message.Creation);
  if (command === protocol.command.SEEN) return self.markSeen(message);
  if (command === protocol.command.POLL) return self.poll(message);
  self.generation++; self.request = id;
  var generation = self.generation;
  function done(error, messages) {
    if (generation !== self.generation) return;
    if (error) return self.error(id, error);
    messages.forEach(function (value) { value.Request = id; self.send(value); });
  }
  if ((command === protocol.command.ENVIRONMENTS || command === protocol.command.PROJECTS) &&
      (typeof message.Offset !== 'undefined' && (typeof message.Offset !== 'number' || message.Offset < 0 || message.Offset % 1)))
    return done(api.problem(i18n.t('invalid_page'), 'input'));
  if (command === protocol.command.ENVIRONMENTS) return self.creation.begin(message.Offset || 0, done, generation);
  if (command === protocol.command.PROJECTS) return self.creation.listProjects(message.Route, message.Offset || 0, done, generation);
  if (command === protocol.command.CREATE) return self.creation.create(message, done);
  if (command === protocol.command.LIST) {
    var category = message.Category === undefined ? self.category : message.Category;
    if (category < 0 || category > 3 || category % 1) return done(api.problem(i18n.t('unknown_category'), 'input'));
    self.category = category;
    if (message.Action === 4) return self.refresh(function (error) {
      done(error, [{Kind: protocol.kind.UPDATED}]);
    }, generation);
    return self.list(message.Offset || 0, message.Action === 1, done, generation,
      {limit: message.Limit, anchor: message.Route, relative: message.Index, revision: message.Revision, continuation: message.Action === 2 || message.Action === 3});
  }
  var row = self.routes[message.Route];
  if (!row) return done(api.problem(i18n.t('stale_list'), 'stale'));
  if (command === protocol.command.READ) return self.read(row, message.Offset === undefined ? -1 : message.Offset, !!message.Action, done, generation);
  if (command === protocol.command.ORGANIZE) return self.organize(row, message.Action, done, generation, message);
  if (command === protocol.command.SEND) return self.reply(row, message.Message, done);
  if (command === protocol.command.RETRY) {
    if (!self.pending || self.pending.route !== row.route) return done(api.problem(i18n.t('no_pending'), 'pending'));
    return self.reply(row, self.pending.message, done);
  }
  done(api.problem(i18n.t('unknown_request'), 'protocol'));
};
Controller.prototype.target = function (row, args) {
  args = args || {}; args.environmentId = row.environmentId;
  if (row.threadId) args.threadId = row.threadId;
  return args;
};
Controller.prototype.discover = function (callback) {
  var self = this;
  self.client.tool('t3_environment_read', {}, function (error, here) {
    if (error) return callback(error);
    var environments = [{environmentId: here.environmentId, label: here.label, status: 'reachable'}];
    self.client.tool('t3_environment_links', {}, function (error, result) {
      if (error && error.code !== 'capability_denied') return callback(error);
      var seen = {};
      callback(null, environments.concat(error ? [] : result.links || []).filter(function (env) {
        if (seen[env.environmentId]) return false;
        seen[env.environmentId] = true; return true;
      }));
    });
  });
};
function stateLabel(status, unread) {
  if (status === 'waiting') return i18n.t('state_waiting');
  if (/^(running|preparing|queued|starting)$/.test(status)) return i18n.t('state_working');
  if (status === 'completed') return unread ? i18n.t('state_unread') : i18n.t('state_finished');
  if (status === 'failed') return i18n.t('state_failed');
  if (status === 'interrupted') return i18n.t('state_interrupted');
  if (status === 'cancelled' || status === 'rolled_back') return i18n.t('state_cancelled');
  return i18n.t('state_idle');
}
var workingStatuses = ['preparing', 'queued', 'starting', 'running', 'waiting'];
function matchesCategory(thread, category) {
  if (thread.settled) return category === 3;
  if (thread.snoozed) return category === 2;
  return (workingStatuses.indexOf(thread.status) >= 0 ? 1 : 0) === category;
}
function sortRows(rows) {
  function rank(row) { return row.status === 'waiting' ? 0 : /^(running|preparing|queued|starting)$/.test(row.status) ? 1 : 2; }
  rows.sort(function (a, b) { return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || a.route.localeCompare(b.route); });
}
// Build a replacement off to the side. A cancelled or failed refresh cannot corrupt
// the order/offsets currently being browsed, or resurrect half an older snapshot.
Controller.prototype.refresh = function (callback, generation) {
  var self = this, rows = {}, warnings = [], previous = self.snapshot || [];
  function cancelled() { return generation !== undefined && generation !== self.generation; }
  self.log('refresh start');
  self.discover(function (error, environments) {
    if (cancelled()) return;
    if (error) return callback(error);
    function offline(env) {
      warnings.push(env.label + i18n.t('offline_suffix'));
      previous.forEach(function (row) {
        if (row.environmentId !== env.environmentId) return;
        var stale = {}; Object.keys(row).forEach(function (key) { stale[key] = row[key]; });
        stale.offline = true; rows[row.route] = stale;
      });
    }
    function environmentNext(index) {
      if (cancelled()) return;
      if (index >= environments.length) {
        self.snapshot = Object.keys(rows).map(function (route) { return rows[route]; });
        self.snapshot.forEach(function (row) { row.unread = self.isUnread(row); });
        sortRows(self.snapshot); self.routes = rows; self.environments = environments;
        self.revision = sha256(String(Date.now()) + ':' + Math.random()).slice(0, 16);
        self.documents = {}; self.listNotice = text.clip(warnings.join(' · '), 140);
        self.log('refresh complete: ' + self.snapshot.length + ' threads');
        return callback(null);
      }
      var env = environments[index], collected = {};
      if (env.status !== 'reachable') { offline(env); return environmentNext(index + 1); }
      function next(cursor) {
        if (cancelled()) return;
        self.client.tool('t3_thread_list', {environmentId: env.environmentId, allProjects: true, includeSubagents: false, cursor: cursor, limit: 100}, function (error, result) {
          if (cancelled()) return;
          if (error) {
            self.log('list error: ' + (error.code || 'network'));
            if (error.code === 'auth') return callback(error);
            // A partial machine snapshot is discarded, not mixed with old pages.
            offline(env); return environmentNext(index + 1);
          }
          self.log('list page: ' + (result.threads || []).length + ' threads, cursor ' + cursor);
          (result.threads || []).forEach(function (thread) {
            var route = sha256(env.environmentId + '\n' + thread.threadId).slice(0, 16);
            collected[route] = {route: route, environmentId: env.environmentId, threadId: thread.threadId, label: env.label,
              title: thread.title, status: thread.status, latestRunId: thread.latestRunId || null, itemCount: thread.itemCount || 0, settled: !!thread.settled, snoozed: !!thread.snoozed, updatedAt: thread.updatedAt};
          });
          if (result.nextCursor !== null && result.nextCursor !== undefined) {
            if (typeof result.nextCursor !== 'number' || result.nextCursor % 1 || result.nextCursor <= cursor)
              return callback(api.problem(i18n.t('pagination_stalled'), 'protocol'));
            return next(result.nextCursor);
          }
          Object.keys(collected).forEach(function (route) { rows[route] = collected[route]; });
          environmentNext(index + 1);
        });
      }
      next(0);
    }
    environmentNext(0);
  });
};
Controller.prototype.list = function (offset, refresh, callback, generation, options) {
  var self = this; options = options || {};
  var limit = options.limit === undefined ? protocol.pageSize : options.limit;
  if (typeof offset !== 'number' || offset < 0 || offset % 1 || typeof limit !== 'number' || limit < 1 || limit > 60 || limit % 1)
    return callback(api.problem(i18n.t('invalid_page'), 'input'));
  function finish(error) {
    if (error) return callback(error);
    if (generation !== undefined && generation !== self.generation) return;
    if (options.continuation && options.revision !== self.revision) return callback(null, [{Kind: protocol.kind.RESET}]);
    self.rows = self.snapshot.filter(function (row) { return matchesCategory(row, self.category); });
    var relative = Math.max(0, Math.min(options.relative || 0, limit - 1)), anchor = -1;
    if (options.anchor) self.rows.some(function (row, i) { if (row.route === options.anchor) { anchor = i; return true; } return false; });
    if (anchor >= 0) offset = Math.max(0, anchor - relative);
    // Clamp a refresh after deletion; normal end-of-list requests return an empty page.
    if (refresh || options.anchor) offset = Math.min(offset, Math.max(0, self.rows.length - limit));
    var page = self.rows.slice(offset, offset + limit);
    var responses = [{Kind: protocol.kind.LIST, Revision: self.revision, Category: self.category, Action: self.client.access === 'read-only' ? 1 : 0,
      Count: page.length, Offset: offset, Index: anchor >= 0 ? anchor - offset : Math.min(relative, Math.max(0, page.length - 1)),
      Total: self.rows.length, HasMore: offset + page.length < self.rows.length ? 1 : 0, Notice: self.listNotice}];
    page.forEach(function (row, index) { responses.push({Kind: protocol.kind.ROW, Index: index, Route: row.route,
      Title: text.clip(row.title, 252), Subtitle: text.clip(row.label + ' · ' + (row.offline ? i18n.t('offline') : stateLabel(row.status, row.unread)), 78)}); });
    callback(null, responses);
  }
  if (refresh || !self.snapshot) self.refresh(finish, generation); else finish();
};
// Numeric actions: settle, 1h, 3h, tomorrow, unsettle, unsnooze, local mark-unread.
Controller.prototype.organize = function (row, action, callback, generation, options) {
  var self = this;
  if (action === 7) {
    delete self.readState[row.route]; delete self.receipts[row.route];
    self.storage.setItem('t3.read-state', JSON.stringify(self.readState));
    row.unread = self.isUnread(row);
    self.revision = sha256(String(Date.now()) + ':' + Math.random()).slice(0, 16);
    options = options || {};
    return self.list(options.Offset || 0, false, callback, generation,
      {limit: options.Limit, anchor: row.route, relative: options.Index});
  }
  if (self.client.access === 'read-only') return callback(api.problem(i18n.t('rights_readonly'), 'capability_denied'));
  var args = {}, until = new Date();
  if (action === 1) args.action = 'settle';
  else if (action >= 2 && action <= 4) {
    args.action = 'snooze';
    if (action === 4) { until.setDate(until.getDate() + 1); until.setHours(9, 0, 0, 0); }
    else until.setTime(until.getTime() + (action === 2 ? 1 : 3) * 3600000);
    args.snoozedUntil = until.toISOString();
  } else if (action === 5) args.action = 'unsettle';
  else if (action === 6) args.action = 'unsnooze';
  else return callback(api.problem(i18n.t('unknown_action'), 'input'));
  self.client.tool('t3_thread_organize', self.target(row, args), function (error) {
    if (error) return callback(error);
    if (generation !== undefined && generation !== self.generation) return;
    options = options || {};
    self.list(options.Offset || 0, true, callback, generation,
      {limit: options.Limit, anchor: row.route, relative: options.Index});
  });
};
Controller.prototype.load = function (row, callback, generation) {
  var self = this, doc = {items: [], pages: [], lastPosition: -1, latestStart: 0, status: row.status, runId: row.latestRunId, itemCount: row.itemCount};
  function cancelled() { return generation !== undefined && generation !== self.generation; }
  function next(cursor) {
    if (cancelled()) return;
    var args = {limit: 100, maxCharsPerItem: 3000, runLimit: 1};
    // Omit the first cursor to include position 0; T3 rejects explicit negatives.
    if (cursor >= 0) args.afterPosition = cursor;
    self.client.tool('t3_thread_read', self.target(row, args), function (error, result) {
      if (error) return callback(error);
      if (cancelled()) return;
      doc.status = result.thread.status;
      if (result.thread.latestRunId !== undefined) doc.runId = result.thread.latestRunId;
      if (result.thread.itemCount !== undefined) doc.itemCount = result.thread.itemCount;
      var items = result.items || [], index = 0;
      function itemNext() {
        if (cancelled()) return;
        if (index >= items.length) {
          if (result.hasMore && result.nextPosition !== null) {
            if (result.nextPosition <= cursor) return callback(api.problem(i18n.t('history_incomplete'), 'protocol'));
            return next(result.nextPosition);
          }
          if (!doc.pages.length) doc.pages.push({title: row.label, text: i18n.t('empty_thread')});
          self.documents[row.route] = doc;
          return callback(null, doc);
        }
        var item = items[index++];
        doc.lastPosition = Math.max(doc.lastPosition, item.position);
        if (!item.text || !/^(user|agent|assistant)$/.test(item.createdBy || '')) return itemNext();
        var body = item.text;
        function complete() {
          var role = item.createdBy === 'user' ? i18n.t('role_you') : i18n.t('role_agent');
          if (item.createdBy !== 'user') doc.latestStart = doc.pages.length;
          text.chunks(body, protocol.textBytes).forEach(function (part) { doc.pages.push({title: role + ' · ' + row.label, text: part, agent: item.createdBy !== 'user'}); });
          doc.items.push({id: item.itemId, position: item.position, text: body}); itemNext();
        }
        function continuation(offset) {
          self.client.tool('t3_thread_read', self.target(row, {itemId: item.itemId, textOffset: offset, limit: 1, maxCharsPerItem: 3000}), function (error, more) {
            if (error) return callback(error);
            if (cancelled()) return;
            var chunk = (more.items || [])[0];
            if (!chunk || !chunk.text) return callback(api.problem(i18n.t('message_incomplete'), 'protocol'));
            body += chunk.text;
            if (chunk.textTruncated) {
              if (!(chunk.nextTextOffset > offset)) return callback(api.problem(i18n.t('message_incomplete'), 'protocol'));
              continuation(chunk.nextTextOffset);
            } else complete();
          });
        }
        if (item.textTruncated && item.nextTextOffset !== null) continuation(item.nextTextOffset); else complete();
      }
      itemNext();
    });
  }
  next(-1);
};
Controller.prototype.read = function (row, offset, refresh, callback, generation) {
  var self = this;
  function ready(error, doc) {
    if (error) return callback(error);
    var index = offset < 0 ? doc.latestStart : Math.max(0, Math.min(offset, doc.pages.length - 1)), page = doc.pages[index];
    var receipt = sha256(row.route + ':' + (++self.receiptSerial) + ':' + doc.runId).slice(0, 16);
    self.receipts[row.route] = {token: receipt, runId: doc.runId, itemCount: doc.itemCount, status: !doc.stale && page.agent && index >= doc.latestStart ? doc.status : null};
    var flags = (self.client.access === 'read-only' ? 1 : 0) | (self.pending && self.pending.route === row.route ? 2 : 0);
    callback(null, [{Kind: protocol.kind.READ, Message: receipt, Action: flags, Route: row.route, Title: text.clip(page.title, 78), Text: page.text, Offset: index, Total: doc.pages.length, HasMore: index + 1 < doc.pages.length ? 1 : 0, Notice: stateLabel(doc.status, self.isUnread(row))}]);
  }
  if (!refresh && self.documents[row.route]) ready(null, self.documents[row.route]); else self.load(row, ready, generation);
};
Controller.prototype.reply = function (row, message, callback) {
  var self = this;
  if (self.client.access === 'read-only') return callback(api.problem(i18n.t('rights_readonly'), 'capability_denied'));
  if (typeof message !== 'string' || !message.trim() || text.bytes(message) > 900) return callback(api.problem(i18n.t('reply_long'), 'input'));
  if (self.pending && (self.pending.url !== self.client.url || self.pending.route !== row.route || self.pending.message !== message)) return callback(api.problem(i18n.t('pending_other'), 'pending'));
  if (!self.pending) {
    var counter = +(self.storage.getItem('t3.counter') || 0) + 1;
    self.storage.setItem('t3.counter', String(counter));
    self.pending = {url: self.client.url, route: row.route, message: message, id: 'pebble:' + sha256(row.route + ':' + Date.now() + ':' + counter).slice(0, 40)};
    self.storage.setItem('t3.pending', JSON.stringify(self.pending));
  }
  self.client.tool('t3_thread_send', self.target(row, {message: message, mode: 'auto', clientRequestId: self.pending.id}), function (error, result) {
    if (error) {
      if (/^(capability_denied|runtime_mode_escalation_denied|interaction_mode_escalation_denied|invalid_request|thread_not_found)$/.test(error.code)) {
        self.pending = null; self.storage.removeItem('t3.pending'); return callback(error);
      }
      return callback(api.problem(i18n.t('pending_retry'), 'pending'));
    }
    self.pending = null; self.storage.removeItem('t3.pending'); delete self.documents[row.route];
    callback(null, [{Kind: protocol.kind.SENT, Text: result.delivery === 'queued' ? i18n.t('reply_queued') : i18n.t('reply_sent')}]);
  });
};
// Completion and read state are separate. Metadata edits must not create unread replies.
// A running turn cannot be marked read in advance of its eventual completion.
Controller.prototype.isUnread = function (row) {
  if (row.status !== 'completed') return false;
  var seen = this.readState[row.route];
  return !seen || (row.latestRunId ? seen.runId !== row.latestRunId : seen.itemCount !== row.itemCount);
};
Controller.prototype.markSeen = function (message) {
  var receipt = this.receipts[message.Route], row = this.routes[message.Route];
  if (!receipt || !row || receipt.token !== message.Message || receipt.status !== 'completed') return;
  delete this.receipts[message.Route];
  this.readState[row.route] = {runId: receipt.runId, itemCount: receipt.itemCount};
  this.storage.setItem('t3.read-state', JSON.stringify(this.readState));
  row.unread = this.isUnread(row);
  if (this.snapshot) sortRows(this.snapshot);
  this.revision = sha256(String(Date.now()) + ':' + Math.random()).slice(0, 16);
};
Controller.prototype.poll = function (message) {
  var self = this, row = self.routes[message.Route], before = self.documents[message.Route], generation = self.generation;
  if (!row || !before || self.client.busy) return;
  var args = {limit: 20, maxCharsPerItem: 1500, runLimit: 1};
  if (before.lastPosition > 0) args.afterPosition = before.lastPosition - 1;
  self.client.tool('t3_thread_read', self.target(row, args), function (error, result) {
    if (error || generation !== self.generation) return;
    var changed = (result.items || []).some(function (item) {
      var previous = before.items.filter(function (old) { return old.id === item.itemId; })[0];
      return item.text && /^(agent|assistant)$/.test(item.createdBy || '') && (!previous || previous.text.slice(0, 1500) !== item.text);
    });
    if (changed || result.thread.status !== before.status) {
      before.status = result.thread.status; before.stale = true;
      self.send({Kind: protocol.kind.NOTICE, Request: message.Request, Route: row.route, Text: changed ? i18n.t('new_message') : stateLabel(result.thread.status, self.isUnread({route: row.route, status: result.thread.status, latestRunId: result.thread.latestRunId || row.latestRunId, itemCount: result.thread.itemCount || row.itemCount}))});
    }
  });
};
module.exports = {Controller: Controller, stateLabel: stateLabel};
