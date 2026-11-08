'use strict';
// Local T3 double used with the actual Time 2 emulator. No live agents or credentials.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let origin, authorization, sent = 0;
const received = new Map(), launches = new Map();
let failLaunchOnce = false, launchDelay = 0;
const threads = [
  {environmentId: 'laptop', threadId: 'page', title: 'Improve the welcome page for new users', status: 'completed'},
  {environmentId: 'home', threadId: 'login', title: 'Fix sign-in and keep the session on Android', status: 'waiting'},
  {environmentId: 'home', threadId: 'tests', title: 'Check workflow tests and transitions between steps', status: 'running'},
  {environmentId: 'home', threadId: 'later', title: 'Continue the invitation update tomorrow', status: 'completed', snoozed: true},
  {environmentId: 'home', threadId: 'old', title: 'Review the website before the meeting', status: 'completed', settled: true}
].map(t => ({updatedAt: '2026-11-07T12:00:00Z', settled: false, snoozed: false, ...t}));
for (let i = 0; i < 85; i++) threads.push({environmentId: i % 3 ? 'home' : 'laptop', threadId: 'many-' + i,
  title: 'Thread ' + String(i).padStart(2, '0') + ': a long title to check scrolling through the list',
  status: 'completed', settled: false, snoozed: false, updatedAt: new Date(Date.UTC(2026, 10, 6, 12, 0, -i)).toISOString()});
