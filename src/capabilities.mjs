/** Only include utterances recorded after this subtitle activation; revisions replace their line. */
export function subtitleText(utterances, boundaryMs) {
  return (utterances ?? []).filter(utterance => utterance.end_time > boundaryMs).map(utterance => {
    if (utterance.start_time >= boundaryMs) return utterance.text;
    return (utterance.words ?? []).filter(word => Number.isFinite(word.start_time) && word.start_time >= boundaryMs).map(word => word.text ?? word.word ?? '').join('');
  }).filter(Boolean).flatMap(text => text.split(/(?<=[。！？!?])\s*|\n+/u).map(line => line.trim()).filter(Boolean)).slice(-100).join('\n');
}

/** Subtitle capability subscribes to the shared sound2text recognition service. */
function registerSubtitle(manager, sound2text) {
  return manager.register({
    id: 'realtime_subtitle', executionKind: 'program', description: '开启实时字幕，展示 sound2text 实时识别，直到用户关闭或语音服务停止', continuous: true,
    async start({ publish, signal, onEnded }) {
      signal?.throwIfAborted();
      if (!sound2text || sound2text.state().status !== 'running') throw new Error('语音输入未开启，请先开启语音输入。');
      const boundaryMs = sound2text.state().audioMs;
      let stopped = false, unsubscribe, previous = '';
      const dispose = () => { stopped = true; unsubscribe?.(); signal?.removeEventListener('abort', dispose); };
      const update = value => {
        if (stopped || signal?.aborted) return;
        if (value.status !== 'running') { dispose(); onEnded?.(value.status === 'error' ? 'sound2text_error' : 'sound2text_stopped'); return; }
        const text = subtitleText(value.utterances, boundaryMs);
        if (text !== previous) { previous = text; publish(text); }
      };
      return {
        begin() { if (stopped) return; unsubscribe = sound2text.subscribe(update); signal?.addEventListener('abort', dispose, { once: true }); update(sound2text.state()); },
        async dispose() { dispose(); },
      };
    },
  });
}

function registerSpeaker(manager) {
  return manager.register({
    id: 'speaker_identification', executionKind: 'program', continuous: true,
    description: '面前说话人识别：用模拟数据展示名字、职业和上次聊过的话题，直到用户关闭',
    async start({ publish, signal }) {
      signal?.throwIfAborted();
      let stopped = false;
      return {
        begin() {
          if (!stopped && !signal?.aborted) publish({
            name: 'John',
            identity: '空间折叠负责人；AI创业者',
            notes: [
              '上次聊过如何构建高时效性的AgentOS。',
              '对于新AI终端的出现坚定不移。',
              '创立了一家人文科技公司“空间折叠”。',
            ],
          });
        },
        async dispose() { stopped = true; },
      };
    },
  });
}

const MODEL_CAPABILITIES = [
  { id: 'summarize_context', description: '总结当前上下文，提炼重点、结论和待办事项' },
  { id: 'explain_term', description: '结合当前上下文解释术语、概念或陌生表达，给出简洁易懂的说明' },
  { id: 'general_assistant', description: '处理开放式请求：回答问题、分析信息、提出建议或起草文字' },
];

/** Register production capabilities; a model failure propagates without simulated fallback. */
export function registerCapabilities(manager, { sound2text, runModel } = {}) {
  if (typeof runModel !== 'function') throw new TypeError('registerCapabilities requires runModel');
  const releases = [registerSubtitle(manager, sound2text), registerSpeaker(manager)];
  for (const { id, description } of MODEL_CAPABILITIES) {
    releases.push(manager.register({
      id, description, executionKind: 'model',
      async start({ snapshot, signal, taskId }) {
        signal?.throwIfAborted();
        const output = await runModel({ instruction: snapshot.instruction, context: snapshot.context, capability: id, signal, taskId });
        signal?.throwIfAborted();
        if (!output || typeof output.text !== 'string' || !output.text.trim()) throw new Error(`模型未返回有效文本：${id}`);
        return { result: { text: output.text, ...(output.model === undefined ? {} : { model: output.model }), simulated: false } };
      },
    }));
  }
  return () => releases.reverse().forEach(dispose => dispose());
}
