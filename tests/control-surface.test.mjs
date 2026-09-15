import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { runControlBenchmark } from "../scripts/check-control-performance.mjs";
import { describeControl } from "../plugins/fleet/scripts/lib/control-contract.mjs";
import { chooseFrontier } from "../plugins/fleet/scripts/lib/frontier-planner.mjs";

test("all machine control operations expose structural schemas, not opaque admission objects", () => {
  const index=describeControl();
  for(const operation of ["describe","observe","result","models","wait","start","continue","cancel.preview","cancel.apply","checkpoint","attest","check","prepare","apply"]) assert.ok(JSON.stringify(index).includes(operation));
  assert.match(JSON.stringify(describeControl("start")),/verificationCheckpoint/);
  assert.match(JSON.stringify(describeControl("prepare")),/verificationReserveTokens/);
});
test("portable control guidance and client ship without an extra production dependency", async () => {
  const skill=await fs.readFile("plugins/fleet/skills/control/SKILL.md","utf8"), codex=await fs.readFile(".agents/skills/fleet-control/SKILL.md","utf8");
  for(const term of ["control describe","checkpoint","attest","reconcile","requestId","readSection"]) assert.ok(skill.includes(term)||codex.includes(term),term);
  assert.match(skill,/Never invent confirmationRef/);
  const pkg=JSON.parse(await fs.readFile("package.json","utf8"));assert.equal(Object.keys(pkg.dependencies??{}).length,0);
  for(const name of ["control-client","control-result","evidence-ledger","frontier-planner"]) assert.ok(pkg.scripts.typecheck.includes(`${name}.mjs`));
  assert.ok(pkg.scripts.verify.includes("check:control-performance"));
});
test("synthetic performance gate measures bounded bytes, not claimed subscription savings", () => {
  const report=runControlBenchmark();assert.equal(report.ok,true,JSON.stringify(report.violations));
  assert.equal(report.observations.length,2);
  assert.match(report.methodology.claim,/no model-token/);
});
test("256 deterministic DAG fixtures obey dependencies, capacity and reserve before any model work", () => {
  let seed=17;const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
  for(let attempt=0;attempt<256;attempt++) {
    const count=4+Math.floor(rnd()*24),capacity=1+Math.floor(rnd()*4),budget=100+Math.floor(rnd()*900);
    const graph=Array.from({length:count},(_,i)=>({id:`n${i}`,estimatedTokens:1+Math.floor(rnd()*200),estimatedMs:1+Math.floor(rnd()*200),dependsOn:i&&rnd()<.6?[{laneId:`n${Math.floor(rnd()*i)}`}]:[]}));
    const lanes=graph.map(n=>({id:n.id,authority:{sandbox:rnd()<.15?"workspace-write":"read-only"}}));
    const selected=chooseFrontier({graph,lanes,snapshot:{queued:[],active:[],history:[],limits:{maxActive:capacity}},budget:{maxEstimatedTokens:budget,verificationReserveTokens:50},now:0});
    assert.ok(selected.selected.length<=capacity);assert.ok(selected.estimatedTokens<=budget-50);
    for(const node of selected.selected) assert.equal(graph.find(n=>n.id===node.id).dependsOn.length,0);
    if(selected.selected.some(n=>lanes.find(l=>l.id===n.id).authority.sandbox==="workspace-write")) assert.equal(selected.selected.length,1);
  }
});


test("portable skill descriptions use quoted scalars with lossless LF and CRLF metadata", async () => {
  // Keep these published descriptions in the JSON-string subset of YAML. This
  // prevents a colon+space in prose from becoming YAML mapping syntax. The
  // pinned host CLI's strict plugin validation remains the full parser gate.
  for (const file of ["plugins/fleet/skills/control/SKILL.md", ".agents/skills/fleet-control/SKILL.md"]) {
    const source = await fs.readFile(file, "utf8");
    for (const newline of ["\n", "\r\n"]) {
      const text = source.replace(/\r?\n/gu, newline);
      const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
      assert.ok(metadata, `${file}: metadata must start at the first line`);
      const lines = metadata.split(/\r?\n/u);
      const descriptions = lines.filter((line) => line.startsWith("description: "));
      assert.equal(descriptions.length, 1, `${file}: one description required`);
      const scalar = descriptions[0].slice("description: ".length);
      assert.ok(scalar.startsWith('"'), `${file}: description must be quoted`);
      const value = JSON.parse(scalar);
      assert.equal(typeof value, "string");
      assert.ok(value.length > 20 && value.length < 1024);
      assert.match(value, /Fleet/u);
      assert.match(lines.find((line) => line.startsWith("name: ")), /^name: [a-z][a-z0-9-]*$/u);
    }
  }
});
