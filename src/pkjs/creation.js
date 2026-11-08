'use strict';
var sha256 = require('js-sha256').sha256;
var api = require('./client');
var text = require('./text');
var protocol = require('./protocol');
var i18n = require('./i18n');
function Creation(controller) {
  this.owner = controller; this.client = controller.client; this.storage = controller.storage;
  this.pending = controller.restore('creation'); this.environments = {}; this.projects = {}; this.projectLists = {};
  this.token = ''; this.inflight = null;
  this.identity = sha256(this.client.url + '\n' + (this.client.token || ''));
}
Creation.prototype.save = function () {
  if (this.detached) return;
  try {
    if (this.pending) this.storage.setItem('t3.creation', JSON.stringify(this.pending));
    else this.storage.removeItem('t3.creation');
  } catch (_) { throw api.problem(i18n.t('creation_storage'), 'storage'); }
};
Creation.prototype.allowed = function () {
  return this.client.access !== 'read-only';
};
Creation.prototype.page = function (rows, offset, action) {
  if (typeof offset !== 'number' || offset < 0 || offset % 1) throw api.problem(i18n.t('invalid_page'), 'input');
  offset = Math.min(offset, Math.max(0, Math.floor((rows.length - 1) / protocol.pageSize) * protocol.pageSize));
  var result = [{Kind: protocol.kind.CHOICES, Action: action, Count: Math.min(protocol.pageSize, rows.length - offset),
    Offset: offset, Total: rows.length, Creation: this.token}];
  rows.slice(offset, offset + protocol.pageSize).forEach(function (row, index) {
    result.push({Kind: protocol.kind.CHOICE, Index: index, Route: row.route, Title: text.clip(row.title, 252), Subtitle: text.clip(row.subtitle || '', 78)});
  });
  return result;
};
Creation.prototype.created = function (record) {
  var owner = this.owner, route = sha256(record.environmentId + '\n' + record.threadId).slice(0, 16);
  owner.routes[route] = {route: route, environmentId: record.environmentId, threadId: record.threadId,
    label: record.environmentLabel, title: record.title, status: record.status || 'running'};
  owner.snapshot = null;
  return [{Kind: protocol.kind.CREATED, Route: route, Title: text.clip(record.title, 252), Creation: record.id}];
};
Creation.prototype.begin = function (offset, callback, generation) {
  var self = this;
  if (!self.allowed()) return callback(api.problem(i18n.t('rights_readonly'), 'capability_denied'));
  var pending = self.pending;
  if (pending && !pending.acknowledged) {
    if (pending.identity !== self.identity) return callback(api.problem(i18n.t('creation_connection_changed'), 'pending'));
    if (pending.threadId) return callback(null, self.created(pending));
    return callback(null, [{Kind: protocol.kind.CREATION_DRAFT, Route: pending.projectRoute, Creation: pending.id,
      Title: text.clip(pending.environmentLabel + ' · ' + pending.projectTitle, 78), Text: pending.message}]);
  }
  function finish(error, environments) {
    if (generation !== self.owner.generation) return;
    if (error) return callback(error);
    var rows = environments.filter(function (env) { return env.status === 'reachable'; }).map(function (env) {
      var route = sha256('environment:' + env.environmentId).slice(0, 16);
      return {route: route, environmentId: env.environmentId, title: env.label};
    });
    self.environments = {}; rows.forEach(function (row) { self.environments[row.route] = row; });
    self.environmentList = rows;
    callback(null, self.page(rows, offset, 0));
  }
  if (offset && self.environmentList) return callback(null, self.page(self.environmentList, offset, 0));
  self.token = sha256(String(Date.now()) + ':' + Math.random()).slice(0, 32);
  self.projects = {}; self.projectLists = {};
  self.owner.discover(finish);
};
Creation.prototype.listProjects = function (environmentRoute, offset, callback, generation) {
  var self = this, env = self.environments[environmentRoute];
  if (!self.allowed()) return callback(api.problem(i18n.t('rights_readonly'), 'capability_denied'));
  if (!env) return callback(api.problem(i18n.t('creation_choose_again'), 'stale'));
  if (self.projectLists[environmentRoute]) return callback(null, self.page(self.projectLists[environmentRoute], offset, 1));
  var rows = [];
  function next(cursor) {
    self.client.tool('t3_project_list', {environmentId: env.environmentId, cursor: cursor, limit: 100}, function (error, result) {
      if (generation !== self.owner.generation) return;
      if (error) return callback(error);
      (result.projects || []).forEach(function (project) {
        if (project.deletedAt || project.archivedAt) return;
        var route = sha256(env.environmentId + '\nproject:' + project.id).slice(0, 16);
        if (!rows.some(function (row) { return row.route === route; })) rows.push({route: route, environmentId: env.environmentId,
          environmentLabel: env.title, projectId: project.id, title: project.title});
      });
      if (result.nextCursor !== null && result.nextCursor !== undefined) {
        if (typeof result.nextCursor !== 'number' || result.nextCursor % 1 || result.nextCursor <= cursor)
          return callback(api.problem(i18n.t('pagination_stalled'), 'protocol'));
        return next(result.nextCursor);
      }
      rows.sort(function (a, b) { return a.title.localeCompare(b.title) || a.route.localeCompare(b.route); });
      rows.forEach(function (row) { self.projects[row.route] = row; });
      self.projectLists[environmentRoute] = rows;
      callback(null, self.page(rows, offset, 1));
    });
  }
  next(0);
};
Creation.prototype.create = function (input, callback) {
  var self = this, pending = self.pending, project = self.projects[input.Route];
  if (!self.allowed()) return callback(api.problem(i18n.t('rights_readonly'), 'capability_denied'));
  if (typeof input.Message !== 'string' || !input.Message.trim() || text.bytes(input.Message) > 900)
    return callback(api.problem(i18n.t('reply_long'), 'input'));
  var fingerprint = sha256(input.Route + '\n' + input.Message);
  if (pending && pending.id === input.Creation) {
    if (pending.identity !== self.identity || pending.fingerprint !== fingerprint)
      return callback(api.problem(i18n.t('creation_pending'), 'pending'));
    if (pending.threadId) return callback(null, self.created(pending));
  } else {
    if (pending && !pending.acknowledged) return callback(api.problem(i18n.t('creation_pending'), 'pending'));
    if (!project || !input.Creation || input.Creation !== self.token)
      return callback(api.problem(i18n.t('creation_choose_again'), 'stale'));
    pending = {id: input.Creation, identity: self.identity, fingerprint: fingerprint, projectRoute: input.Route,
      environmentId: project.environmentId, environmentLabel: project.environmentLabel, projectId: project.projectId,
      projectTitle: project.title, message: input.Message, title: text.clip(input.Message.replace(/\s+/g, ' ').trim(), 100)};
    self.pending = pending;
    try { self.save(); } catch (error) { self.pending = null; return callback(error); }
  }
  if (self.inflight) { self.inflight.push(callback); return; }
  self.inflight = [callback];
  var record = pending;
  self.client.tool('t3_thread_launch', {environmentId: record.environmentId, projectId: record.projectId,
    title: record.title, message: record.message, clientRequestId: 'pebble-create:' + record.id}, function (error, result) {
    var callbacks = self.inflight; self.inflight = null;
    if (!error && (!result || !result.threadId)) error = api.problem(i18n.t('response_incomplete'), 'protocol');
    if (error) {
      if (/^(capability_denied|runtime_mode_escalation_denied|interaction_mode_escalation_denied|invalid_request|project_not_found)$/.test(error.code)) {
        self.pending = null; try { self.save(); } catch (storageError) { error = storageError; }
      } else error = api.problem(i18n.t('creation_unconfirmed'), 'pending');
      return callbacks.forEach(function (cb) { cb(error); });
    }
    record.threadId = result.threadId; record.status = result.status;
    try { self.save(); } catch (storageError) { return callbacks.forEach(function (cb) { cb(storageError); }); }
    callbacks.forEach(function (cb) { cb(null, self.created(record)); });
  });
};
Creation.prototype.acknowledge = function (token) {
  if (!this.pending || !this.pending.threadId || this.pending.id !== token) return;
  this.pending.acknowledged = true; delete this.pending.message;
  try { this.save(); } catch (_) { this.pending.acknowledged = false; }
};
module.exports = {Creation: Creation};
