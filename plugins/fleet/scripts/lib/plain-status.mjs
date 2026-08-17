const ANSI_SEQUENCE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;
const MAX_FIELD = 120;
const MAX_LANES = 32;

function field(value, fallback = "unknown") {
  const cleaned = String(value ?? fallback)
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (cleaned || fallback).slice(0, MAX_FIELD);
}

export function renderPlainStatus(snapshot = {}) {
  const workspace = snapshot.workspace ?? {};
  const runtime = snapshot.runtime ?? {};
  const lanes = Array.isArray(snapshot.lanes) ? snapshot.lanes.slice(0, MAX_LANES) : [];
  const lines = [
    `Fleet workspace ${field(workspace.name)}, branch ${field(workspace.branch)}`,
    `Runtime ${field(runtime.health)}, protocol ${field(runtime.protocol)}`
  ];

  if (lanes.length === 0) {
    lines.push("No Fleet lanes recorded.");
  } else {
    const total = Array.isArray(snapshot.lanes) ? snapshot.lanes.length : lanes.length;
    lanes.forEach((lane, index) => {
      lines.push(
        `Lane ${index + 1} of ${total}: ${field(lane?.id)}, ${field(lane?.status)}, `
        + `${field(lane?.role)}, ${field(lane?.label)}`
      );
    });
    if (total > lanes.length) {
      lines.push(`${total - lanes.length} additional lanes omitted from plain status.`);
    }
  }
  return `${lines.join("\n")}\n`;
}
