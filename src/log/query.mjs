import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isTraceId, resolveDataRoot } from './index.mjs';

const [traceId, dataRoot = resolveDataRoot()] = process.argv.slice(2);
if (!isTraceId(traceId)) {
  console.error('Usage: node src/log/query.mjs <traceId> [dataRoot]');
  process.exitCode = 2;
} else {
  const directory = join(dataRoot, 'logs');
  const names = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = names.filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort();
  async function* records() {
    for (const file of files) {
      const lines = createInterface({ input: createReadStream(join(directory, file)), crlfDelay: Infinity });
      for await (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (isTraceId(row?.traceId)) yield row;
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
    }
  }
  const descendants = new Map(), sources = new Map();
  const id = traceId.toLowerCase();
  const linkedSpeech = new Set();
  for await (const row of records()) {
    sources.set(row.traceId, row.source);
    for (const parent of row.linkedTraceIds ?? []) {
      if (row.traceId === id && row.source === 'voice') linkedSpeech.add(parent);
      if (!descendants.has(parent)) descendants.set(parent, new Set());
      descendants.get(parent).add(row.traceId);
    }
  }
  const ids = new Set([id]);
  // A voice-button submission points back to the ASR segment seen before the click.
  for (const parent of linkedSpeech) if (sources.get(parent) === 'voice_segment') ids.add(parent);
  for (const parent of ids) {
    for (const child of descendants.get(parent) ?? []) {
      if (linkedSpeech.has(parent) && sources.get(child) === 'voice') continue;
      ids.add(child);
    }
  }
  const matches = [];
  for await (const row of records()) if (ids.has(row.traceId)) matches.push(row);
  matches.sort((a, b) => a.ts.localeCompare(b.ts) || a.processId.localeCompare(b.processId) || a.sequence - b.sequence);
  for (const row of matches) console.log(JSON.stringify(row));
  if (!matches.length) { console.error('Trace not found'); process.exitCode = 1; }
}
