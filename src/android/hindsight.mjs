import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const MODEL = 's23u-local';
const EMBEDDING = 's23u-embedding';
const RERANKER = 's23u-reranker';

function authorized(value, key) {
  const candidate = Buffer.from(String(value ?? ''));
  const expected = Buffer.from('Bearer ' + key);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readInput(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 448_000) throw new Error('请求超出原子能力大小上限');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks));
}

export async function modelRequest(route, input, port, dimensions, signal) {
  if (route === 'chat/completions') {
    if (!Array.isArray(input.messages) || input.stream || input.tools?.length) throw new Error('不支持此记忆模型请求');
    const messages = input.messages.map(({ role, content }) => {
      if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string') {
        throw new Error('记忆模型要求纯文本消息');
      }
      return { role, content: [{ type: 'text', text: content }] };
    });
    let content = '';
    let usage;
    for await (const event of port.events('model', {
      messages, tools: [], archive: false,
      maxTokens: input.max_completion_tokens ?? input.max_tokens ?? 2048,
      responseFormat: input.response_format,
    }, signal)) {
      if (event.type === 'text') content += event.delta;
      else if (event.type === 'final') usage = event.result?.usage;
      else throw new Error('记忆模型返回了非文本事件');
    }
    if (!content.trim()) throw new Error('记忆模型未返回文本');
    return { id: randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      ...(usage ? { usage: { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } } : {}) };
  }
  if (route === 'embeddings') {
    const texts = Array.isArray(input.input) ? input.input : [input.input];
    if (!texts.length || !texts.every(text => typeof text === 'string') ||
        (input.dimensions !== undefined && input.dimensions !== dimensions)) throw new Error('无效的嵌入请求');
    const { vectors } = await port.call('embedding', { texts, dimensions }, signal);
    if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(vector =>
      Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite))) {
      throw new Error('原子嵌入结果与配置维数不匹配');
    }
    return { object: 'list', model: EMBEDDING, usage: { prompt_tokens: 0, total_tokens: 0 },
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })) };
  }
  if (route === 'rerank') {
    const { query, texts } = input;
    if (typeof query !== 'string' || !Array.isArray(texts) || !texts.every(text => typeof text === 'string')) {
      throw new Error('无效的重排请求');
    }
    const { scores } = await port.call('rerank', { query, texts }, signal);
    if (!Array.isArray(scores) || scores.length !== texts.length || !scores.every(Number.isFinite)) {
      throw new Error('原子重排结果与输入数量不匹配');
    }
    return scores.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score);
  }
  throw new Error('未知记忆模型操作');
}

function forward(incoming, response, socketPath) {
  const headers = { 'content-type': incoming.headers['content-type'] ?? 'application/json' };
  if (incoming.headers['content-length']) headers['content-length'] = incoming.headers['content-length'];
  const upstream = request({ socketPath, path: incoming.url, method: incoming.method, headers, timeout: 180_000 }, reply => {
    response.writeHead(reply.statusCode, { 'content-type': reply.headers['content-type'] ?? 'application/json',
      'cache-control': 'no-store' });
    reply.on('error', error => response.destroy(error));
    reply.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (!response.headersSent) json(response, 503, { detail: '本机 Hindsight 尚未就绪' });
    else response.destroy();
  });
  response.on('close', () => upstream.destroy());
  incoming.pipe(upstream);
}

