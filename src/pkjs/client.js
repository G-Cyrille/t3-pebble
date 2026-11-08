'use strict';
var i18n = require('./i18n');
var sha256 = require('js-sha256').sha256;
function problem(message, code, status) {
  var error = new Error(message);
  error.code = code || 'network'; error.status = status || 0;
  return error;
}
function origin(input) {
  var match = /^(https?):\/\/(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?\/?$/.exec(String(input || '').trim());
  if (!match || (match[3] && (+match[3] < 1 || +match[3] > 65535))) throw problem(i18n.t('invalid_url'), 'config');
  var host = match[2].toLowerCase(), ip = host.split('.');
  var tailnet = ip.length === 4 && +ip[0] === 100 && +ip[1] >= 64 && +ip[1] <= 127 && ip.every(function (n) { return /^\d{1,3}$/.test(n) && +n <= 255; });
  if (match[1] === 'http' && host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && !tailnet && !/\.ts\.net$/.test(host)) {
    throw problem(i18n.t('secure_url'), 'config');
  }
  return match[1] + '://' + host + (match[3] ? ':' + match[3] : '');
}
function form(values) {
  return Object.keys(values).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(values[key]); }).join('&');
}
function query(url) {
  var result = {}, raw = url.split('?')[1] || '';
  raw.split('#')[0].split('&').forEach(function (part) {
    var index = part.indexOf('=');
    if (index >= 0) result[decodeURIComponent(part.slice(0, index))] = decodeURIComponent(part.slice(index + 1).replace(/\+/g, ' '));
  });
  return result;
}
function base64url(bytes) {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', result = '', i, value;
  for (i = 0; i < bytes.length; i += 3) {
    value = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    result += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63];
    if (i + 1 < bytes.length) result += alphabet[(value >>> 6) & 63];
    if (i + 2 < bytes.length) result += alphabet[value & 63];
  }
  return result;
}
function xhrRequest(options, callback) {
  var xhr = new XMLHttpRequest(), finished = false;
  function done(error, result) { if (!finished) { finished = true; callback(error, result); } }
  xhr.open(options.method || 'POST', options.url, true);
  xhr.timeout = options.timeout || 20000;
  Object.keys(options.headers || {}).forEach(function (key) { xhr.setRequestHeader(key, options.headers[key]); });
  xhr.onload = function () { done(null, {status: xhr.status, body: xhr.responseText, session: xhr.getResponseHeader('Mcp-Session-Id'), type: xhr.getResponseHeader('Content-Type') || ''}); };
  xhr.onerror = function () { done(problem(i18n.t('network_failed'))); };
  xhr.ontimeout = function () { done(problem(i18n.t('server_timeout'), 'timeout')); };
  xhr.send(options.body || null);
}
function json(response) {
  var source = response.body, events, i, parsed;
  if (/text\/event-stream/i.test(response.type)) {
    events = source.split(/\r?\n\r?\n/);
    for (i = events.length - 1; i >= 0; i--) {
      source = events[i].split(/\r?\n/).filter(function (line) { return line.slice(0, 5) === 'data:'; }).map(function (line) { return line.slice(5).trim(); }).join('\n');
      if (!source) continue;
      parsed = JSON.parse(source);
      if (parsed.id !== undefined) return parsed;
    }
    throw problem(i18n.t('response_incomplete'), 'protocol');
  }
  return JSON.parse(source);
}
function Client(options) {
  this.url = origin(options.url); this.token = options.token || ''; this.access = options.access; this.request = options.request || xhrRequest;
  this.session = null; this.id = 0; this.queue = []; this.busy = false;
}
Client.prototype.http = function (path, body, type, callback) {
  this.request({url: this.url + path, headers: {'Content-Type': type || 'application/json'}, body: type ? body : JSON.stringify(body)}, function (error, response) {
    if (error) return callback(error);
    var data;
    try { data = json(response); } catch (_) { return callback(problem(i18n.t('response_invalid'), 'protocol', response.status)); }
    if (response.status < 200 || response.status >= 300) {
      if (path === '/oauth/mcp/decision' && /unknown|expired|already used/i.test(data.message || '')) {
        return callback(problem(i18n.t('code_expired'), 'pairing_code', response.status));
      }
      return callback(problem(i18n.t('pairing_refused'), 'auth', response.status));
    }
    callback(null, data);
  });
};
Client.prototype.pair = function (config, callback) {
  var self = this, redirect = 'http://127.0.0.1/t3-pebble', access = config.access;
  if (!/^[a-f0-9]{64}$/.test(config.verifier || '') || !/^[a-f0-9]{64}$/.test(config.state || '')) return callback(problem(i18n.t('reopen_settings'), 'config'));
  if (['read-only', 'approval-required', 'auto-accept-edits', 'auto', 'full-access'].indexOf(access) < 0 || !config.code) return callback(problem(i18n.t('code_missing'), 'config'));
  self.http('/oauth/mcp/register', {client_name: config.clientName || 'T3 Pebble', software_id: 't3-pebble', redirect_uris: [redirect], token_endpoint_auth_method: 'none'}, null, function (error, registered) {
    if (error) return callback(error);
    var authorization = {response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, code_challenge: base64url(sha256.array(config.verifier)), code_challenge_method: 'S256', state: config.state, resource: self.url + '/mcp'};
    self.http('/oauth/mcp/decision', {authorization: authorization, decision: {_tag: 'pairing-code', access: access, code: config.code}}, null, function (error, decision) {
      if (error) return callback(error);
      var result;
      try { result = query(decision.redirectTo); } catch (_) { return callback(problem(i18n.t('auth_refused'), 'auth')); }
      if (decision.redirectTo.split('?')[0] !== redirect || result.state !== config.state || result.iss !== self.url || !result.code || result.error) return callback(problem(i18n.t('auth_unconfirmed'), 'auth'));
      self.http('/oauth/mcp/token', form({grant_type: 'authorization_code', client_id: registered.client_id, redirect_uri: redirect, code: result.code, code_verifier: config.verifier, resource: self.url + '/mcp'}), 'application/x-www-form-urlencoded', function (error, token) {
        if (error) return callback(error);
        if (!token.access_token || token.token_type !== 'Bearer') return callback(problem(i18n.t('auth_invalid'), 'auth'));
        self.token = token.access_token; self.session = null;
        callback(null, {url: self.url, token: token.access_token, access: access, expiresAt: Date.now() + token.expires_in * 1000});
      });
    });
  });
};
Client.prototype.post = function (body, callback) {
  var headers = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + this.token};
  if (this.session) { headers['Mcp-Session-Id'] = this.session; headers['MCP-Protocol-Version'] = '2025-06-18'; }
  this.request({url: this.url + '/mcp', headers: headers, body: JSON.stringify(body)}, callback);
};
Client.prototype.open = function (callback) {
  var self = this;
  self.post({jsonrpc: '2.0', id: ++self.id, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't3-pebble', version: require('./catalogs.json').version}}}, function (error, response) {
    if (error) return callback(error);
    if (response.status === 401) return callback(problem(i18n.t('auth_expired'), 'auth', 401));
    if (response.status !== 200 || !response.session) return callback(problem(i18n.t('server_refused'), 'protocol', response.status));
    try { if (!json(response).result) throw new Error(); } catch (_) { return callback(problem(i18n.t('server_unknown'), 'protocol')); }
    self.session = response.session;
    self.post({jsonrpc: '2.0', method: 'notifications/initialized'}, function (error, response) {
      if (error) return callback(error);
      if (response.status < 200 || response.status >= 300) { self.session = null; return callback(problem(i18n.t('connection_interrupted'), 'protocol', response.status)); }
      callback(null);
    });
  });
};
Client.prototype.tool = function (name, args, callback) {
  this.queue.push({name: name, args: args, callback: callback}); this.next();
};
Client.prototype.next = function () {
  if (this.busy || !this.queue.length) return;
  this.busy = true;
  var self = this, item = this.queue.shift(), renewed = false;
  function finish(error, data) { self.busy = false; item.callback(error, data); self.next(); }
  function call() {
    self.post({jsonrpc: '2.0', id: ++self.id, method: 'tools/call', params: {name: item.name, arguments: item.args}}, function (error, response) {
      if (error) return finish(error);
      if (response.status === 404 && !renewed) { renewed = true; self.session = null; return self.open(function (error) { if (error) finish(error); else call(); }); }
      if (response.status === 401) { self.session = null; return finish(problem(i18n.t('auth_expired'), 'auth', 401)); }
      if (response.status !== 200) return finish(problem(i18n.t('server_error'), 'http', response.status));
      var envelope, result, text, data;
      try {
        envelope = json(response);
        if (envelope.error && envelope.error.code === -32602) return finish(problem(i18n.t('invalid_request'), 'invalid_request'));
        if (envelope.error || !envelope.result) return finish(problem(i18n.t('incompatible'), 'protocol'));
        result = envelope.result;
        text = (result.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
        data = result.structuredContent || JSON.parse(text);
      } catch (_) { return finish(problem(i18n.t('response_invalid'), 'protocol')); }
      if (result.isError) return finish(problem(data.code === 'capability_denied' || /mode.*denied/.test(data.code || '') ? i18n.t('rights_denied') : i18n.t('request_refused'), data.code || 'refused'));
      finish(null, data);
    });
  }
  if (self.session) call(); else self.open(function (error) { if (error) finish(error); else call(); });
};
module.exports = {Client: Client, origin: origin, query: query, form: form, base64url: base64url, json: json, xhrRequest: xhrRequest, problem: problem};
