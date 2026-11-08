'use strict';
var i18n = require('./i18n');
var api = require('./client');
var Controller = require('./controller').Controller;
var page = require('./config-page');
var protocol = require('./protocol');
var text = require('./text');
var outbox = [], sending = false, controller, client, serial = 0, pairingState = null;
function deliver(message) { message.Language = i18n.language(); outbox.push({value: message, retries: 0}); pump(); }
function pump() {
  if (sending || !outbox.length) return;
  sending = true;
  var entry = outbox[0];
  Pebble.sendAppMessage(entry.value, function () { outbox.shift(); sending = false; pump(); }, function () {
    sending = false;
    if (++entry.retries > 2) outbox.shift();
    setTimeout(pump, 350);
  });
}
function saved() { try { return JSON.parse(localStorage.getItem('t3.connection') || 'null'); } catch (_) { return null; } }
function preferences() { try { return JSON.parse(localStorage.getItem('t3.preferences') || '{}'); } catch (_) { return {}; } }
i18n.set(preferences().language);
function connect(config) {
  if (controller) controller.generation++;
  client = new api.Client(config);
  controller = new Controller({client: client, storage: localStorage, send: deliver, log: function (message) { console.log('T3 Pebble: ' + message); }});
}
function connected(connection) {
  deliver({Kind: protocol.kind.CONNECTED, Request: 0, Action: connection.access === 'read-only' ? 1 : 0});
}
function resume(connection, attempt, pairingError) {
  if (!connection || !connection.token) return deliver({Kind: protocol.kind.ERROR, Request: 0, Text: i18n.t('new_code')});
  connect(connection);
  client.tool('t3_environment_read', {}, function (error) {
    if (attempt !== serial) return;
    if (error) return deliver({Kind: protocol.kind.ERROR, Request: 0, Text: text.clip((pairingError || error).message, 400)});
    connected(connection);
  });
}
Pebble.addEventListener('ready', function () {
  var config = saved();
  if (config && config.token) connect(config);
  deliver({Kind: protocol.kind.NOTICE, Request: 0, Action: config && config.access === 'read-only' ? 1 : 0, Text: config ? i18n.t('ready') : i18n.t('open_settings')});
});
Pebble.addEventListener('appmessage', function (event) {
  if (!controller) return deliver({Kind: protocol.kind.ERROR, Request: event.payload.Request, Text: i18n.t('open_settings_connect')});
  if (event.payload.Command !== protocol.command.POLL && event.payload.Command !== protocol.command.SEEN) outbox = outbox.filter(function (entry, index) {
    return (sending && index === 0) || !entry.value.Request || entry.value.Request === event.payload.Request;
  });
  controller.handle(event.payload);
});
Pebble.addEventListener('showConfiguration', function () {
  var config = saved() || {};
  var initial = {url: config.url || '', access: config.access || '', connected: !!config.token, language: i18n.language()};
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(page.replace('__INITIAL_CONFIG__', JSON.stringify(initial).replace(/</g, '\\u003c'))));
});
Pebble.addEventListener('webviewclosed', function (event) {
  if (!event.response || event.response === 'CANCELLED') return;
  var config;
  try { config = JSON.parse(decodeURIComponent(event.response)); } catch (_) { return deliver({Kind: protocol.kind.ERROR, Request: 0, Text: i18n.t('settings_invalid')}); }
  if (config.language) {
    i18n.set(config.language);
    localStorage.setItem('t3.preferences', JSON.stringify({language: i18n.language()}));
    if (controller) controller.documents = {};
  }
  if (config.preferences) {
    var connection = saved();
    if (connection && connection.token) { if (!controller) connect(connection); connected(connection); }
    else deliver({Kind: protocol.kind.NOTICE, Request: 0, Text: i18n.t('open_settings')});
    return;
  }
  if (config.disconnect) {
    serial++; pairingState = null; if (controller) controller.generation++;
    localStorage.removeItem('t3.connection'); localStorage.removeItem('t3.pending');
    client = null; controller = null;
    return deliver({Kind: protocol.kind.ERROR, Request: 0, Text: i18n.t('disconnected')});
  }
  if (config.resume) return resume(saved(), ++serial);
  var candidate;
  try { candidate = new api.Client({url: config.url}); } catch (error) { return deliver({Kind: protocol.kind.ERROR, Request: 0, Text: error.message}); }
  if (config.state && config.state === pairingState) return;
  pairingState = config.state;
  var attempt = ++serial;
  deliver({Kind: protocol.kind.NOTICE, Request: 0, Text: i18n.t('connecting')});
  candidate.pair(config, function (error, connection) {
    config.code = ''; config.verifier = ''; config.state = '';
    if (attempt !== serial) return;
    pairingState = null;
    var previous = saved();
    if (error && error.code === 'pairing_code' && previous && previous.url === candidate.url && previous.access === config.access) {
      return resume(previous, attempt, error);
    }
    if (error) return deliver({Kind: protocol.kind.ERROR, Request: 0, Text: text.clip(error.message, 400)});
    localStorage.setItem('t3.connection', JSON.stringify(connection)); connect(connection);
    connected(connection);
  });
});
