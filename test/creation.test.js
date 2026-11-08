'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Controller} = require('../src/pkjs/controller');
const {command, kind} = require('../src/pkjs/protocol');
const i18n = require('../src/pkjs/i18n');
i18n.set('en');
function storage() {const v = new Map();return {getItem: k => v.get(k) || null, setItem: (k,x) => v.set(k,x), removeItem: k => v.delete(k)};}
function setup(options = {}) {
  const calls = [], sent = [], store = options.store || storage();
  const client = {url: options.url || 'https://t3.example.org', token: options.token || 'test-token', access: options.access || 'full-access', tool(name,args,cb) {
    calls.push({name,args});
    if (options.tool && options.tool(name,args,cb)) return;
    if (name === 't3_environment_read') return cb(null,{environmentId:'server',label:'Server'});
    if (name === 't3_environment_links') return cb(null,{links:[{environmentId:'laptop',label:'Laptop',status:'reachable'},{environmentId:'offline',label:'Offline',status:'unreachable'}]});
    if (name === 't3_project_list') return cb(null,{projects:[{id:'project',title:'Example project'},{id:'old',title:'Archived',archivedAt:'2026-01-01'},{id:'deleted',title:'Deleted',deletedAt:'2026-01-01'}],nextCursor:null});
    if (name === 't3_thread_launch') return cb(null,{threadId:'created-thread',status:'running',link:'https://t3.example.org/thread/created-thread'});
    assert.fail('Unexpected tool '+name);
  }};
  const c = new Controller({client,storage:store,send:m=>sent.push(m)});
  let id=0;
  function handle(payload) {sent.length=0;c.handle({Request:++id,...payload});return sent;}
  function choose() {
    const envs=handle({Command:command.ENVIRONMENTS});
    const token=envs[0].Creation, env=envs.find(m=>m.Title==='Laptop').Route;
    const projects=handle({Command:command.PROJECTS,Route:env});
    return {Command:command.CREATE,Creation:token,Route:projects[1].Route,Message:'Build a small example.'};
  }
  return {c,store,calls,sent,handle,choose};
}

test('creation lists reachable machines and active projects without exposing paths', () => {
  const s=setup();
  const envs=s.handle({Command:command.ENVIRONMENTS});
  assert.equal(envs[0].Kind,kind.CHOICES);assert.equal(envs[0].Count,2);
  assert.equal(envs[0].Creation.length,32);
  const projects=s.handle({Command:command.PROJECTS,Route:envs[2].Route});
  assert.equal(projects[0].Count,1);assert.equal(projects[1].Title,'Example project');
  assert.equal(s.calls.at(-1).args.environmentId,'laptop');
  assert.ok(!JSON.stringify(projects).includes('workspaceRoot'));
});

test('project pagination is complete, deduplicated, stable and bounded on the watch', () => {
  const all=Array.from({length:15},(_,i)=>({id:String(i),title:'Project '+String(i).padStart(2,'0')}));
  const s=setup({tool(name,args,cb){if(name!=='t3_project_list')return false;cb(null,{projects:all.slice(args.cursor,args.cursor+4),nextCursor:args.cursor+4<all.length?args.cursor+4:null});return true;}});
  const env=s.handle({Command:command.ENVIRONMENTS})[1].Route;
  const first=s.handle({Command:command.PROJECTS,Route:env});assert.equal(first[0].Count,6);assert.equal(first[0].Total,15);
  const token=first[0].Creation, calls=s.calls.length;
  const second=s.handle({Command:command.PROJECTS,Route:env,Offset:6});
  assert.equal(s.calls.length,calls);assert.equal(second[0].Creation,token);assert.equal(second[1].Title,'Project 06');
  assert.equal(s.handle({Command:command.PROJECTS,Route:env,Offset:12})[0].Count,3);
});

test('read-only connections cannot discover creation choices or start an agent', () => {
  const s=setup({access:'read-only'});
  for(const Command of [command.ENVIRONMENTS,command.PROJECTS,command.CREATE]) {
    const messages=s.handle({Command,Message:'Example',Creation:'token'});assert.equal(messages[0].Kind,kind.ERROR);assert.match(messages[0].Text,/Read-only/);
  }
  assert.equal(s.calls.length,0);
});

test('confirmation launches on the chosen machine and project with server defaults', () => {
  const s=setup();const input=s.choose();
  assert.equal(s.calls.filter(c=>c.name==='t3_thread_launch').length,0);
  const result=s.handle(input)[0];assert.equal(result.Kind,kind.CREATED);
  const args=s.calls.at(-1).args;
  assert.equal(args.environmentId,'laptop');assert.equal(args.projectId,'project');assert.equal(args.message,input.Message);
  assert.ok(!('modelSelection' in args));assert.ok(!('runtimeMode' in args));assert.ok(!('workspaceStrategy' in args));
  assert.equal(s.c.routes[result.Route].threadId,'created-thread');
  assert.equal(s.c.snapshot,null);
});

test('an uncertain launch persists and reuses its request ID after a companion restart', () => {
  const s=setup({tool(name,args,cb){if(name!=='t3_thread_launch')return false;cb(new Error('lost reply'));return true;}});
  const input=s.choose();s.handle(input);
  const original=s.calls.at(-1).args.clientRequestId;
  const restarted=setup({store:s.store});
  const draft=restarted.handle({Command:command.ENVIRONMENTS})[0];
  assert.equal(draft.Kind,kind.CREATION_DRAFT);assert.equal(draft.Text,input.Message);assert.equal(draft.Creation,input.Creation);
  restarted.handle(input);assert.equal(restarted.calls.at(-1).args.clientRequestId,original);
});

