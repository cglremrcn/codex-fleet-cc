import assert from 'node:assert/strict';
import test from 'node:test';
import { buildViewModel, renderScreen, displayWidth, stripAnsi } from '../plugins/fleet/scripts/lib/tui-render.mjs';
import { VIEW_LABELS, GROUP_LABELS, operatorFooter, emptyViewLines, operatorHelpLines } from '../plugins/fleet/scripts/lib/operator-guide.mjs';
import { paletteItems, renderOperatorOverlay, operatorHelpScrollLimit } from '../plugins/fleet/scripts/lib/console-overlay.mjs';
import { deriveKiteSignal, renderKiteAvatar, kiteIsAnimated } from '../plugins/fleet/scripts/lib/kite-companion.mjs';

const lane = (overrides = {}) => ({ id: 'agent-1', label: 'Inspect the current checkout', status: 'running', ...overrides });
const snapshot = (overrides = {}) => ({ workspace: { name: 'project', branch: 'main' }, lanes: [lane()], ...overrides });
const terminalCases = [[32, 8], [44, 12], [72, 24], [80, 8], [100, 28], [160, 28]];

function bounded(screen, columns, rows) {
  const lines = stripAnsi(screen).split('\n');
  assert.ok(lines.length <= rows, `${lines.length} rows exceeds ${rows}`);
  assert.ok(lines.every(line => displayWidth(line) <= columns), `overflow at ${columns} columns`);
  return lines;
}

for (const scope of Object.keys(VIEW_LABELS)) {
  test(`visible view/group and return control: ${scope}, 162 layout/state combinations`, () => {
    for (const groupMode of Object.keys(GROUP_LABELS)) {
      for (const [columns, rows] of terminalCases) {
        for (const observation of ['fresh', 'loading', 'stale']) {
          const view = buildViewModel(snapshot({ scope, groupMode }), 'agent-1', 'detail', { observation });
          const lines = bounded(renderScreen(view, { columns, rows }, { color: false }), columns, rows);
          const text = lines.join('\n');
          assert.match(text, /(?:\[W\]|W:)/, `view missing: ${scope}/${groupMode}/${columns}/${observation}`);
          assert.match(text, /(?:\[G\]|G:)/, `group missing: ${scope}/${groupMode}/${columns}/${observation}`);
          assert.match(lines.at(-1), /Ctrl\+G/, 'return key clipped');
          if (scope === 'native') assert.doesNotMatch(lines.at(-1), /Cancel|Open agent/);
        }
      }
    }
  });
}

test('queued work is not executing; intervention counts are not inferred from the mascot', () => {
  const view = buildViewModel(snapshot({ lanes: [lane({status:'queued'}), lane({id:'b',status:'starting'}), lane({id:'c',status:'running'})] }), 'agent-1');
  assert.equal(view.totals.active, 2);
  assert.equal(view.totals.queued, 1);
  const text = renderScreen(view, {columns:100,rows:24}, {color:false});
  assert.match(text, /02 LIVE/);
  assert.match(text, /01 QUEUED/);
});

test('empty states distinguish filter, missing observation, partial and different scopes', () => {
  assert.match(emptyViewLines({filterQuery:'hidden'}).join(' '), /No matching agents.*Other agents/);
  assert.match(emptyViewLines({observation:'loading'}).join(' '), /Loading.*No empty-fleet conclusion/);
  assert.match(emptyViewLines({observation:'stale'}).join(' '), /not proof.*empty/);
  assert.match(emptyViewLines({truncated:true}).join(' '), /partial view/);
  assert.match(emptyViewLines({scope:'native'}).join(' '), /read-only/);
  assert.match(emptyViewLines({scope:'projects'}).join(' '), /registered/);
  for (const scope of Object.keys(VIEW_LABELS)) {
    const view = buildViewModel(snapshot({scope,lanes:[],filterQuery:'hidden'}));
    assert.match(renderScreen(view, {columns:72,rows:24},{color:false}), /No matching agents/);
  }
});

test('native rows are visibly read-only before long identifiers and models', () => {
  const view = buildViewModel(snapshot({scope:'native',lanes:[lane({status:'observed', id:'x'.repeat(200), model:'y'.repeat(200)})]}));
  assert.equal(view.selectedLane.controlAvailable, false);
  assert.match(renderScreen(view,{columns:100,rows:24},{color:false}), /READ ONLY/);
  assert.doesNotMatch(operatorFooter(view,160), /Cancel|Open agent/);
});

