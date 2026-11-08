'use strict';
require('../src/pkjs/i18n').set('fr');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Controller} = require('../src/pkjs/controller');
const text = require('../src/pkjs/text');
function storage() {const values = new Map(); return {getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k)};}
function setup(tool) {const sent = []; const store = storage(); const controller = new Controller({client: {url: 'https://t3.example', tool}, storage: store, send: value => sent.push(value)});return {controller, sent, store};}
const row = {route: 'route', environmentId: 'laptop', threadId: 'thread', label: 'Laptop', title: 'Connexion', status: 'completed'};
function invoke(c, method, ...args) {return new Promise((resolve, reject) => c[method](...args, (e, v) => e ? reject(e) : resolve(v)));}

test('les threads de plusieurs machines sont réunis et ceux en attente arrivent en premier', () => {
  const seen = [];
  const {controller: c, sent} = setup((name, args, cb) => {
    seen.push([name, args]);
    if (name === 't3_environment_read') return cb(null, {environmentId: 'home', label: 'Serveur'});
    if (name === 't3_environment_links') return cb(null, {links: [{environmentId: 'laptop', label: 'Laptop', status: 'reachable'}, {environmentId: 'off', label: 'Éteint', status: 'unreachable'}]});
    cb(null, {threads: [{threadId: 'id', title: args.environmentId, status: args.environmentId === 'laptop' ? 'waiting' : 'running', updatedAt: '2026-11-06'}], nextCursor: null});
  });
  c.handle({Command: 1, Request: 1, Action: 1, Category: 1});
  assert.equal(sent[0].Count, 2); assert.match(sent[0].Notice, /Éteint hors ligne/);
  assert.equal(sent[1].Title, 'laptop'); assert.equal(sent[2].Title, 'home');
  assert.equal(seen.filter(([n]) => n === 't3_thread_list').length, 2);
  assert.notEqual(sent[1].Route, sent[2].Route);
});

test('lecture entière paginée, continuation des textes tronqués et ouverture de la dernière réponse agent', async () => {
  const seen = [];
  const {controller: c} = setup((name, args, cb) => {
    seen.push(args);
    if (args.itemId) return cb(null, {items: [{text: ' suite.', textTruncated: false}]});
    assert.ok(args.afterPosition === undefined || (Number.isInteger(args.afterPosition) && args.afterPosition >= 0));
    if (args.afterPosition === undefined) return cb(null, {thread: {status: 'completed'}, items: [{itemId: 'u', position: 0, createdBy: 'user', text: 'Ma question.'}], hasMore: true, nextPosition: 0});
    cb(null, {thread: {status: 'completed'}, items: [{itemId: 'a', position: 1, createdBy: 'agent', text: 'Ma réponse', textTruncated: true, nextTextOffset: 10}], hasMore: false, nextPosition: null});
  });
  const response = await invoke(c, 'read', row, -1, false);
  assert.equal(response[0].Text, 'Ma réponse suite.'); assert.equal(response[0].Offset, 1);
  assert.equal(response[0].Total, 2); assert.equal(seen[2].textOffset, 10);
  assert.equal(seen[0].environmentId, 'laptop');
  assert.ok(!Object.hasOwn(seen[0], 'afterPosition'));
  assert.equal(c.documents[row.route].pages[0].text, 'Ma question.');
});

test('le contrôle des nouveautés accepte un thread vide et un premier message à la position zéro', () => {
  for (const position of [-1, 0]) {
    const {controller: c, sent} = setup((name, args, cb) => {
      assert.equal(name, 't3_thread_read');
      assert.ok(!Object.hasOwn(args, 'afterPosition'));
      cb(null, {thread: {status: 'completed'}, items: [{itemId: 'a', createdBy: 'agent', position: 0, text: 'Prêt.'}]});
    });
    c.routes[row.route] = row;
    c.documents[row.route] = {lastPosition: position, items: [], status: 'running'};
    c.poll({Route: row.route, Request: 3});
    assert.equal(sent[0].Text, 'Nouveau message');
  }
});

