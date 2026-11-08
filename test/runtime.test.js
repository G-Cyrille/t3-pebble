'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

test('les réglages embarqués ne transmettent aucun jeton existant au navigateur', () => {
  const events = {}, urls = [];
  const source = fs.readFileSync(path.join(__dirname, '../src/pkjs/index.js'), 'utf8');
  const template = require('../src/pkjs/config-page');
  vm.runInNewContext(source, {
    require(name) {return name === './config-page' ? template : require('../src/pkjs/' + name.slice(2));},
    Pebble: {addEventListener(name, handler) {events[name] = handler;}, openURL(url) {urls.push(url);}},
    localStorage: {getItem() {return JSON.stringify({url: 'https://t3.example', token: 'NEVER-IN-URL', access: 'full-access'});}},
    setTimeout
  });
  events.showConfiguration();
  assert.equal(urls.length, 1); assert.ok(urls[0].startsWith('data:text/html'));
  assert.ok(!decodeURIComponent(urls[0]).includes('NEVER-IN-URL'));
  assert.ok(decodeURIComponent(urls[0]).includes('https://t3.example'));
});

function formRuntime(initial = {}) {
  const template = require('../src/pkjs/config-page');
  const elements = new Map();
  const document = {documentElement: {}, querySelectorAll() {return [];}, createElement() {return {};}, getElementById(id) {if (!elements.has(id)) elements.set(id, {appendChild() {}});return elements.get(id);}};
  const window = {crypto: crypto.webcrypto, location: {href: ''}};
  const script = template.match(/<script>([\s\S]*)<\/script>/)[1].replace('__INITIAL_CONFIG__', JSON.stringify(initial));
  vm.runInNewContext(script, {window, document, Uint8Array});
  return {document, window, result: () => JSON.parse(decodeURIComponent(window.location.href.split('#')[1]))};
}

test('the settings form returns cryptographic PKCE values once, with explicit permissions', () => {
  const {document, window, result} = formRuntime({url: 'http://100.100.100.100:7777'});
  document.getElementById('code').value = 'pairing-code';
  document.getElementById('connect').onsubmit({preventDefault() {}});
  const value = result();
  assert.equal(value.url, 'http://100.100.100.100:7777'); assert.equal(value.code, 'pairing-code');
  assert.match(value.verifier, /^[a-f0-9]{64}$/); assert.match(value.state, /^[a-f0-9]{64}$/); assert.notEqual(value.verifier, value.state);
  assert.equal(value.access, 'read-only'); assert.equal(value.language, 'en');
  const first = window.location.href;
  document.getElementById('connect').onsubmit({preventDefault() {}});
  assert.equal(window.location.href, first);
});

test('new installs have no server default; saving the language requires no pairing code', () => {
  const {document, result} = formRuntime();
  assert.equal(document.getElementById('server').value, '');
  assert.equal(document.getElementById('access').value, 'read-only');
  document.getElementById('language').value = 'fr';
  document.getElementById('save').onclick();
  assert.deepEqual(result(), {preferences: true, language: 'fr'});
});

test('une connexion en lecture seule bloque les réponses avant le réseau', async () => {
  const {Controller} = require('../src/pkjs/controller');
  let calls = 0;
  const controller = new Controller({client: {access: 'read-only', tool() {calls++;}}, storage: {getItem() {return null;}}, send() {}});
  const error = await new Promise(resolve => controller.reply({route: 'a'}, 'Continue.', resolve));
  assert.equal(error.code, 'capability_denied'); assert.equal(calls, 0);
});

function runtime(options = {}) {
  const events = {}, messages = [], values = new Map();
  const storage = {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
  if (options.language) storage.setItem('t3.preferences', JSON.stringify({language: options.language}));
  if (options.connection) storage.setItem('t3.connection', JSON.stringify(options.connection));
  let pairCalls = 0, reads = 0;
  function Client(config) {this.url = config.url;}
  Client.prototype.pair = function (config, cb) {pairCalls++; options.pair(config, cb);};
  Client.prototype.tool = function (name, args, cb) {assert.equal(name, 't3_environment_read'); reads++; cb(null, {});};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/pkjs/index.js'), 'utf8'), {
    require(name) {
      if (name === './client') return {Client};
      if (name === './controller') return {Controller: function () {}};
      if (name === './config-page') return '';
      return require('../src/pkjs/' + name.slice(2));
    },
    Pebble: {addEventListener(name, cb) {events[name] = cb;}, sendAppMessage(message, ack) {messages.push(message);ack();}},
    localStorage: storage, setTimeout
  });
  return {events, messages, storage, counts: () => ({pairCalls, reads}), submit(config) {events.webviewclosed({response: encodeURIComponent(JSON.stringify(config))});}};
}
const connection = {url: 'https://t3.example', token: 'saved-secret', access: 'full-access'};
const pairing = {url: connection.url, access: connection.access, code: 'one-time', verifier: 'a'.repeat(64), state: 'b'.repeat(64)};