test('guide and palette give named alternatives for every supported group and view', () => {
  for (const mode of Object.keys(GROUP_LABELS)) assert.ok(paletteItems('').some(item => item.id === `group:${mode}`));
  for (const scope of Object.keys(VIEW_LABELS)) assert.ok(paletteItems('').some(item => item.id === `scope:${scope}`));
  assert.equal(paletteItems('Group by Checkout')[0].id,'group:checkout');
  const help = operatorHelpLines().join('\n');
  assert.match(help,/W = WHERE/); assert.match(help,/G = HOW/);
  assert.match(help,/j\/k/); assert.match(help,/K opens/);
  assert.match(help,/worker claim, not VERIFIED/);
  for (const [columns,rows] of terminalCases) {
    for (const index of [0,999]) {
      const lines = bounded(renderOperatorOverlay({kind:'help',index},{columns,rows},{view:{scope:'native'}}),columns,rows);
      assert.match(lines.at(-1),/Esc: Close/);
    }
    assert.ok(Number.isInteger(operatorHelpScrollLimit({}, {columns,rows})));
  }
});

test('KITE never reports a globally idle fleet from an empty or filtered view', () => {
  const idle = deriveKiteSignal({lanes:[]});
  assert.doesNotMatch(idle.description,/Nothing is secretly running/);
  assert.match(idle.description,/other|filtered/i);
  assert.equal(deriveKiteSignal({lanes:[],filterQuery:'not-here'}).state,'filtered');
  assert.equal(deriveKiteSignal({lanes:[],observation:'loading'}).state,'loading');
  assert.equal(deriveKiteSignal({lanes:[],observation:'stale'}).state,'stale');
});

test('unselected fleet posture prioritizes unknown effects and typed requests over activity', () => {
  assert.equal(deriveKiteSignal({lanes:[lane(),lane({status:'outcome_unknown'})]}).state,'outcome_unknown');
  const approval = deriveKiteSignal({lanes:[lane({pendingApprovalCount:2}),lane({pendingQuestionCount:1})]});
  assert.equal(approval.state,'approval');
  assert.equal(approval.totals.requests,3);
  assert.equal(deriveKiteSignal({lanes:[lane({pendingRequests:2,pendingApprovalCount:2})]}).totals.requests,2);
});

test('KITE all postures remain 27x7 with safe ASCII, deterministic reduced motion and no model calls', () => {
  for (const status of ['idle','observed','queued','starting','running','complete','verified','question','approval','attention','blocked','failed','cancelled','interrupted','outcome_unknown','stale','loading','filtered']) {
    const signal = {state:status,animated:['running','complete','starting','queued'].includes(status)};
    for (const unicode of [true,false]) {
      for (const frame of [0,1,6]) {
        const lines = renderKiteAvatar(signal,{unicode,frame});
        assert.equal(lines.length,7);
        assert.ok(lines.every(line => displayWidth(line) === 27), status);
        if (!unicode) assert.doesNotMatch(lines.join(''), /[^\x20-\x7e]/);
      }
      assert.deepEqual(renderKiteAvatar(signal,{unicode,frame:0,reducedMotion:true}),renderKiteAvatar(signal,{unicode,frame:6,reducedMotion:true}));
    }
    assert.equal(kiteIsAnimated(signal,{screenReader:true}),false);
    assert.deepEqual(renderKiteAvatar(signal,{screenReader:true}),[]);
  }
});

test('screen-reader session mode exposes the transcript rather than unrelated dashboard rows', () => {
  const view = buildViewModel(snapshot(), 'agent-1');
  const text = renderScreen(view,{columns:100,rows:24},{screenReader:true,color:true,session:{laneId:'agent-1',threadId:'thread-1',messages:[{kind:'assistant',text:'Actual retained transcript.'}]},composer:{value:''}});
  assert.match(text,/Actual retained transcript/);
  assert.doesNotMatch(text,/\u001b\[|KITE|Lane 1 of/);
});

test('owned active work keeps cancel discoverable while group and observed rows cannot suggest it', () => {
  for (const columns of [72,100,160]) assert.match(operatorFooter({selectedLane:lane()},columns),/X: Cancel/);
  assert.doesNotMatch(operatorFooter({selectedLane:lane({status:'complete'})},160),/Cancel/);
  assert.doesNotMatch(operatorFooter({selectedGroup:{id:'heading'}},160),/Cancel/);
  assert.doesNotMatch(operatorFooter({selectedLane:lane({controlAvailable:false})},160),/Cancel/);
});


test('tiny sessions keep return controls and observation-only mode visible', () => {
  for (const scope of ['workspace','native']) for (const columns of [32,72,100,160]) {
    const view=buildViewModel(snapshot({scope}), 'agent-1');
    const text=renderScreen(view,{columns,rows:8},{color:false,session:{laneId:'agent-1',messages:[{kind:'assistant',text:'Retained result.'}]}});
    const lines=bounded(text,columns,8);
    assert.match(lines.at(-1),/Ctrl\+G/);
    if(scope==='native') {assert.match(text,/OBSERVE ONLY/);assert.doesNotMatch(lines.at(-1),/Send/);}
  }
});

test('running lanes needing approval remain visible in the attention counter', () => {
  const view=buildViewModel(snapshot({lanes:[lane({pendingApprovalCount:1}),lane({id:'question',pendingQuestionCount:2}),lane({id:'done',status:'verified'})]}));
  assert.equal(view.totals.attention,2);
});
