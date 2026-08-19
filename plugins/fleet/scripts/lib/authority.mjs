const CONFIRMATION_ACTIONS = new Set([
  "filesystem.write",
  "browser.submit",
  "process.stop",
  "database.write",
  "image.generate",
  "image.edit",
  "send.message",
  "payment.execute",
  "deploy.production",
  "delete.resource",
  "retry.operation",
  "authority.escalate"
]);

const SANDBOX_VALUES = new Set(["read-only", "workspace-write"]);
const NETWORK_VALUES = new Set(["off", "live"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function readBoolean(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean.`);
  }
  return value;
}

function normalizeFlags(value, label, keys) {
  if (value === undefined) {
    return Object.fromEntries(keys.map((key) => [key, false]));
  }
  assertObject(value, label);
  return Object.fromEntries(
    keys.map((key) => [key, readBoolean(value[key], false, `${label}.${key}`)])
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
}

function decision(allowed, reason, action) {
  return {
    allowed,
    reason,
    confirmationRequired: allowed && requiresConfirmation(action)
  };
}

export function requiresConfirmation(action) {
  return CONFIRMATION_ACTIONS.has(action);
}

export function requiredAdmissionConfirmationActions(authorityInput) {
  const authority = normalizeAuthority(authorityInput);
  const actions = [];
  if (authority.sandbox === "workspace-write") actions.push("filesystem.write");
  if (authority.browser.mutate) actions.push("browser.submit");
  if (authority.database.write) actions.push("database.write");
  if (authority.image.generate) actions.push("image.generate");
  if (authority.image.edit) actions.push("image.edit");
  const externalActions = {
    send: "send.message",
    payment: "payment.execute",
    deploy: "deploy.production",
    delete: "delete.resource"
  };
  for (const [capability, action] of Object.entries(externalActions)) {
    if (authority.externalEffects[capability]) actions.push(action);
  }
  return Object.freeze(actions);
}

export function normalizeAuthority(input) {
  assertObject(input, "Authority");

  const sandbox = input.sandbox ?? "read-only";
  if (!SANDBOX_VALUES.has(sandbox)) {
    throw new TypeError("Authority sandbox must be read-only or workspace-write.");
  }

  const network = input.network ?? "off";
  if (!NETWORK_VALUES.has(network)) {
    throw new TypeError("Authority network must be off or live.");
  }

  return deepFreeze({
    sandbox,
    network,
    browser: normalizeFlags(input.browser, "Authority browser", ["inspect", "mutate"]),
    process: normalizeFlags(input.process, "Authority process", ["start", "stopOwned"]),
    database: normalizeFlags(input.database, "Authority database", ["read", "write"]),
    image: normalizeFlags(input.image, "Authority image", ["generate", "edit"]),
    externalEffects: normalizeFlags(input.externalEffects, "Authority externalEffects", [
      "send",
      "payment",
      "deploy",
      "delete"
    ]),
    retry: readBoolean(input.retry, false, "Authority retry")
  });
}

export function authorizeAction(authorityInput, action, context = {}) {
  const authority = normalizeAuthority(authorityInput);
  assertObject(context, "Authorization context");

  switch (action) {
    case "filesystem.read":
      return decision(true, "workspace-read-authorized", action);
    case "filesystem.write":
      return authority.sandbox === "workspace-write"
        ? decision(true, "workspace-write-authorized", action)
        : decision(false, "workspace-write-not-authorized", action);
    case "network.live":
      return authority.network === "live"
        ? decision(true, "live-network-authorized", action)
        : decision(false, "live-network-not-authorized", action);
    case "browser.inspect":
      return authority.browser.inspect
        ? decision(true, "browser-inspection-authorized", action)
        : decision(false, "browser-inspection-not-authorized", action);
    case "browser.submit":
      return authority.browser.mutate
        ? decision(true, "browser-mutation-authorized", action)
        : decision(false, "browser-mutation-not-authorized", action);
    case "process.start":
      return authority.process.start
        ? decision(true, "process-start-authorized", action)
        : decision(false, "process-start-not-authorized", action);
    case "process.stop":
      return authority.process.stopOwned && context.owned === true
        ? decision(true, "owned-process-stop-authorized", action)
        : decision(false, "owned-process-stop-not-authorized", action);
    case "database.read":
      return authority.database.read
        ? decision(true, "database-read-authorized", action)
        : decision(false, "database-read-not-authorized", action);
    case "database.write":
      return authority.database.write
        ? decision(true, "database-write-authorized", action)
        : decision(false, "database-write-not-authorized", action);
    case "image.generate":
      return authority.image.generate
        ? decision(true, "image-generation-authorized", action)
        : decision(false, "image-generation-not-authorized", action);
    case "image.edit":
      return authority.image.edit
        ? decision(true, "image-edit-authorized", action)
        : decision(false, "image-edit-not-authorized", action);
    case "send.message":
      return authority.externalEffects.send
        ? decision(true, "message-send-authorized", action)
        : decision(false, "message-send-not-authorized", action);
    case "payment.execute":
      return authority.externalEffects.payment
        ? decision(true, "payment-authorized", action)
        : decision(false, "payment-not-authorized", action);
    case "deploy.production":
      return authority.externalEffects.deploy
        ? decision(true, "production-deploy-authorized", action)
        : decision(false, "production-deploy-not-authorized", action);
    case "delete.resource":
      return authority.externalEffects.delete
        ? decision(true, "resource-delete-authorized", action)
        : decision(false, "resource-delete-not-authorized", action);
    case "retry.operation":
      if (!authority.retry) {
        return decision(false, "retry-not-authorized", action);
      }
      if (context.outcome === "unknown" && context.reconciled !== true) {
        return decision(false, "outcome-reconciliation-required", action);
      }
      return context.outcome === "unknown"
        ? decision(true, "retry-authorized-after-reconciliation", action)
        : decision(true, "retry-authorized", action);
    case "authority.escalate":
      return {
        allowed: false,
        reason: "new-authority-grant-required",
        confirmationRequired: true
      };
    default:
      return decision(false, "unknown-action", action);
  }
}