threads.forEach(t => {t.latestRunId = 'run:' + t.threadId; t.itemCount = 2;});
let delay = Number(process.env.FIXTURE_DELAY || 0);
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', data => raw += data);
  req.on('end', () => {
    function respond(body, status = 200, headers = {}) {res.writeHead(status, {'Content-Type': 'application/json', ...headers});res.end(JSON.stringify(body));}
    let input;
    try {input = raw ? JSON.parse(raw) : {};} catch (_) {input = Object.fromEntries(new URLSearchParams(raw));}
    if (req.url === '/fixture') {
      if (input.failLaunchOnce !== undefined) failLaunchOnce = !!input.failLaunchOnce;
      if (input.launchDelay !== undefined) launchDelay = Number(input.launchDelay);
      if (input.delay !== undefined) delay = Number(input.delay);
      if (input.title) {threads.find(t => t.threadId === input.threadId).title = input.title;}
      if (input.status) {threads.find(t => t.threadId === input.threadId).status = input.status;}
      if (input.remove) {const i = threads.findIndex(t => t.threadId === input.remove);if (i >= 0) threads.splice(i, 1);}
      return respond({threads: threads.length});
    }
    if (req.url === '/oauth/mcp/register') return respond({client_id: 'fixture-client'}, 201);
    if (req.url === '/oauth/mcp/decision') {
      authorization = input.authorization;
      if (input.decision.code !== 'fixture-pairing') return respond({message: 'invalid'}, 400);
      return respond({redirectTo: 'http://127.0.0.1/t3-pebble?code=fixture-code&state=' + authorization.state + '&iss=' + encodeURIComponent(origin)});
    }
    if (req.url === '/oauth/mcp/token') {
      if (crypto.createHash('sha256').update(input.code_verifier).digest('base64url') !== authorization.code_challenge) return respond({message: 'invalid'}, 400);
      return respond({access_token: 'fixture-bearer', token_type: 'Bearer', expires_in: 3600});
    }
    if (req.url !== '/mcp' || req.headers.authorization !== 'Bearer fixture-bearer') return respond({message: 'unauthorized'}, 401);
    if (input.method === 'initialize') return respond({jsonrpc: '2.0', id: input.id, result: {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: 'fixture', version: '1'}}}, 200, {'Mcp-Session-Id': 'fixture-session'});
    if (input.method === 'notifications/initialized') {res.writeHead(202);return res.end();}
    const args = input.params.arguments, name = input.params.name;
    if (name === 't3_thread_read' && args.afterPosition !== undefined && (!Number.isInteger(args.afterPosition) || args.afterPosition < 0)) {
      return respond({jsonrpc: '2.0', id: input.id, error: {code: -32602, message: 'afterPosition must be a non-negative integer'}});
    }
    let result;
    if (name === 't3_environment_read') result = {environmentId: 'home', label: 'Server'};
    else if (name === 't3_environment_links') result = {links: [{environmentId: 'laptop', label: 'Laptop', status: 'reachable'}, ...(process.env.FIXTURE_OFFLINE ? [{environmentId: 'off', label: 'Desktop', status: 'unreachable'}] : [])]};
    else if (name === 't3_project_list') {
      const projects = Array.from({length: 9}, (_,i) => ({id:'project-'+i,title:i?'Project '+i+' with a long descriptive title':'Example project',deletedAt:null,defaultModelSelection:null}));
      const start=args.cursor||0;result={projects:projects.slice(start,start+4),nextCursor:start+4<projects.length?start+4:null};
    }
    else if (name === 't3_thread_launch') {
      if (!args.clientRequestId || !/^project-/.test(args.projectId) || !args.message) return respond({jsonrpc:'2.0',id:input.id,result:{isError:true,structuredContent:{code:'invalid_request'}}});
      if (!launches.has(args.clientRequestId)) {
        const threadId='created-'+launches.size;
        launches.set(args.clientRequestId,{threadId,status:'running',projectId:args.projectId});
        threads.push({environmentId:args.environmentId,threadId,title:args.title,status:'running',settled:false,snoozed:false,updatedAt:new Date().toISOString(),latestRunId:'new-run',itemCount:2,fixtureMessage:args.message});
        fs.writeFileSync(path.join(__dirname,'../artifacts/fixture-launches.json'),JSON.stringify({count:launches.size,requests:[...launches.keys()],last:args}));
      }
      result=launches.get(args.clientRequestId);
      if (failLaunchOnce) {failLaunchOnce=false;req.socket.destroy();return;}
    }
    else if (name === 't3_thread_list') {
      const matches = threads.filter(t => t.environmentId === args.environmentId &&
        (args.settled === undefined || t.settled === args.settled) && (args.snoozed === undefined || t.snoozed === args.snoozed) &&
        (!args.statuses || args.statuses.includes(t.status)));
      const start = args.cursor || 0, size = Math.min(args.limit || 100, 15);
      result = {threads: matches.slice(start, start + size), nextCursor: start + size < matches.length ? start + size : null};
    }
    else if (name === 't3_thread_organize') {
      const thread = threads.find(t => t.environmentId === args.environmentId && t.threadId === args.threadId);
      if (!thread || !['settle', 'unsettle', 'snooze', 'unsnooze'].includes(args.action) || (args.action === 'snooze' && !args.snoozedUntil))
        return respond({jsonrpc: '2.0', id: input.id, error: {code: -32602, message: 'Invalid organization target'}});
      if (args.action === 'settle' || args.action === 'unsettle') thread.settled = args.action === 'settle';
      else {thread.snoozed = args.action === 'snooze'; thread.snoozedUntil = args.snoozedUntil || null;}
      fs.appendFileSync(path.join(__dirname, '../artifacts/fixture-organize.jsonl'), JSON.stringify(args) + '\n');
      result = {sequence: 1};
    }
    else if (name === 't3_thread_read') {
      const current = threads.find(t => t.threadId === args.threadId && t.environmentId === args.environmentId);
      const items = [
        {itemId: 'u', position: 0, createdBy: 'user', text: current.fixtureMessage || 'Fix sign-in and check the tests.'},
        {itemId: 'a', position: 1, createdBy: 'agent', text: 'Sign-in is fixed.\n\nThe session survives a reload. All tests pass.\n\nReady to publish. Should I continue?'}
      ];
      if (sent) items.push({itemId: 'summary', position: 2, createdBy: 'agent', text: 'Sign-in fixed.\nAll tests pass.\nReady for review.'});
      const cursor = args.afterPosition === undefined ? -1 : args.afterPosition;
      result = {thread: {status: sent ? 'completed' : current.status, latestRunId: current.latestRunId, itemCount: items.length}, items: items.filter(item => item.position > cursor), hasMore: false, nextPosition: null};
    } else if (name === 't3_thread_send') {
      if (!received.has(args.clientRequestId)) {sent++;received.set(args.clientRequestId, args.message);fs.writeFileSync(path.join(__dirname, '../artifacts/fixture-sends.json'), JSON.stringify({sent, messages: [...received.values()]}));}
      result = {delivery: 'started', messageId: 'm1'};
    } else return respond({jsonrpc: '2.0', id: input.id, error: {code: -32601, message: 'unknown'}});
    const output = {jsonrpc: '2.0', id: input.id, result: {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result}};
    if (launchDelay && name === 't3_thread_launch') setTimeout(() => respond(output), launchDelay);
    else if (delay && name === 't3_thread_list') setTimeout(() => respond(output), delay); else respond(output);
  });
});
server.listen(0, '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port;
  fs.mkdirSync(path.join(__dirname, '../artifacts'), {recursive: true});
  fs.writeFileSync(path.join(__dirname, '../artifacts/fixture-config.json'), JSON.stringify({url: origin, code: 'fixture-pairing', access: 'full-access', language: 'en', verifier: crypto.randomBytes(32).toString('hex'), state: crypto.randomBytes(32).toString('hex')}));
  console.log('Fixture T3 prête.');
});
