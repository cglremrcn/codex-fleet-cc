import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "../plugins/fleet/scripts/lib/is-main.mjs";

const EXCLUDED_DIRECTORIES = new Set([".git", ".fleet-ci", "dist", "node_modules"]);
const LINK_PATTERN = /!?\[[^\]]*\]\(([^)]+)\)/gu;

async function markdownFiles(root, directory = root) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
      files.push(...await markdownFiles(root, absolute));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(path.relative(root, absolute));
    }
  }
  return files;
}

function localTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/gu, "");
  if (!target || target.startsWith("#")
      || /^(?:https?:|mailto:|tel:)/iu.test(target)) return null;
  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

export async function checkLocalLinks(root, options = {}) {
  const files = options.files ?? await markdownFiles(root);
  const broken = [];
  let checkedLinks = 0;
  for (const relativeFile of [...files].sort()) {
    const absoluteFile = path.resolve(root, relativeFile);
    const markdown = await fs.readFile(absoluteFile, "utf8");
    for (const match of markdown.matchAll(LINK_PATTERN)) {
      const target = localTarget(match[1]);
      if (!target) continue;
      checkedLinks += 1;
      const resolved = path.resolve(path.dirname(absoluteFile), target);
      const insideRoot = resolved === path.resolve(root)
        || resolved.startsWith(`${path.resolve(root)}${path.sep}`);
      if (!insideRoot) {
        broken.push({ file: relativeFile, target: match[1], reason: "outside-repository" });
        continue;
      }
      try {
        await fs.access(resolved);
      } catch {
        broken.push({ file: relativeFile, target: match[1], reason: "missing-target" });
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    ok: broken.length === 0,
    scannedFiles: files.length,
    checkedLinks,
    broken
  });
}

if (isMainModule(import.meta.url)) {
  try {
    const report = await checkLocalLinks(process.cwd());
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Documentation link check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
