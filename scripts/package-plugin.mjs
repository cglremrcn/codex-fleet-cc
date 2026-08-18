import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_FILE = /(?:\.json|\.md|\.mjs|\.js|\.ts|\.sh|\.cmd)$/iu;
const FORBIDDEN_PATH = /(?:^|\/)(?:\.git|node_modules|tests?|\.fleet|support-bundles?)(?:\/|$)/iu;
const SECRET_PATTERN = /(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(epochSeconds) {
  const date = new Date(Math.max(epochSeconds * 1000, Date.UTC(1980, 0, 1)));
  const time = (date.getUTCSeconds() >>> 1)
    | (date.getUTCMinutes() << 5)
    | (date.getUTCHours() << 11);
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const year = Math.max(1980, date.getUTCFullYear());
  return { time, date: day | (month << 5) | ((year - 1980) << 9) };
}

async function collectFiles(root, directory = root) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin package cannot contain symlinks: ${absolute}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    else throw new Error(`Unsupported plugin package entry: ${absolute}`);
  }
  return files.sort();
}

function zipArchive(entries, sourceDateEpoch) {
  const localParts = [];
  const centralParts = [];
  const timestamp = dosTimestamp(sourceDateEpoch);
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(timestamp.time, 10);
    local.writeUInt16LE(timestamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(timestamp.time, 12);
    central.writeUInt16LE(timestamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export async function buildPluginArchive(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? path.join(ROOT, "plugins", "fleet"));
  const outputDir = path.resolve(options.outputDir ?? path.join(ROOT, "dist"));
  const version = String(options.version ?? "0.1.0");
  const sourceDateEpoch = Number(options.sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH ?? 0);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
    throw new TypeError("Package version must be semantic.");
  }
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new TypeError("sourceDateEpoch must be a non-negative integer.");
  }

  const names = await collectFiles(sourceRoot);
  const unexpectedFiles = names.filter((name) => FORBIDDEN_PATH.test(name));
  if (unexpectedFiles.length > 0) throw new Error(`Unexpected package files: ${unexpectedFiles.join(", ")}`);
  const entries = [];
  let containsSecretPattern = false;
  for (const name of names) {
    let bytes = await fs.readFile(path.join(sourceRoot, ...name.split("/")));
    if (TEXT_FILE.test(name) || name === "LICENSE" || name === "NOTICE") {
      bytes = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
      containsSecretPattern ||= SECRET_PATTERN.test(bytes.toString("utf8"));
    }
    entries.push({ name, bytes, mode: name.endsWith(".sh") ? 0o100755 : 0o100644 });
  }
  if (containsSecretPattern) throw new Error("Secret-like content was found in the plugin package.");

  const archiveBytes = zipArchive(entries, sourceDateEpoch);
  const sha256 = crypto.createHash("sha256").update(archiveBytes).digest("hex");
  await fs.mkdir(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, `fleet-${version}.zip`);
  const checksumPath = `${archivePath}.sha256`;
  const provenancePath = path.join(outputDir, `fleet-${version}.provenance.json`);
  await fs.writeFile(archivePath, archiveBytes);
  await fs.writeFile(checksumPath, `${sha256}  ${path.basename(archivePath)}\n`, "utf8");
  await fs.writeFile(provenancePath, `${JSON.stringify({
    schemaVersion: 1,
    buildType: "https://github.com/cglremrcn/codex-fleet-cc/release/v1",
    version,
    sourceDateEpoch,
    subject: { name: path.basename(archivePath), sha256 },
    entries: entries.map((entry) => entry.name)
  }, null, 2)}\n`, "utf8");
  return {
    archivePath,
    checksumPath,
    provenancePath,
    sha256,
    entries: entries.map((entry) => entry.name),
    unexpectedFiles,
    containsSecretPattern
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const versionIndex = process.argv.indexOf("--version");
  const version = versionIndex === -1 ? "0.1.0" : process.argv[versionIndex + 1];
  const result = await buildPluginArchive({ version });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