test('un historique sans avancement est refusé au lieu de boucler', async () => {
  const {controller: c} = setup((n, a, cb) => cb(null, {thread: {status: 'running'}, items: [], hasMore: true, nextPosition: -1}));
  await assert.rejects(invoke(c, 'read', row, -1, false), /incomplet/);
});

test('une réponse perdue utilise la même clé après redémarrage du compagnon', async () => {
  const keys = []; let first = true;
  function tool(name, args, cb) {keys.push(args.clientRequestId); if (first) {first = false; return cb(new Error('timeout'));} cb(null, {delivery: 'started'});}
  const {controller: c, store} = setup(tool);
  await assert.rejects(invoke(c, 'reply', row, 'Continue.'), /non confirmé/);
  const restarted = new Controller({client: {url: 'https://t3.example', tool}, storage: store, send() {}});
  await invoke(restarted, 'reply', row, 'Continue.');
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]); assert.equal(store.getItem('t3.pending'), null);
});

test('un envoi incertain empêche de réutiliser sa clé pour une autre réponse ou un autre serveur', async () => {
  const {controller: c} = setup((n, a, cb) => cb(new Error('offline')));
  await assert.rejects(invoke(c, 'reply', row, 'Continue.'));
  await assert.rejects(invoke(c, 'reply', row, 'Autre réponse'), /reste à confirmer/);
  c.client.url = 'https://other.example';
  await assert.rejects(invoke(c, 'reply', row, 'Continue.'), /reste à confirmer/);
});

test('un refus explicite permet de corriger les droits et envoyer une autre réponse', async () => {
  const error = Object.assign(new Error('Droits insuffisants'), {code: 'capability_denied'});
  const {controller: c, store} = setup((n, a, cb) => cb(error));
  await assert.rejects(invoke(c, 'reply', row, 'Continue.'), /Droits/);
  assert.equal(store.getItem('t3.pending'), null);
});

test('une réponse obsolète est ignorée après navigation vers un autre écran', () => {
  let old;
  const {controller: c, sent} = setup((n, a, cb) => {old = cb;});
  c.handle({Command: 1, Request: 1, Action: 1});
  c.handle({Command: 2, Request: 2, Route: 'missing'});
  old(new Error('old failure'));
  assert.equal(sent.length, 1); assert.equal(sent[0].Request, 2);
});

test('accents et emoji sont découpés sans perte et sous la limite Bluetooth', () => {
  const source = 'Été à côté 🪨. '.repeat(300);
  const parts = text.chunks(source, 1100);
  assert.equal(parts.join(''), source.trim());
  for (const part of parts) {assert.ok(text.bytes(part) <= 1100); assert.doesNotThrow(() => encodeURIComponent(part));}
  assert.equal(text.readable('## Résultat\n**Prêt** et [lien](https://example.org).'), 'Résultat\nPrêt et lien.');
});

