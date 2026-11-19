import { createServer } from 'node:http';
import { commandFromPrompt } from '../src/context/index.mjs';

const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(part => part.text ?? '').join('');
/** Test-only Responses API fixture. Scripted responses never load in the production app. */
export async function startModelFixture() {
  const requests = []; let failing = false;
  const server = createServer(async (req, res) => {
    if (failing) { res.writeHead(503); res.end('fixture unavailable'); return; }
    if (req.url !== '/v1/responses') { res.writeHead(404); res.end('Responses API only'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(value);
    const last = value.input.at(-1);
    const memory = text => text.startsWith('Current runtime context') || text.startsWith('## 长期记忆');
    const user = [...value.input].reverse().find(item => item.role === 'user' && !memory(textOf(item)));
    let instruction = textOf(user);
    try { const parsed = JSON.parse(instruction); if (typeof parsed.instruction === 'string') instruction = parsed.instruction; } catch { instruction = commandFromPrompt(instruction); }
    const toolName = /关闭/.test(instruction) && /说话人|面前/.test(instruction) ? 'close_speaker' : /说话人|面前/.test(instruction) ? 'open_speaker' : undefined;
    const n = requests.length; let output;
    const message = text => ({ type: 'message', id: `msg-${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
    const call = name => ({ type: 'function_call', id: `fc-item-${n}`, call_id: `fixture-${n}`, name, arguments: '{}', status: 'completed' });
    if (!value.tools?.length) output = message(`测试模型接口已处理：${instruction}`);
    else if (last.type === 'function_call_output') {
      const result = JSON.parse(last.output);
      if (result.close_first) output = call(result.close_first);
      else if (result.closed && !/关闭/.test(instruction) && toolName?.startsWith('open_')) output = call(toolName);
      else output = message(result.say ?? result.error ?? '当前没有功能变化。');
    } else output = toolName ? call(toolName) : message(`测试模型接口已处理：${instruction}`);
    const reasoning = { type: 'reasoning', id: `rs-${n}`, summary: [{ type: 'summary_text', text: '测试服务正在检查输入。' }], encrypted_content: `fixture-encrypted-${n}` };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id: `response-${n}`, status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } });
    send({ type: 'response.reasoning_summary_part.added', item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } });
    send({ type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, output_index: 0, summary_index: 0, delta: reasoning.summary[0].text });
    send({ type: 'response.reasoning_summary_text.done', item_id: reasoning.id, output_index: 0, summary_index: 0, text: reasoning.summary[0].text });
    send({ type: 'response.output_item.done', output_index: 0, item: reasoning });
    send({ type: 'response.output_item.added', output_index: 1, item: output.type === 'function_call' ? { ...output, arguments: '', status: 'in_progress' } : { ...output, content: [], status: 'in_progress' } });
    if (output.type === 'function_call') {
      const mid = Math.ceil(output.arguments.length / 2);
      send({ type: 'response.function_call_arguments.delta', item_id: output.id, output_index: 1, delta: output.arguments.slice(0, mid) });
      await new Promise(resolve => setImmediate(resolve));
      send({ type: 'response.function_call_arguments.delta', item_id: output.id, output_index: 1, delta: output.arguments.slice(mid) });
      send({ type: 'response.function_call_arguments.done', item_id: output.id, output_index: 1, arguments: output.arguments });
    } else {
      const text = output.content[0].text, mid = Math.ceil(text.length / 2);
      send({ type: 'response.content_part.added', item_id: output.id, output_index: 1, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      send({ type: 'response.output_text.delta', item_id: output.id, output_index: 1, content_index: 0, delta: text.slice(0, mid) });
      await new Promise(resolve => setImmediate(resolve));
      send({ type: 'response.output_text.delta', item_id: output.id, output_index: 1, content_index: 0, delta: text.slice(mid) });
      send({ type: 'response.output_text.done', item_id: output.id, output_index: 1, content_index: 0, text });
    }
    send({ type: 'response.output_item.done', output_index: 1, item: output });
    send({ type: 'response.completed', response: { id: `response-${n}`, status: 'completed', output: [reasoning, output], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests, fail(value) { failing = value; }, async close() { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } };
}
