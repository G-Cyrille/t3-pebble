'use strict';
require('../src/pkjs/i18n').set('fr');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {Client, origin, json, base64url} = require('../src/pkjs/client');
function reply(result, extra = {}) {return {status: 200, type: 'application/json', body: JSON.stringify({jsonrpc: '2.0', id: 1, result}), ...extra};}
function call(client, name = 't3_thread_list', args = {}) {return new Promise((resolve, reject) => client.tool(name, args, (e, value) => e ? reject(e) : resolve(value)));}

test('connexion directe uniquement en HTTPS ou à travers le VPN, sans identifiants dans l’URL', () => {
  for (const url of ['https://t3.example.org', 'http://100.100.100.100:7777', 'http://127.0.0.1:22722']) assert.equal(origin(url + '/'), url);
  for (const url of ['http://example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org?token=a', 'http://100.128.0.1', 'https://a:65536', 'javascript:alert(1)']) assert.throws(() => origin(url));
});

test('appairage OAuth PKCE complet par code, sans redirection ni service hébergé', async () => {
  const config = {code: 'one-time-secret', access: 'read-only', verifier: crypto.randomBytes(32).toString('hex'), state: crypto.randomBytes(32).toString('hex')};
  const seen = [];
  const client = new Client({url: 'http://127.0.0.1:22722', request(options, cb) {
    seen.push(options); const path = new URL(options.url).pathname;
    if (path.endsWith('/register')) return cb(null, {status: 201, body: JSON.stringify({client_id: 'signed-client'})});
    if (path.endsWith('/decision')) {
      const body = JSON.parse(options.body);
      assert.equal(body.authorization.code_challenge, crypto.createHash('sha256').update(config.verifier).digest('base64url'));
      assert.deepEqual(body.decision, {_tag: 'pairing-code', code: config.code, access: 'read-only'});
      return cb(null, {status: 200, body: JSON.stringify({redirectTo: 'http://127.0.0.1/t3-pebble?code=auth-code&state=' + config.state + '&iss=http%3A%2F%2F127.0.0.1%3A22722'})});
    }
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('code_verifier'), config.verifier); assert.equal(form.get('code'), 'auth-code');
    cb(null, {status: 200, body: JSON.stringify({access_token: 'bearer', token_type: 'Bearer', expires_in: 600})});
  }});
  const connection = await new Promise((resolve, reject) => client.pair(config, (e, value) => e ? reject(e) : resolve(value)));
  assert.equal(connection.token, 'bearer'); assert.equal(connection.access, 'read-only'); assert.equal(seen.length, 3);
  assert.equal(JSON.parse(seen[0].body).software_id, 't3-pebble');
});

test('une réponse OAuth avec un autre état ne fournit pas de jeton', async () => {
  let count = 0;
  const client = new Client({url: 'https://t3.example', request(options, cb) {count++; cb(null, {status: 200, body: JSON.stringify(count === 1 ? {client_id: 'id'} : {redirectTo: 'http://127.0.0.1/t3-pebble?code=x&state=wrong&iss=https%3A%2F%2Ft3.example'})});}});
  await assert.rejects(new Promise((resolve, reject) => client.pair({code: 'x', access: 'read-only', verifier: 'a'.repeat(64), state: 'b'.repeat(64)}, (e, v) => e ? reject(e) : resolve(v))), /non confirmée/);
  assert.equal(count, 2);
});

test('le client MCP initialise sa session, transmet la machine et accepte JSON et SSE', async () => {
  const methods = [];
  const client = new Client({url: 'https://t3.example', token: 'secret', request(options, cb) {
    assert.equal(options.headers.Authorization, 'Bearer secret');
    const body = JSON.parse(options.body); methods.push(body.method);
    if (body.method === 'initialize') return cb(null, reply({protocolVersion: '2025-06-18'}, {session: 'session'}));
    assert.equal(options.headers['Mcp-Session-Id'], 'session');
    if (body.method === 'notifications/initialized') return cb(null, {status: 202});
    assert.equal(body.params.arguments.environmentId, 'laptop');
    cb(null, {status: 200, type: 'text/event-stream', body: 'event: message\ndata: ' + JSON.stringify({jsonrpc: '2.0', id: body.id, result: {content: [{type: 'text', text: '{"threads":[]}'}]}}) + '\n\n'});
  }});
  assert.deepEqual(await call(client, 't3_thread_list', {environmentId: 'laptop'}), {threads: []});
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call']);
});

test('session MCP perdue renouvelée une seule fois, même clé d’envoi', async () => {
  let attempts = 0, opens = 0;
  const keys = [];
  const client = new Client({url: 'https://t3.example', token: 'secret', request(options, cb) {
    const b = JSON.parse(options.body);
    if (b.method === 'initialize') return cb(null, reply({}, {session: 'session' + ++opens}));
    if (b.method === 'notifications/initialized') return cb(null, {status: 202});
    keys.push(b.params.arguments.clientRequestId);
    if (++attempts === 1) return cb(null, {status: 404});
    cb(null, reply({structuredContent: {delivery: 'started'}}));
  }});
  await call(client, 't3_thread_send', {clientRequestId: 'same'});
  assert.deepEqual(keys, ['same', 'same']); assert.equal(opens, 2);
});

test('autorisation expirée explique comment se reconnecter et n’est pas retentée', async () => {
  let requests = 0;
  const client = new Client({url: 'https://t3.example', token: 'expired', request(o, cb) {requests++; cb(null, {status: 401});}});
  await assert.rejects(call(client), /expirée/); assert.equal(requests, 1);
});

test('un refus de droits reste identifiable sans afficher le contenu du serveur', async () => {
  const client = new Client({url: 'https://t3.example', token: 'x', request(o, cb) {cb(null, reply({isError: true, content: [{type: 'text', text: JSON.stringify({code: 'capability_denied', message: 'private detail'})}]}));}});
  client.session = 'ready';
  await assert.rejects(call(client), e => e.code === 'capability_denied' && !e.message.includes('private detail'));
});

test('SSE multiligne et base64url sans padding', () => {
  assert.equal(json({type: 'text/event-stream', body: 'data: {"id":1,\ndata: "result":42}\n\n'}).result, 42);
  for (let size = 1; size <= 5; size++) {const data = crypto.randomBytes(size); assert.equal(base64url([...data]), data.toString('base64url'));}
});

test('un code d’appairage expiré ou déjà utilisé produit un message précis', async () => {
  const client = new Client({url: 'https://t3.example', request(o, cb) {cb(null, {status: 400, body: JSON.stringify({message: 'That pairing code is unknown, expired, or already used.'})});}});
  await assert.rejects(new Promise((resolve, reject) => client.http('/oauth/mcp/decision', {}, null, (error, value) => error ? reject(error) : resolve(value))), error => error.code === 'pairing_code' && /expiré ou déjà utilisé/.test(error.message));
});

test('un refus de paramètres JSON-RPC ne prétend pas que la version T3 est incompatible', async () => {
  const client = new Client({url: 'https://t3.example', token: 'secret', request(options, cb) {cb(null, {status: 200, body: JSON.stringify({jsonrpc: '2.0', id: 1, error: {code: -32602, message: 'private request validation details'}})});}});
  client.session = 'session';
  await assert.rejects(call(client, 't3_thread_read', {}), error => error.code === 'invalid_request' && /paramètres/.test(error.message) && !/private/.test(error.message));
});
