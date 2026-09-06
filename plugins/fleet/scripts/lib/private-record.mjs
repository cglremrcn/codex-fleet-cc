import crypto from "node:crypto";
import fs, { constants } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 128 * 1024;

/** Small local control records. No read creates directories or follows a record symlink. */
export async function assertRecordDirectory(directory, { create = false } = {}) {
  if (!path.isAbsolute(directory)) throw new TypeError("Record directory must be absolute.");
  try {
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe record directory.");
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    await assertRecordDirectory(parent, { create: true });
    await fs.mkdir(directory, { mode: 0o700 }).catch((failure) => {
      if (failure.code !== "EEXIST") throw failure;
    });
    await assertRecordDirectory(directory);
  }
}

export async function readPrivateRecord(file, options = {}) {
  const maximum = options.maxBytes ?? MAX_BYTES;
  let handle;
  try {
    await assertRecordDirectory(path.dirname(file));
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
      throw new Error("Unsafe or oversized local record.");
    }
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximum) throw new Error("Unsafe or oversized local record.");
    const buffer = Buffer.alloc(maximum + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    if (bytesRead > maximum) throw new Error("Local record exceeded its read budget.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } catch (error) {
    if (error.code === "ENOENT" && options.missing !== undefined) return options.missing;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writePrivateRecord(file, value, options = {}) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > (options.maxBytes ?? MAX_BYTES)) throw new Error("Local record is oversized.");
  const directory = path.dirname(file);
  await assertRecordDirectory(directory, { create: true });
  const temporary = path.join(directory, `.record-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    try {
      const old = await fs.lstat(file);
      if (!old.isFile() || old.isSymbolicLink()) throw new Error("Unsafe local record target.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** attempt)));
      }
    }
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Exclusive, bounded local-record transaction. A stale lock is reported, never stolen. */
export async function withPrivateRecordLock(file, operation, options = {}) {
  const directory = path.dirname(file);
  await assertRecordDirectory(directory, { create: true });
  const lockPath = `${file}.lock`;
  const attempts = options.attempts ?? 40;
  let handle;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { handle = await fs.open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt + 1 === attempts) throw new Error("Local record is locked by another writer; retry after it finishes.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error("Local record lock could not be acquired.");
  try {
    await handle.writeFile(JSON.stringify({ owner: crypto.randomUUID(), createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    const ours = await handle.stat();
    await handle.close();
    const current = await fs.lstat(lockPath).catch(() => null);
    if (current && !current.isSymbolicLink() && current.dev === ours.dev && current.ino === ours.ino) await fs.unlink(lockPath);
  }
}
