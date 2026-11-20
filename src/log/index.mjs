import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const resolveDataRoot = () => process.env.MOOTING_DATA_ROOT
  ? resolve(process.env.MOOTING_DATA_ROOT)
  : fileURLToPath(new URL('../../data/', import.meta.url));

const scope = new AsyncLocalStorage();
const levels = ['debug', 'info', 'warning', 'error'];
export const isTraceId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const validIds = values => [...new Set((Array.isArray(values) ? values : []).filter(isTraceId))];
export function createTrace(source, linkedTraceIds = []) {
  return { traceId: randomUUID(), source, started: performance.now(), linkedTraceIds: validIds(linkedTraceIds) };
}
export const currentTrace = () => scope.getStore();
export const runWithTrace = (trace, operation) => scope.run(trace, operation);
export const elapsed = start => Math.round((performance.now() - start) * 10) / 10;
export const traceIds = (trace = currentTrace()) => validIds([trace?.traceId, ...(trace?.linkedTraceIds ?? [])]);
export function errorFields(error) {
  const type = error?.constructor?.name;
  const name = ['AbortError', 'TimeoutError', 'MemoryUnavailableError', 'HindsightError', 'TypeError', 'InputError', 'SyntaxError'].includes(error?.name) ? error.name : type === 'InputError' ? type : 'Error';
  const code = error?.cause?.code ?? error?.code;
  const knownCode = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOSPC', 'EACCES', 'ENOENT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) ? code : undefined;
  const statusCode = error?.statusCode ?? error?.status;
  return { errorType: name, errorCode: knownCode, statusCode: Number.isInteger(statusCode) ? statusCode : undefined };
}
export function failure(error) {
  if (error?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code ?? error?.code)) return 'timeout';
  if (error?.name === 'MemoryUnavailableError') return 'unavailable';
  if (error?.name === 'AbortError') return 'cancelled';
  return 'failed';
}
export function outcomeLevel(outcome) {
  if (outcome === 'failed') return 'error';
  if (['timeout', 'cancelled', 'unavailable', 'deferred', 'rejected'].includes(outcome)) return 'warning';
  return 'info';
}

// Call sites supply only operational metadata. Unknown keys, arbitrary objects and free text are dropped.
const numericFields = new Set('elapsedMs queueMs totalMs firstOutputMs durationMs timeoutMs delayMs ageMs statusCode count pending queued pendingItems pendingBatches bytes seq turn step inputTokens outputTokens attempt'.split(' '));
const identifierFields = new Set(['inputId', 'taskId', 'spanId', 'connectionId', 'operationId', 'cardId']);
const labelFields = new Set(['outcome', 'source', 'method', 'route', 'kind', 'phase', 'errorType', 'errorCode', 'role', 'operation', 'reason', 'tool', 'callKey']);
function metadata(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => {
    if (numericFields.has(key)) return Number.isFinite(value);
    if (identifierFields.has(key)) return isTraceId(value);
    if (labelFields.has(key)) return typeof value === 'string' && /^[a-z0-9_.:/-]{1,100}$/i.test(value);
    return false;
  }));
}
function localDay(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function createLogger({ dataRoot, level = 'debug', now = () => new Date(), onError = () => console.error('[mooting-log] Failed to write diagnostic logs') }) {
  const directory = join(dataRoot, 'logs');
  const minimum = Math.max(0, levels.indexOf(level));
  let queue = [], draining, sequence = 0, dropped = 0, reportedFailure = false;
  const processId = randomUUID();
  function writeBatch() {
    if (draining || !queue.length) return;
    draining = (async () => {
      await mkdir(directory, { mode: 0o700, recursive: true });
      while (queue.length) {
        const batch = queue;
        queue = [];
        const groups = new Map();
        for (const { day, line } of batch) groups.set(day, (groups.get(day) ?? '') + line);
        for (const [day, lines] of groups) await appendFile(join(directory, `${day}.log`), lines, { mode: 0o600 });
      }
      reportedFailure = false;
    })().catch(() => {
      queue = [];
      if (!reportedFailure) { reportedFailure = true; onError(); }
    }).finally(() => {
      draining = undefined;
      writeBatch();
    });
  }
  function write(level, event, fields = {}, trace = currentTrace()) {
    if (levels.indexOf(level) < minimum) return;
    if (queue.length >= 8192) {
      dropped++;
      if (level === 'debug') return;
      const debugIndex = queue.findIndex(item => item.level === 'debug');
      if (debugIndex < 0 && level === 'info') return;
      queue.splice(Math.max(0, debugIndex), 1);
    }
    const date = now();
    const context = isTraceId(trace?.traceId) ? trace : createTrace('system');
    if (dropped && queue.length < 8190) {
      const warning = { ts: date.toISOString(), level: 'warning', event: 'log.dropped', processId, sequence: ++sequence, traceId: context.traceId, count: dropped };
      queue.push({ day: localDay(date), level: warning.level, line: JSON.stringify(warning) + '\n' });
      dropped = 0;
    }
    const linkedTraceIds = validIds(context.linkedTraceIds);
    const record = {
      ts: date.toISOString(), level, event, processId, sequence: ++sequence, traceId: context.traceId,
      ...(linkedTraceIds.length ? { linkedTraceIds } : {}), ...metadata({ source: context.source, ...fields }),
    };
    queue.push({ day: localDay(date), level, line: JSON.stringify(record) + '\n' });
    writeBatch();
  }
  return { write, async flush() { while (draining || queue.length) { writeBatch(); await draining; } } };
}

let appLogger;
export function configureLogging(options) {
  const logger = createLogger(options);
  appLogger = logger;
  return async () => {
    if (appLogger === logger) appLogger = undefined;
    await logger.flush();
  };
}
export const log = (level, event, fields, trace) => appLogger?.write(level, event, fields, trace);

export async function timed(event, operation, fields = {}, { trace = currentTrace() ?? createTrace('system'), result = () => 'ok' } = {}) {
  const start = performance.now(), spanId = randomUUID();
  const attributes = { ...fields, spanId };
  log('debug', `${event}.start`, attributes, trace);
  let outcome = 'ok', errorInfo;
  try {
    const value = await runWithTrace(trace, operation);
    outcome = result(value);
    return value;
  } catch (error) {
    outcome = failure(error);
    errorInfo = errorFields(error);
    throw error;
  } finally {
    log(outcomeLevel(outcome), `${event}.end`, { ...attributes, ...errorInfo, outcome, elapsedMs: elapsed(start) }, trace);
  }
}
