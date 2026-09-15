import crypto from "node:crypto";
import { ControlError, digest, validateControlOperation } from "./control-contract.mjs";
import { allLanes, isMutableLane } from "./execution-evidence.mjs";
import { validateStartContract } from "./start-contract.mjs";

const AGE_QUANTUM_MS = 60_000;
const PLAN_TTL_MS = 120_000;
const MAX_PLANS = 8;
const MAX_BYTES = 512 * 1024;
const identity = (snapshot, limits) => digest({ limits: snapshot.limits ?? limits,
  lanes: allLanes(snapshot).map((lane) => ({ id: lane.id, admissionId: lane.admissionId ?? null,
    contractDigest: lane.contractDigest ?? null, executionRevision: lane.executionRevision ?? 0,
    threadId: lane.threadId ?? null, turnId: lane.turnId ?? null, status: lane.status,
    archivedAt: lane.archivedAt ?? null, pendingContinuation: lane.pendingContinuation ?? null,
    pendingRequests: lane.pendingRequests ?? 0 })).sort((a, b) => a.id.localeCompare(b.id)),
  reservations: snapshot.continuationReservations ?? [] }, "fleet-plan-observation-v1");

/** Critical-path list scheduling + bounded age tiers. A heuristic, not an optimality claim. */
export function chooseFrontier({ graph, lanes, snapshot, validDependencies = new Set(), budget, strategy = "critical-path", now = Date.now(), limits = {} }) {
  const nodes = new Map(), contracts = new Map(lanes.map((lane) => [lane.id, lane]));
  for (const [order, node] of graph.entries()) {
    if (nodes.has(node.id) || !contracts.has(node.id)) throw new ControlError("PLAN_GRAPH_INVALID", "Graph IDs must be unique and match the candidate contract exactly.");
    if (new Set((node.dependsOn ?? []).map((dep) => dep.laneId)).size !== (node.dependsOn ?? []).length) throw new ControlError("PLAN_GRAPH_INVALID", "Duplicate dependencies are not permitted.");
    nodes.set(node.id, { ...node, order });
  }
  if (nodes.size !== contracts.size) throw new ControlError("PLAN_GRAPH_INVALID", "Every candidate requires one graph node.");
  if (budget.verificationReserveTokens > budget.maxEstimatedTokens) throw new ControlError("PLAN_BUDGET_INVALID", "Verification reserve exceeds the available estimated-token budget.");
  const children = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const node of nodes.values()) for (const dep of node.dependsOn ?? []) {
    if (dep.laneId === node.id || (nodes.has(dep.laneId) && dep.receiptId)) throw new ControlError("PLAN_GRAPH_INVALID", "A candidate cannot depend on itself or claim a prior receipt for another new candidate.");
    if (nodes.has(dep.laneId)) children.get(dep.laneId).push(node.id);
  }
  const visiting = new Set(), ranks = new Map();
  function rank(id) {
    if (visiting.has(id)) throw new ControlError("PLAN_GRAPH_CYCLE", "The dependency graph contains a cycle; no work was admitted.");
    if (ranks.has(id)) return ranks.get(id);
    visiting.add(id);
    const result = nodes.get(id).estimatedMs + Math.max(0, ...children.get(id).map(rank));
    visiting.delete(id); ranks.set(id, result); return result;
  }
  for (const id of nodes.keys()) rank(id);
  const existing = new Set(allLanes(snapshot).map((lane) => lane.id));
  if ([...nodes.keys()].some((id) => existing.has(id))) throw new ControlError("PLAN_ID_REUSED", "Candidate IDs already exist in the retained ledger. Observe their outcome; never resubmit them as new work.");
  const occupied = (snapshot.active ?? []).length + (snapshot.queued ?? []).length + (snapshot.continuationReservations ?? []).length;
  const capacity = Math.max(0, Math.min(snapshot.limits?.maxActive ?? limits.maxActive ?? 3, limits.maxActive ?? 3) - occupied);
  const ready = [], deferred = [];
  for (const node of nodes.values()) {
    const missing = (node.dependsOn ?? []).filter((dep) => nodes.has(dep.laneId) || !validDependencies.has(`${dep.laneId}:${dep.receiptId}`));
    if (missing.length) deferred.push({ id: node.id, reason: "dependency-evidence", dependencies: missing.map((dep) => dep.laneId) });
    else ready.push(node);
  }
  const age = (node) => Math.min(32, Math.floor(Math.max(0, now - (node.waitSince ?? now)) / AGE_QUANTUM_MS));
  ready.sort((a, b) => strategy === "fifo" ? a.order - b.order : age(b) - age(a) || ranks.get(b.id) - ranks.get(a.id) || a.estimatedTokens - b.estimatedTokens || a.order - b.order);
  const selected = []; let remaining = budget.maxEstimatedTokens - budget.verificationReserveTokens, mutable = false;
  const verifierActive = (snapshot.active ?? []).some((lane) => lane.verificationCheckpoint);
  for (const node of ready) {
    const writer = isMutableLane(contracts.get(node.id));
    const reason = selected.length >= capacity ? "capacity" : node.estimatedTokens > remaining ? "estimated-budget"
      : mutable || (writer && (selected.length || occupied || verifierActive)) ? "source-isolation" : null;
    if (reason) { deferred.push({ id: node.id, reason }); continue; }
    selected.push({ id: node.id, estimatedTokens: node.estimatedTokens, criticalPathMs: ranks.get(node.id), ageTier: age(node) });
    remaining -= node.estimatedTokens; mutable ||= writer;
  }
  return { algorithm: strategy === "fifo" ? "fifo-v1" : "evidence-bounded-frontier-v1", selected, deferred, capacity,
    estimatedTokens: selected.reduce((total, node) => total + node.estimatedTokens, 0),
    verificationReserveTokens: budget.verificationReserveTokens, remainingEstimatedTokens: remaining,
    budgetIsEstimate: true, billingOrQuota: false };
}