test('snapshot complet, quatre catégories exclusives et titres longs', () => {
  const calls = [];
  const threads = [
    {threadId: 'done', status: 'completed'}, {threadId: 'wait', status: 'waiting'},
    {threadId: 'run', status: 'running'}, {threadId: 'snooze', status: 'running', snoozed: true},
    {threadId: 'old', status: 'completed', settled: true},
    {threadId: 'both', status: 'completed', settled: true, snoozed: true}
  ].map(t => ({title: 'Un titre avec des accents à lire sur deux lignes '.repeat(4), updatedAt: '2026-11-07', ...t}));
  const {controller: c, sent} = setup((name, args, cb) => {
    if (name === 't3_environment_read') return cb(null, {environmentId: 'home', label: 'Serveur'});
    if (name === 't3_environment_links') return cb(null, {links: [{environmentId: 'laptop', label: 'Laptop', status: 'reachable'}]});
    calls.push(args);
    // Behave like the server: filter BEFORE slicing a page.
    const matches = threads.filter(t => (args.settled === undefined || !!t.settled === args.settled) &&
      (args.snoozed === undefined || !!t.snoozed === args.snoozed) && (!args.statuses || args.statuses.includes(t.status)));
    cb(null, {threads: matches.slice(args.cursor, args.cursor + 1), nextCursor: args.cursor + 1 < matches.length ? args.cursor + 1 : null});
  });
  let request = 0;
  for (const [category, expected] of [[0, ['done']], [1, ['run', 'wait']], [2, ['snooze']], [3, ['old', 'both']]]) {
    sent.length = 0;
    c.handle({Command: 1, Request: ++request, Category: category, Action: 1});
    const first = sent.filter(v => v.Kind === 2);
    assert.equal(first.length, expected.length * 2);
    assert.ok(text.bytes(first[0].Title) > 92);
    sent.length = 0;
    c.handle({Command: 1, Request: ++request, Category: category, Offset: 2});
    assert.deepEqual([...new Set(c.rows.map(r => r.threadId))].sort(), expected.sort());
    assert.ok(c.rows.every(r => r.environmentId === 'home' || r.environmentId === 'laptop'));
  }
  assert.ok(calls.some(a => a.cursor === 1));
  assert.ok(calls.every(a => a.settled === undefined && a.statuses === undefined));
});

test('settle et snooze visent le thread sélectionné sur le portable puis actualisent la liste', async () => {
  for (const [action, expected] of [[1, 'settle'], [2, 'snooze'], [3, 'snooze'], [4, 'snooze'], [5, 'unsettle'], [6, 'unsnooze']]) {
    let args;
    const {controller: c} = setup((name, input, cb) => {assert.equal(name, 't3_thread_organize');args = input;cb(null, {});});
    let refreshed = false;
    c.list = (offset, refresh, cb) => {assert.equal(offset, 0);assert.equal(refresh, true);refreshed = true;cb(null, []);};
    const before = Date.now();
    await invoke(c, 'organize', row, action);
    assert.equal(args.environmentId, 'laptop'); assert.equal(args.threadId, 'thread'); assert.equal(args.action, expected);
    assert.ok(refreshed);
    if (action === 2 || action === 3) assert.ok(Math.abs(Date.parse(args.snoozedUntil) - before - (action === 2 ? 1 : 3) * 3600000) < 1000);
    if (action === 4) {const date = new Date(args.snoozedUntil);assert.equal(date.getHours(), 9);assert.equal(date.getMinutes(), 0);assert.ok(date > new Date());}
  }
});

test('les droits de lecture seule et les refus T3 empêchent toute mutation ou faux succès', async () => {
  const {controller: c} = setup(() => assert.fail('no network'));
  c.client.access = 'read-only';
  await assert.rejects(invoke(c, 'organize', row, 1), /lecture seule/);
  c.client.access = 'full-access';
  await assert.rejects(invoke(c, 'organize', row, 99), /inconnue/);
  c.client.tool = (n, a, cb) => cb(new Error('Laptop indisponible'));
  c.list = () => assert.fail('no fake success');
  await assert.rejects(invoke(c, 'organize', row, 1), /indisponible/);
});

function directory(threads, extra = {}) {
  const calls = [];
  const result = setup((name, args, cb) => {
    calls.push([name, args]);
    if (name === 't3_environment_read') return cb(null, {environmentId: 'home', label: 'Serveur'});
    if (name === 't3_environment_links') return cb(null, {links: extra.links || []});
    if (extra.tool) return extra.tool(name, args, cb);
    assert.equal(name, 't3_thread_list');
    const source = threads.filter(t => (t.environmentId || 'home') === args.environmentId);
    const cursor = args.cursor || 0, size = extra.size || 4;
    cb(null, {threads: source.slice(cursor, cursor + size), nextCursor: cursor + size < source.length ? cursor + size : null});
  });
  return {...result, calls};
}
function thread(id, props) {return {threadId: String(id), title: 'Thread ' + id, updatedAt: String(10000 - Number(id)), status: 'completed', ...props};}
function list(c, request, options = {}) {c.handle({Command: 1, Request: request, Category: 0, ...options});}