test('completed creation survives a lost Bluetooth response; late duplicates never create again', () => {
  const s=setup();const input=s.choose();const created=s.handle(input)[0];
  const restart=setup({store:s.store});const resumed=restart.handle({Command:command.ENVIRONMENTS})[0];
  assert.equal(resumed.Kind,kind.CREATED);assert.equal(resumed.Route,created.Route);assert.equal(restart.calls.length,0);
  restart.handle({Command:command.CREATE_ACK,Creation:input.Creation});
  assert.ok(!('message' in JSON.parse(s.store.getItem('t3.creation'))));
  restart.handle(input);assert.equal(restart.calls.length,0);
  restart.choose(); // A fresh user intent may now start another flow.
  restart.handle(input);assert.equal(restart.calls.filter(c=>c.name==='t3_thread_launch').length,0);
});

test('double presses share one in-flight launch and changing its payload is rejected', () => {
  let complete;
  const s=setup({tool(name,args,cb){if(name!=='t3_thread_launch')return false;complete=cb;return true;}});
  const input=s.choose();s.handle(input);s.handle(input);
  s.handle({...input,Message:'Different request'});assert.equal(s.sent[0].Kind,kind.ERROR);
  assert.equal(s.calls.filter(c=>c.name==='t3_thread_launch').length,1);
  complete(null,{threadId:'one-thread',status:'running'});
  assert.equal(JSON.parse(s.store.getItem('t3.creation')).threadId,'one-thread');
});

test('switching credentials never replays an uncertain launch in another auth namespace', () => {
  const s=setup({tool(name,args,cb){if(name!=='t3_thread_launch')return false;cb(new Error('timeout'));return true;}});
  const input=s.choose();s.handle(input);
  const other=setup({store:s.store,token:'different-token'});
  assert.equal(other.handle({Command:command.ENVIRONMENTS})[0].Kind,kind.ERROR);
  other.handle(input);assert.equal(other.calls.length,0);
});

test('a late response after navigation is saved but never replaces the current screen', () => {
  let complete;
  const s=setup({tool(name,args,cb){if(name!=='t3_thread_launch')return false;complete=cb;return true;}});
  const input=s.choose();s.handle(input);s.handle({Command:command.READ,Route:'missing'});s.sent.length=0;
  complete(null,{threadId:'late-thread',status:'running'});
  assert.equal(s.sent.length,0);assert.equal(JSON.parse(s.store.getItem('t3.creation')).threadId,'late-thread');
});

test('forgetting a connection prevents a late launch response from restoring its receipt', () => {
  let complete;
  const s=setup({tool(name,args,cb){if(name!=='t3_thread_launch')return false;complete=cb;return true;}});
  s.handle(s.choose());s.c.creation.detached=true;s.c.generation++;s.store.removeItem('t3.creation');
  complete(null,{threadId:'late-thread',status:'running'});assert.equal(s.store.getItem('t3.creation'),null);
});

test('stalled project cursors and invalid offsets fail without looping or launching', () => {
  const s=setup({tool(name,args,cb){if(name!=='t3_project_list')return false;cb(null,{projects:[],nextCursor:args.cursor});return true;}});
  const env=s.handle({Command:command.ENVIRONMENTS})[1].Route;
  assert.equal(s.handle({Command:command.PROJECTS,Route:env})[0].Kind,kind.ERROR);
  assert.equal(s.handle({Command:command.ENVIRONMENTS,Offset:-1})[0].Kind,kind.ERROR);
  assert.equal(s.calls.filter(c=>c.name==='t3_project_list').length,1);
});

test('a creation cannot reach T3 when its retry ID cannot be persisted first', () => {
  const store=storage();store.setItem=()=>{throw new Error('storage full');};
  const s=setup({store});const input=s.choose();
  assert.equal(s.handle(input)[0].Kind,kind.ERROR);
  assert.equal(s.calls.filter(c=>c.name==='t3_thread_launch').length,0);
});

test('an explicit T3 refusal is preserved and does not block a fresh creation intent', () => {
  const s=setup({tool(name,args,cb){if(name!=='t3_thread_launch')return false;cb(Object.assign(new Error('Permission refused'),{code:'capability_denied'}));return true;}});
  const input=s.choose();s.handle(input);
  assert.equal(s.sent[0].Text,'Permission refused');assert.equal(s.store.getItem('t3.creation'),null);
  assert.notEqual(s.choose().Creation,input.Creation);
});

test('opening the created thread acknowledges its receipt in the same Bluetooth request', () => {
  const s=setup();const input=s.choose();const created=s.handle(input)[0];
  s.c.read=(row,offset,refresh,cb)=>cb(null,[{Kind:kind.READ,Text:'Hello'}]);
  s.handle({Command:command.READ,Route:created.Route,Creation:input.Creation});
  assert.equal(s.sent[0].Kind,kind.READ);
  assert.equal(JSON.parse(s.store.getItem('t3.creation')).acknowledged,true);
  assert.equal(s.handle({Command:command.ENVIRONMENTS})[0].Kind,kind.CHOICES);
});