/** Short-lived, in-memory plans. Replay uses the same promise; restart never re-admits a lost token. */
export function createFrontierPlans({ workspacePath, evidence, snapshot, transaction, admit, now = Date.now }) {
  const plans = new Map(); let disposed = false;
  function prune() {
    for (const [token, plan] of plans) if (plan.expiresAt <= now() && plan.state !== "admitting") plans.delete(token);
  }
  async function dependencies(params, context) {
    const candidates = new Set(params.graph.map((node) => node.id));
    const verified = new Set();
    for (const node of params.graph) for (const dep of node.dependsOn ?? []) {
      if (candidates.has(dep.laneId) || !dep.receiptId || verified.has(`${dep.laneId}:${dep.receiptId}`)) continue;
      const checked = await evidence.verifyReceipt(dep.receiptId, context);
      if (checked.current && checked.laneId === dep.laneId) verified.add(`${dep.laneId}:${dep.receiptId}`);
    }
    return verified;
  }
  return Object.freeze({
    async prepare(params) {
      validateControlOperation("prepare", params); prune();
      if (disposed) throw new ControlError("CONTROL_CLOSED", "Plan service is closed.");
      if (plans.size >= MAX_PLANS) throw new ControlError("PLAN_LIMIT", "Too many retained plans; apply or let a prepared plan expire before preparing more.");
      const contract = validateStartContract(params.contract, { expectedWorkspacePath: workspacePath, deferModelValidation: true });
      // Clone once before awaiting, so in-process callers cannot change a prepared intent.
      const input = structuredClone(params);
      return transaction(async () => {
        const context = await evidence.currentContext(), valid = await dependencies(input, context);
        const frontier = chooseFrontier({ ...input, lanes: contract.lanes, snapshot: context.snapshot, validDependencies: valid, now: now(), limits: contract.limits });
        if (!frontier.selected.length) return { ...frontier, planToken: null, next: "Resolve deferred reasons; no inference was started." };
        const ids = new Set(frontier.selected.map((node) => node.id));
        const wave = { ...input.contract, lanes: input.contract.lanes.filter((lane) => ids.has(lane.id)) };
        // Preserve the chosen order. Original priorities are authority-neutral but may reorder execution;
        // the wave is bounded either way and never admits nodes outside its ready frontier.
        wave.lanes.sort((a, b) => frontier.selected.findIndex((node) => node.id === a.id) - frontier.selected.findIndex((node) => node.id === b.id));
        const effectiveLimits = context.snapshot.limits ?? { maxActive: contract.limits?.maxActive ?? 3,
          maxWritersPerCheckout: 1, staggerMs: contract.limits?.staggerMs ?? 150 };
        const stateDigest = identity(context.snapshot, effectiveLimits);
        if (identity(await snapshot(), effectiveLimits) !== stateDigest) throw new ControlError("PLAN_STALE", "Fleet changed during preparation; observe and prepare again.");
        const record = { state: "prepared", expiresAt: now() + PLAN_TTL_MS, input, wave, frontier, effectiveLimits, stateDigest, sourceDigest: context.source.digest, promise: null };
        const bytes = Buffer.byteLength(JSON.stringify(record));
        if (bytes + [...plans.values()].reduce((sum, plan) => sum + plan.bytes, 0) > MAX_BYTES) throw new ControlError("PLAN_LIMIT", "Prepared context exceeds the bounded plan memory budget.");
        const token = crypto.randomBytes(32).toString("hex"); plans.set(token, { ...record, bytes });
        return { ...frontier, planToken: token, expiresAt: new Date(record.expiresAt).toISOString(), sourceDigest: record.sourceDigest,
          candidateModelsValidated: false, next: "apply", authorityChanged: false };
      });
    },
    apply(params) {
      validateControlOperation("apply", params); prune();
      const plan = plans.get(params.planToken);
      if (disposed || !plan) throw new ControlError("PLAN_UNAVAILABLE", "Plan expired or the supervisor restarted. Observe candidate IDs and reconcile before preparing another plan.", { retry: "reconcile-first" });
      if (plan.promise) return plan.promise;
      plan.state = "admitting";
      // Store before any asynchronous boundary. Concurrent applications join exactly this dispatch.
      plan.promise = (async () => {
        let boundaryCrossed = false;
        try {
          const reserved = await transaction(async () => {
            const recheck = async () => {
              if (disposed) throw new ControlError("CONTROL_CLOSED", "Plan service closed before admission.");
              const context = await evidence.currentContext();
              if (context.source.digest !== plan.sourceDigest || identity(context.snapshot, plan.effectiveLimits) !== plan.stateDigest) throw new ControlError("PLAN_STALE", "Source or Fleet identity changed since preparation. No new admission is authorized by this plan.");
              const valid = await dependencies(plan.input, context);
              const contract = validateStartContract(plan.input.contract, { expectedWorkspacePath: workspacePath, deferModelValidation: true });
              const next = chooseFrontier({ ...plan.input, lanes: contract.lanes, snapshot: context.snapshot, validDependencies: valid, now: now(), limits: contract.limits });
              // Aging may change ordering only after preparation: this is an immutable selected wave.
              if (plan.frontier.selected.some((node) => !next.selected.some((current) => current.id === node.id))) throw new ControlError("PLAN_STALE", "Dependency evidence or ready capacity changed; the selected frontier is no longer eligible.");
            };
            await recheck();
            return admit(plan.wave, async () => { await recheck(); boundaryCrossed = true; });
          });
          const result = await reserved.completion;
          return { schemaVersion: 1, state: "admitted", laneIds: plan.frontier.selected.map((node) => node.id),
            admissionIds: result.admissionIds, replaySafeOnlyForThisLivePlan: true, next: "observe" };
        } catch (error) {
          if (boundaryCrossed) throw new ControlError("PLAN_ADMISSION_UNCERTAIN", "An admission boundary was crossed. Observe every candidate and reconcile; this plan will not start them twice.", { retry: "reconcile-first" });
          throw error;
        } finally { plan.state = "settled"; plan.input = null; plan.wave = null; plan.bytes = 4096; }
      })();
      return plan.promise;
    },
    hasWorkLease() { prune(); return [...plans.values()].some((plan) => plan.state === "prepared" || plan.state === "admitting"); },
    dispose() { disposed = true; plans.clear(); },
    stats() { prune(); return { retained: plans.size, retainedBytes: [...plans.values()].reduce((sum, plan) => sum + plan.bytes, 0) }; }
  });
}