test('une suite utilise le même snapshot trié, sans doublon ni déplacement des pages déjà lues', () => {
  const threads = Array.from({length: 17}, (_, i) => thread(i));
  const {controller: c, sent, calls} = directory(threads, {size: 3});
  list(c, 1, {Action: 1});
  const revision = c.revision, before = sent.filter(v => v.Kind === 2).map(v => v.Route), network = calls.length;
  // Remote metadata changes cannot change offsets until a global refresh.
  threads[2].status = 'running'; threads.unshift(thread(99));
  sent.length = 0;
  list(c, 2, {Action: 2, Offset: 6, Revision: revision});
  assert.equal(calls.length, network);
  const next = sent.filter(v => v.Kind === 2).map(v => v.Route);
  assert.equal(new Set([...before, ...next]).size, 12);
  assert.equal(sent[0].Offset, 6); assert.equal(sent[0].Total, 17); assert.equal(sent[0].HasMore, 1);
  sent.length = 0; list(c, 3, {Action: 2, Offset: 12, Revision: revision});
  assert.equal(sent[0].Count, 5); assert.equal(sent[0].HasMore, 0);
});

test('rafraîchir tous les threads retire les disparus, met à jour titres et catégories, et retrouve la sélection', () => {
  const threads = Array.from({length: 15}, (_, i) => thread(i));
  const {controller: c, sent} = directory(threads);
  list(c, 1, {Action: 1});
  const selected = c.rows.find(r => r.threadId === '8').route;
  const oldRevision = c.revision;
  threads.splice(1, 1); threads.find(t => t.threadId === '2').settled = true;
  threads.find(t => t.threadId === '3').status = 'running';
  threads.find(t => t.threadId === '8').title = 'Titre corrigé';
  threads.push(thread(40, {snoozed: true}));
  c.documents.old = {text: 'obsolete'};
  sent.length = 0;
  list(c, 2, {Action: 1, Offset: 6, Limit: 9, Route: selected, Index: 2});
  assert.notEqual(c.revision, oldRevision);
  assert.equal(sent[1 + sent[0].Index].Route, selected);
  assert.equal(sent[1 + sent[0].Index].Title, 'Titre corrigé');
  assert.equal(Object.keys(c.documents).length, 0);
  assert.ok(!c.rows.some(r => ['1', '2', '3', '40'].includes(r.threadId)));
  sent.length = 0; list(c, 3, {Category: 1}); assert.equal(sent[1].Title, 'Thread 3');
  sent.length = 0; list(c, 4, {Category: 2}); assert.equal(sent[1].Title, 'Thread 40');
  sent.length = 0; list(c, 5, {Category: 3}); assert.equal(sent[1].Title, 'Thread 2');
  // A page calculated against the old list is never appended to the new one.
  sent.length = 0; list(c, 6, {Action: 2, Offset: 6, Revision: oldRevision});
  assert.deepEqual(sent, [{Kind: 8, Request: 6}]);
});

test('un refresh annulé par la navigation ne publie ni snapshot partiel ni réponse tardive', () => {
  let deferred;
  const {controller: c, sent} = directory([thread(1)]);
  list(c, 1, {Action: 1}); const previous = c.snapshot, revision = c.revision;
  const original = c.client.tool;
  c.client.tool = (n, a, cb) => n === 't3_thread_list' ? deferred = cb : original(n, a, cb);
  sent.length = 0; list(c, 2, {Action: 1});
  list(c, 3, {Category: 1}); // Cached snapshot is still browsable during refresh.
  deferred(null, {threads: [thread(999)], nextCursor: null});
  assert.equal(c.snapshot, previous); assert.equal(c.revision, revision);
  assert.ok(sent.every(v => v.Request === 3));
});