test('un appairage réussi demande à la montre d’ouvrir directement ses threads', () => {
  const app = runtime({pair(config, cb) {cb(null, connection);}});
  app.submit(pairing);
  assert.equal(app.counts().pairCalls, 1);
  assert.equal(JSON.parse(app.storage.getItem('t3.connection')).token, connection.token);
  assert.equal(app.messages.at(-1).Kind, 7);
});

test('un événement de réglages envoyé deux fois ne consomme pas deux fois le code', () => {
  let complete;
  const app = runtime({pair(config, cb) {complete = cb;}});
  app.submit(pairing); app.submit(pairing);
  assert.equal(app.counts().pairCalls, 1);
  complete(null, connection);
  assert.equal(app.messages.filter(message => message.Kind === 7).length, 1);
});

test('un code déjà utilisé reprend la connexion existante après vérification en lecture', () => {
  const error = Object.assign(new Error('Code déjà utilisé.'), {code: 'pairing_code'});
  const app = runtime({connection, pair(config, cb) {cb(error);}});
  app.submit(pairing);
  assert.equal(app.counts().reads, 1);
  assert.equal(JSON.parse(app.storage.getItem('t3.connection')).token, connection.token);
  assert.equal(app.messages.at(-1).Kind, 7);
});

test('reprendre une connexion enregistrée ne nécessite pas de nouveau code', () => {
  const app = runtime({connection});
  app.submit({resume: true});
  assert.deepEqual(app.counts(), {pairCalls: 0, reads: 1});
  assert.equal(app.messages.at(-1).Kind, 7);
});

test('un changement de droits refusé ne reprend pas silencieusement les anciens droits', () => {
  const app = runtime({connection: {...connection, access: 'read-only'}, pair(config, cb) {cb(Object.assign(new Error('Code déjà utilisé.'), {code: 'pairing_code'}));}});
  app.submit(pairing);
  assert.equal(app.counts().reads, 0);
  assert.equal(app.messages.at(-1).Kind, 4);
});

test('les lignes Bluetooth obsolètes sont retirées de la file sans perdre le paquet déjà en vol', () => {
  const events = {}, messages = [], acks = [];
  function Controller(options) {this.send = options.send;}
  Controller.prototype.handle = function (input) {
    for (let i = 0; i < 3; i++) this.send({Kind: 2, Request: input.Request, Index: i});
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/pkjs/index.js'), 'utf8'), {
    require(name) {
      if (name === './controller') return {Controller};
      if (name === './client') return {Client: function () {}};
      if (name === './config-page') return '';
      return require('../src/pkjs/' + name.slice(2));
    },
    localStorage: {getItem: () => JSON.stringify({url: 'https://t3.example', token: 'test-token'})},
    Pebble: {addEventListener(name, cb) {events[name] = cb;}, sendAppMessage(message, ack) {messages.push(message);acks.push(ack);}},
    setTimeout
  });
  events.ready(); acks.shift()(); // Ready notice.
  events.appmessage({payload: {Command: 1, Request: 1}});
  events.appmessage({payload: {Command: 1, Request: 2}});
  while (acks.length) acks.shift()();
  assert.deepEqual(messages.filter(m => m.Kind === 2).map(m => [m.Request, m.Index]), [[1, 0], [2, 0], [2, 1], [2, 2]]);
});


test('English is the default; changing language preserves the connection and never pairs again', () => {
  const app = runtime({connection});
  app.events.ready();
  assert.equal(app.messages[0].Language, 'en');
  assert.equal(app.messages[0].Text, 'Ready');
  app.submit({preferences: true, language: 'fr'});
  assert.equal(app.messages.at(-1).Language, 'fr');
  assert.equal(app.messages.at(-1).Kind, 7);
  assert.equal(JSON.parse(app.storage.getItem('t3.connection')).token, connection.token);
  assert.equal(JSON.parse(app.storage.getItem('t3.preferences')).language, 'fr');
  assert.equal(app.counts().pairCalls, 0);
});

test('language persists across startup and forgetting a connection', () => {
  const app = runtime({connection, language: 'fr'});
  app.events.ready();
  assert.equal(app.messages[0].Text, 'Prêt');
  app.submit({disconnect: true});
  assert.equal(app.storage.getItem('t3.connection'), null);
  assert.equal(JSON.parse(app.storage.getItem('t3.preferences')).language, 'fr');
});

test('unknown languages fall back to English without losing the saved connection', () => {
  const app = runtime({connection, language: 'unknown'});
  app.events.ready();
  assert.equal(app.messages[0].Language, 'en');
  assert.equal(JSON.parse(app.storage.getItem('t3.connection')).token, connection.token);
});