export async function createAndroidMemory({ home, python, pythonHome, socketDirectory }, port) {
  const apiKey = randomUUID();
  const providerKey = randomUUID();
  const providerPath = '/' + randomUUID() + '/';
  const socketPath = join(socketDirectory, 'hindsight.sock');
  let activeDimensions, activeDatabase, child, configurationError, startupError;
  let retryAfter = 0;
  const server = createServer(async (incoming, response) => {
    if (!incoming.url.startsWith(providerPath)) {
      if (!authorized(incoming.headers.authorization, apiKey)) return json(response, 404, {});
      if (configurationError || !child) return json(response, 503, { detail: '本机 Hindsight 尚未就绪' });
      return forward(incoming, response, socketPath);
    }
    const route = incoming.url.slice(providerPath.length);
    const method = route === 'info' ? 'GET' : 'POST';
    if (incoming.method !== method || (!['info', 'rerank'].includes(route) &&
        !authorized(incoming.headers.authorization, providerKey))) return json(response, 404, {});
    if (configurationError) return json(response, 503, { error: { message: '本机记忆模型当前不可用' } });
    if (route === 'info') return json(response, 200, { model_id: RERANKER });
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    try {
      const input = await readInput(incoming);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(175_000)]);
      const result = await modelRequest(route, input, port, activeDimensions, signal);
      if (!response.destroyed) json(response, 200, result);
    } catch {
      if (!response.destroyed) json(response, 503, { error: { message: '本机记忆模型请求失败' } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port;

  async function refresh(device) {
    const dimensions = device.capabilities?.embeddingDimensions;
    let database;
    try {
      const provision = JSON.parse(await readFile(join(home, 'postgres.json'), 'utf8'));
      database = new URL(provision.databaseUrl);
    } catch (error) {
      configurationError = error.code === 'ENOENT' ? '请配置设备上的 Hindsight PostgreSQL' : 'PostgreSQL 配置无效';
      return;
    }
    if (!['postgresql:', 'postgres:'].includes(database.protocol) || database.hostname !== '127.0.0.1' ||
        !database.username || !database.password || database.pathname.length < 2 || database.search || database.hash) {
      configurationError = 'Hindsight PostgreSQL 需要独立数据库、用户名、密码和 127.0.0.1 地址';
      return;
    }
    if (!device.memoryModels || !Number.isSafeInteger(dimensions) || dimensions <= 0 || dimensions > 8192) {
      configurationError = '等待原子服务的 JSON Schema、嵌入和重排模型';
      return;
    }
    if (child) {
      if (database.href !== activeDatabase) {
        configurationError = '正在切换 Hindsight 数据库';
        child.kill();
      } else if (activeDimensions !== dimensions) {
        configurationError = '原子嵌入维数已变更，请先迁移 Hindsight 向量库';
      } else {
        configurationError = undefined;
      }
      return;
    }
    configurationError = undefined;
    if (Date.now() < retryAfter) return;
    activeDimensions = dimensions;
    activeDatabase = database.href;
    await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    startupError = undefined;
    const providerURL = url + providerPath;
    child = spawn(python, [join(root, 'src/android/hindsight_bootstrap.py'), socketPath,
      join(root, 'python/site-packages'), join(root, 'hindsight'), String(process.pid)], {
      cwd: home,
      env: {
        HOME: home, TMPDIR: socketDirectory, PYTHONHOME: pythonHome,
        LD_LIBRARY_PATH: dirname(python), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
        HINDSIGHT_API_DATABASE_URL: database.href,
        HINDSIGHT_API_LLM_PROVIDER: 'openai', HINDSIGHT_API_LLM_MODEL: MODEL,
        HINDSIGHT_API_LLM_BASE_URL: providerURL, HINDSIGHT_API_LLM_API_KEY: providerKey,
        HINDSIGHT_API_LLM_MAX_CONCURRENT: '1', HINDSIGHT_API_LLM_OUTPUT_LANGUAGE: '简体中文',
        HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'openai',
        HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: providerURL,
        HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: providerKey,
        HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: EMBEDDING,
        HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS: String(dimensions),
        HINDSIGHT_API_RERANKER_PROVIDER: 'tei', HINDSIGHT_API_RERANKER_TEI_URL: providerURL.slice(0, -1),
        HINDSIGHT_API_WORKERS: '1', HINDSIGHT_API_WORKER_MAX_SLOTS: '4',
        HINDSIGHT_API_MCP_ENABLED: 'false', HINDSIGHT_API_LLM_TRACE_ENABLED: 'false',
        OTEL_SDK_DISABLED: 'true',
      },
      stdio: 'ignore',
    });
    child.once('error', () => { startupError = '无法启动 APK 内置的 Hindsight Python'; });
    child.once('close', (code, signal) => {
      child = undefined;
      if (configurationError === '正在切换 Hindsight 数据库') return;
      startupError ??= `Hindsight 已退出（${code ?? signal ?? '未知状态'}），正在等待重试`;
      retryAfter = Date.now() + 15_000;
    });
  }
  return {
    endpoint: { url, apiKey, model: MODEL, embeddingModel: EMBEDDING },
    refresh, get error() { return configurationError ?? startupError; },
  };
}