test('machine déconnectée pendant le refresh : conserver ses anciennes lignes marquées hors ligne', () => {
  const threads = [thread(1), thread(2, {environmentId: 'laptop'})];
  const {controller: c, sent} = directory(threads, {links: [{environmentId: 'laptop', label: 'Laptop', status: 'reachable'}]});
  list(c, 1, {Action: 1});
  const original = c.client.tool;
  c.client.tool = (n, a, cb) => n === 't3_thread_list' && a.environmentId === 'laptop' ? cb(new Error('offline')) : original(n, a, cb);
  threads[0].title = 'Local corrigé'; sent.length = 0;
  list(c, 2, {Action: 1});
  assert.equal(sent[0].Count, 2); assert.match(sent[0].Notice, /Laptop hors ligne/);
  assert.ok(sent.some(v => /Hors ligne/.test(v.Subtitle)));
  assert.ok(sent.some(v => v.Title === 'Local corrigé'));
});

test('curseurs bloqués et erreurs fatales conservent le snapshot précédent et ne bouclent pas', () => {
  const {controller: c, sent} = directory([thread(1)]);
  list(c, 1, {Action: 1}); const previous = c.snapshot;
  const original = c.client.tool;
  c.client.tool = (n, a, cb) => n === 't3_thread_list' ? cb(null, {threads: [thread(2)], nextCursor: a.cursor}) : original(n, a, cb);
  sent.length = 0; list(c, 2, {Action: 1});
  assert.equal(sent[0].Kind, 4); assert.match(sent[0].Text, /sans avancement/); assert.equal(c.snapshot, previous);
  c.client.tool = (n, a, cb) => n === 't3_thread_list' ? cb(Object.assign(new Error('Reconnecte T3'), {code: 'auth'})) : original(n, a, cb);
  sent.length = 0; list(c, 3, {Action: 1}); assert.equal(sent[0].Kind, 4); assert.equal(c.snapshot, previous);
});

test('l’actualisation périodique met à jour le cache sans transférer ni déplacer la liste avant la pause', () => {
  const threads = [thread(1, {latestRunId: 'run-1'})];
  const {controller: c, sent} = directory(threads);
  list(c, 1, {Action: 1}); const oldRevision = c.revision;
  threads[0].title = 'Titre actualisé'; sent.length = 0;
  list(c, 2, {Action: 4});
  assert.deepEqual(sent, [{Kind: 9, Request: 2}]);
  assert.notEqual(c.revision, oldRevision);
  sent.length = 0;
  list(c, 3, {Action: 0, Route: c.snapshot[0].route});
  assert.equal(sent[1].Title, 'Titre actualisé');
});

function readingSetup(status = 'completed') {
  const {controller: c, sent, store} = setup((name, args, cb) => {
    assert.equal(name, 't3_thread_read');
    cb(null, {thread: {status, latestRunId: 'run-1', itemCount: 2}, items: [
      {itemId: 'user', position: 0, createdBy: 'user', text: 'Une question'},
      {itemId: 'agent', position: 1, createdBy: 'agent', text: 'Une réponse'}
    ], hasMore: false});
  });
  c.routes.route = {...row, latestRunId: 'run-1', itemCount: 2, status};
  c.snapshot = [c.routes.route];
  return {c, sent, store, target: c.routes.route};
}

test('Done signifie non lu sur la montre ; seul l’affichage confirmé devient Terminé et persiste', () => {
  const {c, sent, store, target} = readingSetup();
  assert.ok(c.isUnread(target));
  c.handle({Command: 2, Request: 1, Route: 'route'});
  const page = sent[0];
  assert.equal(page.Notice, 'Done'); assert.ok(c.isUnread(target));
  c.handle({Command: 7, Request: 1, Route: 'route', Message: 'wrong-token'});
  assert.ok(c.isUnread(target));
  c.handle({Command: 7, Request: 1, Route: 'route', Message: page.Message});
  assert.equal(c.isUnread(target), false); assert.equal(c.generation, 1);
  const restarted = new Controller({client: {}, storage: store, send() {}});
  assert.equal(restarted.isUnread(target), false);
  sent.length = 0; c.handle({Command: 2, Request: 2, Route: 'route'});
  assert.equal(sent[0].Notice, 'Terminé');
});

