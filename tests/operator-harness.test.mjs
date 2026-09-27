import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsoleController } from '../plugins/fleet/scripts/lib/console-controller.mjs';
import { operatorHelpScrollLimit } from '../plugins/fleet/scripts/lib/console-overlay.mjs';

const lane = (id, extra = {}) => ({id,label:id,status:'running',threadId:`thread-${id}`,turnId:`turn-${id}`,authority:{sandbox:'read-only',network:'off',process:{start:true,stopOwned:true}}, ...extra});
const snapshot = (lanes = [lane('one'),lane('two')]) => ({workspace:{name:'test',branch:'main'},lanes});
const deferred = () => {let resolve,reject;const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle = () => new Promise(resolve=>setImmediate(resolve));
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
function controller(t, options = {}) {
  const screens = [];
  const c = createConsoleController({snapshot:snapshot(),terminal:{columns:100,rows:24},preferences:{color:false},write:text=>screens.push(text),...options});
  t.after(()=>c.dispose());
  return {c,screens};
}
async function command(c, text) {
  await c.dispatch({type:'palette'});
  await c.dispatch({type:'text',value:text});
  await c.dispatch({type:'applyFilter'});
}

test('snapshot deadlines do not permit overlapping reads and late success recovers', async t => {
  const read = deferred(); let calls = 0;
  const {c} = controller(t,{refreshTimeoutMs:5,readSnapshot:()=>{calls++;return read.promise;}});
  await c.dispatch({type:'tick'}); await delay(25);
  assert.equal(c.state().observation,'stale');
  assert.equal(c.state().refreshInFlight,true);
  for(let i=0;i<20;i++)await c.dispatch({type:'tick'});
  assert.equal(calls,1);
  read.resolve(snapshot([lane('late-success')])); await settle();
  assert.equal(c.state().observation,'fresh');
  assert.equal(c.state().selectedLaneId,'late-success');
  assert.equal(c.state().refreshInFlight,false);
});

test('scope churn has at most one unresolved read per scope and never applies another scope', async t => {
  const reads = new Map(); const counts = new Map();
  const {c} = controller(t,{readSnapshot:({scope})=>{
    counts.set(scope,(counts.get(scope)??0)+1);const d=deferred();reads.set(scope,d);return d.promise;
  }});
  await c.dispatch({type:'tick'});
  for(let i=0;i<10;i++)await c.dispatch({type:'scope'});
  assert.equal(c.state().scope,'projects');
  assert.deepEqual([...counts.values()],[1,1,1]);
  reads.get('workspace').resolve(snapshot([lane('wrong-workspace')])); await settle();
  assert.equal(c.state().selectedLaneId,null);
  reads.get('projects').resolve(snapshot([lane('correct-project')])); await settle();
  assert.notEqual(c.state().selectedLaneId,'wrong-workspace');
  assert.equal(c.state().observation,'fresh');
});

test('corrupt and failed reads stay stale rather than proving an empty fleet', async t => {
  for(const readSnapshot of [()=>null,()=>({}),()=>Promise.reject(new Error('offline'))]) {
    const {c}=controller(t,{readSnapshot});
    await c.dispatch({type:'tick'}); await settle();
    assert.equal(c.state().observation,'stale');
    assert.equal(c.state().selectedLaneId,'one');
  }
});

test('dispose requests cancellation and ignores late completions and timers', async t => {
  const read=deferred(); let signal;
  const {c,screens}=controller(t,{refreshTimeoutMs:5,readSnapshot:args=>{signal=args.signal;return read.promise;}});
  await c.dispatch({type:'tick'}); c.dispose();
  const before=screens.length; assert.equal(signal.aborted,true);
  read.resolve(snapshot([lane('after-disposal')])); await delay(20); await settle();
  assert.equal(screens.length,before);
});

test('scope change clears filters and shows loading before inventory arrives', async t => {
  const read=deferred();
  const {c}=controller(t,{readSnapshot:()=>read.promise});
  await c.dispatch({type:'filter'});await c.dispatch({type:'text',value:'one'});await c.dispatch({type:'applyFilter'});
  await c.dispatch({type:'scope'});
  assert.equal(c.state().filterQuery,'');assert.equal(c.state().observation,'loading');
  assert.equal(c.state().selectedLaneId,null);assert.equal(c.state().groupMode,'project');
});

test('named grouping is selectable without cycling shortcuts or starting a turn', async t => {
  let turns=0;
  const {c}=controller(t,{runtime:{message:()=>turns++,followUp:()=>turns++,cancel:()=>turns++}});
  await command(c,'Group by Checkout');
  assert.equal(c.state().groupMode,'checkout');assert.equal(c.state().overlay,null);
  assert.equal(turns,0);
});

test('help is a scrollable inert overlay and End/Up returns immediately', async t => {
  const {c}=controller(t,{terminal:{columns:44,rows:12}});
  await c.dispatch({type:'help'});
  assert.equal(c.state().overlay.kind,'help');
  await c.dispatch({type:'end'});
  const end=c.state().overlay.index;assert.ok(end>0);
  assert.equal(end,operatorHelpScrollLimit({scope:'workspace'},{columns:44,rows:12}));
  await c.dispatch({type:'move',delta:-1});assert.equal(c.state().overlay.index,end-1);
  await c.dispatch({type:'activate'});assert.equal(c.state().session,null);
  await c.dispatch({type:'quit'});assert.equal(c.state().overlay,null);assert.equal(c.state().exitRequested,false);
});

test('read-only session is read-only while loading, and Esc returns to the dashboard', async t => {
  const read=deferred();let mutations=0;
  const {c}=controller(t,{snapshot:snapshot([lane('native',{status:'observed',controlAvailable:false})]),runtime:{session:()=>read.promise,cancel:()=>mutations++,message:()=>mutations++}});
  await c.dispatch({type:'activate'});
  assert.equal(c.state().session.observationOnly,true);assert.equal(c.state().composer,null);
  await c.dispatch({type:'quit'});
  assert.equal(c.state().session,null);assert.equal(c.state().exitRequested,false);
  await c.dispatch({type:'cancel'});assert.equal(c.state().confirmation,null);
  assert.equal(mutations,0);
});

test('native scope cannot acquire write controls from malformed row or session flags', async t => {
  const read=deferred();let mutations=0;
  const {c}=controller(t,{snapshot:snapshot([lane('native')]),savedViewState:{current:{scope:'native',groupMode:'flat'},savedViews:[]},runtime:{session:()=>read.promise,cancel:()=>mutations++,message:()=>mutations++}});
  await c.dispatch({type:'activate'});assert.equal(c.state().composer,null);
  read.resolve({observationOnly:false,messages:[]});await settle();
  assert.equal(c.state().session.observationOnly,true);
  await c.dispatch({type:'closeSession'});await c.dispatch({type:'cancel'});
  assert.equal(c.state().confirmation,null);assert.equal(mutations,0);
});

test('mouse hit testing does not select invisible, detail, footer, or right-click rows', async t => {
  const {c}=controller(t);
  for(const event of [{column:90,row:8,button:0},{column:3,row:24,button:0},{column:3,row:8,button:2}]) {
    await c.dispatch({type:'mouseDown',...event});assert.equal(c.state().selectedLaneId,'one');
  }
  await c.dispatch({type:'mouseDown',column:3,row:8,button:0});assert.equal(c.state().selectedLaneId,'two');
  await c.dispatch({type:'cancel'});assert.ok(c.state().confirmation);
  await c.dispatch({type:'mouseDown',column:3,row:6,button:0});assert.equal(c.state().confirmation,null);
  await c.dispatch({type:'resize',columns:72,rows:24});
  await c.dispatch({type:'mouseDown',column:3,row:8,button:0});assert.equal(c.state().selectedLaneId,'one');
});

test('minimum height capacity matches the single visible body row', async t => {
  const {c,screens}=controller(t,{terminal:{columns:80,rows:8}});
  await c.render();assert.equal(c.state().visibleLaneCapacity,1);
  assert.match(screens.at(-1).split('\n').at(-1),/Ctrl\+G/);
});
