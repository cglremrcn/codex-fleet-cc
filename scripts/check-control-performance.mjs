import { performance } from "node:perf_hooks";
import { createObservationFeed, createObservationAssembler } from "../plugins/fleet/scripts/lib/control-observation.mjs";
import { describeControl } from "../plugins/fleet/scripts/lib/control-contract.mjs";
import { chooseFrontier } from "../plugins/fleet/scripts/lib/frontier-planner.mjs";
import { isMainModule } from "../plugins/fleet/scripts/lib/is-main.mjs";
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const p95 = values => [...values].sort((a,b) => a-b)[Math.max(0,Math.ceil(values.length * .95)-1)];
function fixture(count) {
  return { schemaVersion: 1, lanes: Array.from({ length: count }, (_, i) => ({ id: `worker-${String(i).padStart(3,"0")}`, status: i % 2 ? "complete" : "running", phase: "fixture",
    role: "investigator", model: "fixture-model", effort: "high", admissionId: `admission-${i}`, turnId: `turn-${i}`, executionRevision: 0,
    workPerformed: ["Synthetic retained work evidence. ".repeat(50)], verificationResults: [{ check: "fixture", status: "passed" }],
    artifactRefs: ["evidence/fixture.txt"], tokenUsage: { input: 1000, output: 100 }, updatedAt: "2026-09-15T00:00:00.000Z" })) };
}
function collect(feed, snapshot, params, previous) {
  let page = feed.observe(snapshot, params), wireBytes = 0, pages = 0;
  const assembler = createObservationAssembler(previous);
  for (;;) {
    wireBytes += bytes(page); pages++;
    const state = assembler.accept(page);
    if (state) return { state, wireBytes, pages };
    page = feed.observe(null, { nextPage: page.nextPage });
  }
}
export function runControlBenchmark() {
  const observations = [100,256].map(count => {
    const snapshot = fixture(count), feed = createObservationFeed({workspaceKey:"0123456789abcdef0123456789abcdef"});
    const first = collect(feed,snapshot,{maxBytes:8192});
    const unchanged = collect(feed,snapshot,{cursor:first.state.cursor},first.state);
    const changed = structuredClone(snapshot);
    for(let i=0;i<5;i++) changed.lanes[i].phase = "changed evidence";
    const delta = collect(feed,changed,{cursor:first.state.cursor},first.state);
    const samples=[];
    for(let i=0;i<110;i++) {
      const begin=performance.now(); collect(feed,changed,{cursor:delta.state.cursor},delta.state);
      if(i>=10) samples.push(performance.now()-begin);
    }
    const record = {lanes:count,fullSnapshotBytes:bytes(snapshot),initialProjectionBytes:first.wireBytes,
      initialPages:first.pages,unchangedBytes:unchanged.wireBytes,fiveChangesBytes:delta.wireBytes,
      unchangedReductionVsFullPercent: Math.round((1-unchanged.wireBytes/bytes(snapshot))*10000)/100,
      unchangedP95Ms:p95(samples),retainedBytes:feed.stats().retainedBytes};
    feed.dispose(); return record;
  });
  const graph=[{id:"short-a",estimatedTokens:100,estimatedMs:1},{id:"short-b",estimatedTokens:100,estimatedMs:1},
    {id:"critical-root",estimatedTokens:100,estimatedMs:10},{id:"critical-child",estimatedTokens:100,estimatedMs:100,dependsOn:[{laneId:"critical-root"}]}];
  const params={graph,lanes:graph.map(n=>({id:n.id,authority:{sandbox:"read-only"}})),snapshot:{queued:[],active:[],history:[],limits:{maxActive:2}},budget:{maxEstimatedTokens:1000,verificationReserveTokens:200},now:0};
  const critical=chooseFrontier(params), fifo=chooseFrontier({...params,strategy:"fifo"});
  const violations=[];
  for(const record of observations) {
    if(record.unchangedBytes>1024) violations.push(`unchanged-response-${record.lanes}`);
    if(record.fiveChangesBytes>=record.initialProjectionBytes) violations.push(`delta-not-smaller-${record.lanes}`);
    if(record.retainedBytes>2*1024*1024) violations.push(`retained-memory-${record.lanes}`);
    if(record.unchangedP95Ms>1000) violations.push(`local-observation-latency-${record.lanes}`);
  }
  return {schemaVersion:1,kind:"synthetic-control-plane-benchmark",node:process.version,platform:process.platform,arch:process.arch,
    ok:violations.length===0,violations,observations,discoveryIndexBytes:bytes(describeControl()),
    frontierFixture:{criticalPath:critical.selected.map(n=>n.id),fifo:fifo.selected.map(n=>n.id),estimatedBudgetReserved:critical.verificationReserveTokens},
    methodology:{warmup:10,samples:100,transport:"in-process JSON payload, no CLI startup or network",baseline:"full retained synthetic snapshot, not a token-billing baseline",
      claim:"bytes and local latency only; no model-token, subscription-quota, dollar, task-quality or global ranking claim",
      planner:"one constructed ordering example, not an optimality or universal makespan proof"}};
}
if(isMainModule(import.meta.url)) {
  const report=runControlBenchmark(); process.stdout.write(`${JSON.stringify(report)}\n`); process.exitCode=report.ok?0:1;
}