test('un nouveau tour terminé redevient Done, une modification de titre ne le fait pas', () => {
  const {c, sent, target} = readingSetup();
  c.handle({Command: 2, Request: 1, Route: 'route'});
  c.handle({Command: 7, Route: 'route', Message: sent[0].Message});
  target.title = 'Renommé'; target.updatedAt = 'later';
  assert.equal(c.isUnread(target), false);
  target.latestRunId = 'run-2'; target.status = 'running';
  assert.equal(c.isUnread(target), false);
  target.status = 'completed'; assert.equal(c.isUnread(target), true);
});

test('ni l’ancien message ni un tour encore en cours ne marquent sa future réponse comme lue', () => {
  for (const [status, offset] of [['completed', 0], ['running', -1]]) {
    const {c, sent, target} = readingSetup(status);
    c.handle({Command: 2, Request: 1, Route: 'route', Offset: offset});
    c.handle({Command: 7, Route: 'route', Message: sent[0].Message});
    target.status = 'completed';
    assert.ok(c.isUnread(target));
  }
});

test('un accusé d’affichage ancien ne marque pas comme lu un nouveau tour arrivé entre-temps', () => {
  const {c, sent, target} = readingSetup();
  c.handle({Command: 2, Request: 1, Route: 'route'});
  target.latestRunId = 'run-2';
  c.handle({Command: 7, Route: 'route', Message: sent[0].Message});
  assert.ok(c.isUnread(target));
});

test('une réponse périmée gardée en cache ne marque pas comme lu le tour terminé détecté au polling', () => {
  const {c, sent, target} = readingSetup('running');
  c.handle({Command: 2, Request: 1, Route: 'route'});
  c.client.tool = (n, a, cb) => cb(null, {thread: {status: 'completed', latestRunId: 'run-1'}, items: []});
  c.poll({Route: 'route', Request: 1});
  assert.ok(c.documents.route.stale);
  assert.equal(sent.at(-1).Text, 'Done');
  sent.length = 0; c.handle({Command: 2, Request: 2, Route: 'route'});
  c.handle({Command: 7, Route: 'route', Message: sent[0].Message});
  target.status = 'completed'; assert.ok(c.isUnread(target));
});

test('marquer non lu persiste localement, garde le thread sélectionné et ignore un accusé tardif', async () => {
  const {c, sent, store, target} = readingSetup();
  c.handle({Command: 2, Request: 1, Route: 'route'});
  c.handle({Command: 7, Route: 'route', Message: sent[0].Message});
  assert.equal(c.isUnread(target), false);
  sent.length = 0; c.handle({Command: 2, Request: 2, Route: 'route'});
  const late = sent[0].Message;
  c.client.tool = () => assert.fail('mark unread must stay local');
  const result = await invoke(c, 'organize', target, 7);
  assert.equal(result[1].Route, 'route'); assert.match(result[1].Subtitle, /Done/);
  assert.equal(result[0].Index, 0);
  c.handle({Command: 7, Route: 'route', Message: late});
  assert.ok(c.isUnread(target));
  const restarted = new Controller({client: {}, storage: store, send() {}});
  assert.ok(restarted.isUnread(target));
});

test('marquer non lu reste disponible en lecture seule sans changer les droits T3', async () => {
  const {c, target} = readingSetup();
  c.client.access = 'read-only'; c.client.tool = () => assert.fail('no network mutation');
  c.readState.route = {runId: 'run-1', itemCount: 2};
  assert.equal(c.isUnread(target), false);
  const result = await invoke(c, 'organize', target, 7);
  assert.equal(result[0].Action, 1); assert.match(result[1].Subtitle, /Done/);
});
