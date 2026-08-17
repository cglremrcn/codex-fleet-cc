#!/usr/bin/env node

import process from "node:process";

import { runCli } from "./lib/cli.mjs";

async function readStdin(limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) {
      return Buffer.alloc(size);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

process.exitCode = await runCli(process.argv.slice(2), { readStdin });
