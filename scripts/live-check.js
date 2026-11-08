'use strict';
// Creates a short-lived read-only authorization, exercises the real client, then revokes it.
const {execFileSync} = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const assert = require('node:assert/strict');
const {Client} = require('../src/pkjs/client');
const {Controller} = require('../src/pkjs/controller');
const binary = process.env.T3_BINARY;
if (!binary) throw new Error('Set T3_BINARY to the running server’s executable.');
const baseUrl = process.env.T3_URL || 'http://127.0.0.1:22722';
const label = 'T3 Pebble verification ' + Date.now();
function cli(...args) {return execFileSync(binary, ['auth', ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});}
function request(options, cb) {
  let done = false;
  const finish = (error, result) => {if (!done) {done = true; cb(error, result);}};
  const req = (options.url.startsWith('https:') ? https : http).request(options.url, {method: options.method || 'POST', headers: options.headers}, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', part => body += part);
    res.on('end', () => finish(null, {status: res.statusCode, type: res.headers['content-type'], session: res.headers['mcp-session-id'], body}));
  });
  req.on('error', error => finish(error)); req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  req.end(options.body);
}
function call(client, name, args = {}) {return new Promise((resolve, reject) => client.tool(name, args, (e, v) => e ? reject(e) : resolve(v)));}
async function main() {
  let pairing;
  try {
    pairing = JSON.parse(cli('pairing', 'create', '--scope', 'orchestration:read', '--ttl', '5m', '--label', label, '--json'));
    assert.ok(pairing.credential);
    const client = new Client({url: baseUrl, request});
    await new Promise((resolve, reject) => client.pair({clientName: label, code: pairing.credential, access: 'read-only', verifier: crypto.randomBytes(32).toString('hex'), state: crypto.randomBytes(32).toString('hex')}, e => e ? reject(e) : resolve()));
    console.log('Appairage OAuth PKCE et session MCP : OK.');
    const here = await call(client, 't3_environment_read');
    const peers = await call(client, 't3_environment_links');
    const values = new Map();
    const controller = new Controller({client, storage: {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)}, send() {}});
    for (const [category, label] of ['Done', 'Working', 'Snoozed', 'Settled'].entries()) {
      controller.category = category;
      const messages = await new Promise((resolve, reject) => controller.list(0, true, (e, v) => e ? reject(e) : resolve(v), controller.generation));
      assert.equal(messages[0].Kind, 1);
      for (const env of [{label: here.label, status: 'reachable'}, ...peers.links]) {
        if (env.status === 'reachable') assert.ok(!messages[0].Notice.includes(env.label + ' offline'), env.label + ': snapshot incomplet');
      }
      console.log('Snapshot : ' + controller.snapshot.length + ' threads.');
      assert.ok(controller.rows.every(row => category === 3 ? row.settled : category === 2 ? !row.settled && row.snoozed : !row.settled && !row.snoozed));
      console.log('Catégorie ' + label + ' sur les machines liées : OK.');
    }
    for (const environment of [{environmentId: here.environmentId, label: here.label, status: 'reachable'}, ...peers.links]) {
      if (environment.status !== 'reachable') continue;
      const result = await call(client, 't3_thread_list', {environmentId: environment.environmentId, allProjects: true, limit: 20, includeSubagents: false});
      console.log('Liste des threads sur ' + environment.label + ' : OK.');
      if (result.threads.length) {
        const thread = result.threads.find(item => item.itemCount > 0 && item.itemCount <= 20) || result.threads[0];
        const row = {environmentId: environment.environmentId, threadId: thread.threadId, route: 'live:' + environment.environmentId, label: environment.label, title: thread.title};
        const pages = await new Promise((resolve, reject) => controller.read(row, -1, true, (error, value) => error ? reject(error) : resolve(value)));
        assert.ok(pages[0].Total > 0);
        assert.equal(typeof pages[0].Text, 'string');
        console.log('Lecture complète par le contrôleur de la montre : OK.');
      }
    }
  } finally {
    const sessions = JSON.parse(cli('session', 'list', '--json'));
    for (const session of sessions.filter(s => s.client && s.client.label === label)) cli('session', 'revoke', session.sessionId);
    if (pairing) cli('pairing', 'revoke', pairing.id);
    console.log('Autorisations de vérification révoquées.');
  }
}
main().catch(error => {console.error('Échec : ' + (error.code || error.name) + '. ' + (error.message || '').replace(/t3_[a-zA-Z0-9._-]+/g, '[redacted]')); process.exitCode = 1;});
