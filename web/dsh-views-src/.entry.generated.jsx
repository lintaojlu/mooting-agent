import React, {useLayoutEffect, useRef, useState, useMemo} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-trajectory/node_modules/react/index.js';
import {createRoot} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-trajectory/node_modules/react-dom/client.js';
import {TrajectoryView} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-trajectory/src/client/TrajectoryView.tsx';
import {toAssistantBlocks} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-trajectory/src/client/trajectory-event-projection.ts';
import {zh as trajectoryZh} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-trajectory/src/client/locales.ts';
import {zh as chatZh} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-chat/src/client/locale.ts';
import {zh as toolZh} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-conversation/src/client/locales.ts';
import {AssistantMarkdown} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx';
import {AssistantNodeView} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx';
import {ChatFlow} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-chat/src/client/chat/ChatFlow.tsx';
import {ContextMessageNodeView, UserMessageNodeView} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-chat/src/client/chat/MessageItem.tsx';
import {UserContent} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-chat/src/client/chat/UserContent.tsx';
import {useFlowHidden, useMotionHidden} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-chat/src/client/chat/flow-motion.ts';
import {ProcessState} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts';
import {GenericToolCard} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx';
import {DetailsRow} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-tool/src/client/tool/toolviews/details-row.tsx';
import {PartialArguments} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-trajectory/node_modules/@deepseek-ai/dsh-util-values/lib/index.js';
import {ICON_SYMBOLS} from '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-primitives/lib/index.js';
import '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-theme/src/styles/base.css';
import '/Users/nil/Experiment/agent-harness-selection/deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
import './views.css';

const translate = dictionary => (key, args = {}) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => args[k] ?? `{${k}}`);
const t = translate(trajectoryZh), tc = translate({...chatZh,...toolZh});
const CHAT_POLICY = {mode:'standard',collapseTiming:'completion',foldedReplies:'all',foldCompletedTurns:true,stepGrouping:'collapsed',liveProcessDetail:true,settledReasoningPreview:true};
const LOCATION_SOURCE = {getSnapshot:() => undefined,subscribe:() => () => {}};
const LOCATION_DATA = {get:() => undefined,source:() => LOCATION_SOURCE};
const KNOWN_CONTEXT_FORMS = new Set(['instructions','catalog','snapshot','notice','relay','recall']);
const text = blocks => (blocks ?? []).filter(b=>b.type==='text').map(b=>b.text).join('');
const timeOf = event => typeof event.time === 'number' ? event.time : typeof event.timestamp === 'number' ? event.timestamp : Date.parse(event.timestamp ?? event.at ?? '') || 0;
const parseArguments = value => { if (typeof value !== 'string') return value ?? {}; try { return JSON.parse(value); } catch { return {}; } };
const noop = () => {};
const loadImage = Object.assign(async () => { throw new Error('该原型未提供图像附件'); }, {peek:()=>undefined});
function useDisclosure() { const [expanded,set]=useState(false); return {expanded,setExpanded:set,toggle:()=>set(v=>!v)}; }
function UserMessageLine({ text }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const line = ref.current;
    if (!line) return;
    setOverflows(expanded || line.scrollWidth > line.clientWidth + 1);
  }, [text, expanded]);
  if (!text) return null;
  return <div className={expanded ? 'dsh-user-line is-expanded' : 'dsh-user-line'}>
    <div ref={ref} className="dsh-user-line-text">{text}</div>
    {overflows && <button type="button" className="dsh-user-line-toggle" aria-expanded={expanded} aria-label={expanded ? '收起消息' : '展开消息'} onClick={() => setExpanded(value => !value)}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6.2 8 10.2 12 6.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></button>}
  </div>;
}
const renderFactorySlot = (name, props) => {
  if (name === 'conversation.chat.user.content') return <UserContent content={props.content} loadImage={props.loadImage} facts={props.facts} interactive={props.interactive} renderFactorySlot={renderFactorySlot} renderSlot={() => null} t={tc} />;
  if (name === 'conversation.user.text') return <UserMessageLine text={props.text ?? ''} />;
  return <span style={{whiteSpace:'pre-wrap'}}>{props.text}</span>;
};

/** Thin raw-event adapter. DSH leaf renderers/layout retain their own presentation algorithms. */
export function projectEvents(events) {
  const nodes=[], systemPrompts=[], calls=new Map(), starts=new Map(), turns=new Map(), locations=new Map();
  let turn=1,step=0,config;
  for(const event of events ?? []) {
    const d=event.data ?? {},time=timeOf(event),seq=event.seq ?? nodes.length+1;
    if(event.type==='turn/start'){turn=d.turn;turns.set(turn,{start:{...event,time},end:undefined});}
    if(event.type==='turn/end'){const entry=turns.get(d.turn)??{};entry.end={...event,time};turns.set(d.turn,entry);}
    if(event.type==='step/start'){turn=d.turn;step=d.step;starts.set(`${turn}:${step}`,time);}
    if(event.type==='request/header') config=d.header?.config;
    if(event.type==='system/message')systemPrompts.push({seq,time,text:text(d.content),update:systemPrompts.length>0});
    if(event.type==='user/message'){
      const kind=d.source?.kind==='user'?'user':'context';
      nodes.push({kind,seq,time,content:d.content??[],source:d.source,...kind==='context'?{producer:{role:'inject',label:d.source?.kind??null},form:d.source?.form??null}:{}});
      locations.set(seq,{kind:'step',turn:{turn},step:{step}});
    }
    if(event.type==='tool/call')calls.set(d.callId,{...d,time});
    if(event.type==='assistant/message'||event.type==='assistant/attempt'){
      const message=d.message??{};
      const stream=d.stream??[];
      let first=null,usage;
      for(const entry of stream){if(first===null&&(/chunks$/.test(entry.type)||entry.chunk?.type?.endsWith('-delta')))first=entry.time0??entry.time; if(entry.chunk?.type==='usage')usage=entry.chunk.usage;}
      nodes.push({kind:'assistant',seq,time,turn:d.turn??turn,step:d.step??step,messageId:message.id,blocks:toAssistantBlocks(message.content??[]),requestConfig:config,usage,timing:{stepStartTime:starts.get(`${d.turn??turn}:${d.step??step}`)??null,firstTokenTime:first,completedTime:time}});
    }
    if(event.type==='tool/result'){
      const message=d.message??{},callId=String(message.toolCallId??d.callId??''),call=calls.get(callId),argsRaw=typeof call?.arguments==='string'?call.arguments:JSON.stringify(call?.arguments??{});
      let object;try{object=JSON.parse(argsRaw);}catch{object={};}
      nodes.push({kind:'tool-result',seq,time,callId,name:call?.name??'',args:PartialArguments.fromObject(object),call:call?{name:call.name,argsRaw}:null,callTime:call?.time??null,content:message.content??[],isError:!!message.isError,subCalls:[]});
    }
  }
  const runningCalls=[...calls].filter(([id])=>!nodes.some(n=>n.kind==='tool-result'&&n.callId===id)).map(([callId,c])=>({phase:'start',callId,name:c.name,argsRaw:typeof c.arguments==='string'?c.arguments:JSON.stringify(c.arguments??{}),args:PartialArguments.fromObject(parseArguments(c.arguments)),time:c.time,turn:c.turn,step:c.step,subCalls:[]}));
  return {nodes,systemPrompts,eventLocations:locations,partial:null,runningCalls,turns};
}

function partialNode(stream) {
  if(!stream?.attemptId)return null;
  return {turn:stream.turn,step:stream.step,blocks:[...(stream.reasoning?[{kind:'reasoning',text:stream.reasoning}]:[]),...(stream.text?[{kind:'text',text:stream.text}]:[])],timing:{stepStartTime:stream.startedAt??null,firstTokenTime:null}};
}
function useGroupAction(hidden, reveal) { return useFlowHidden(hidden, reveal, undefined); }
function useGroupHeaderAction(ref, hidden) { useMotionHidden(ref, hidden, undefined); }
function useContextMenu() { return {getTriggerProps:() => ({})}; }
function useAccess() { return false; }
function useProjection() { return undefined; }
function useTurnData() { return undefined; }
function fileMentions() { return undefined; }
function renderSlotChain(_name, _props, options) { return options?.fallback ?? null; }
function mountIconSprite() {
  if (typeof document === 'undefined' || document.querySelector('[data-dsh-icon-sprite]')) return;
  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('data-dsh-icon-sprite', '');
  sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  const dropped = new Set(['width', 'height', 'xmlns', 'class', 'aria-hidden']);
  for (const [id, markup] of Object.entries(ICON_SYMBOLS)) {
    const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
    for (const {name, value} of root.attributes) if (!dropped.has(name)) symbol.setAttribute(name, value);
    symbol.id = id;
    symbol.append(...[...root.childNodes].map(node => document.importNode(node, true)));
    sprite.append(symbol);
  }
  document.body.prepend(sprite);
}
function chatModel(events, busy, stream) {
  const projected = projectEvents(events);
  const timelineTurns = new Map();
  const ensureTurn = (turn, open) => {
    let location = timelineTurns.get(turn);
    if (!location) {
      location = {turn, start:undefined, end:undefined, status:open ? 'open' : 'closed', steps:[], data:LOCATION_DATA};
      timelineTurns.set(turn, location);
    } else if (open) location.status = 'open';
    return location;
  };
  for (const [turn, info] of projected.turns) ensureTurn(turn, busy && stream?.turn === turn || !info?.end);
  const nodes = [];
  let lastTurn = 1;
  const place = (turn, step) => {
    if (typeof turn === 'number') lastTurn = turn;
    const number = typeof turn === 'number' ? turn : lastTurn;
    const turnLocation = ensureTurn(number, busy && stream?.turn === number);
    return {kind:'step', turn:turnLocation, step:{turn:number, step:step ?? 0, start:undefined, end:undefined, status:turnLocation.status, data:LOCATION_DATA}};
  };
  for (const node of projected.nodes) {
    const located = projected.eventLocations.get(node.seq);
    const turn = node.turn ?? located?.turn?.turn;
    const step = node.step ?? located?.step?.step ?? 0;
    const location = place(turn, step);
    const base = {key:String(node.seq), target:'chat', anchorSeq:node.seq, visibility:'visible', location};
    if (node.kind === 'user') nodes.push({...base, kind:'user', groupTree:'input', data:{seq:node.seq, time:node.time, content:node.content ?? [], source:node.source}});
    else if (node.kind === 'context') {
      const form = KNOWN_CONTEXT_FORMS.has(node.form) ? node.form : KNOWN_CONTEXT_FORMS.has(node.source?.form) ? node.source.form : null;
      nodes.push({...base, kind:'context', groupTree:'input', data:{seq:node.seq, time:node.time, content:node.content ?? [], source:node.source, producer:node.producer ?? {role:'inject', label:node.source?.kind ?? null}, form}});
    } else if (node.kind === 'assistant') nodes.push({...base, kind:'assistant-step', data:{status:'settled', turn:turn ?? lastTurn, step, blocks:node.blocks ?? [], time:node.time, finalNode:{kind:'assistant', seq:node.seq, time:node.time, turn:turn ?? lastTurn, step, blocks:node.blocks ?? []}}});
    else if (node.kind === 'tool-result') nodes.push({...base, kind:'tool-call', data:{root:node}});
  }
  for (const call of projected.runningCalls) nodes.push({key:'run-' + call.callId, target:'chat', anchorSeq:call.time ?? nodes.length, visibility:'visible', location:place(call.turn, call.step), kind:'tool-call', data:{root:call}});
  const partial = busy ? partialNode(stream) : null;
  if (partial) nodes.push({key:'partial', target:'chat', anchorSeq:Number.MAX_SAFE_INTEGER, visibility:'visible', location:place(partial.turn, partial.step), kind:'assistant-step', data:{status:'running', turn:partial.turn, step:partial.step, blocks:partial.blocks, time:Date.now()}});
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const keysByTurn = new Map();
  for (const node of nodes) {
    const turn = node.location.turn.turn;
    const keys = keysByTurn.get(turn) ?? [];
    keys.push(node.key);
    keysByTurn.set(turn, keys);
  }
  const positions = new Map();
  for (const keys of keysByTurn.values()) keys.forEach((key, index) => positions.set(key, {turn:byKey.get(key).location.turn.turn, previous:keys[index - 1], next:keys[index + 1]}));
  const state = new ProcessState();
  state.accept({kind:'replace', order:nodes.map(node => node.key), readNode:key => byKey.get(key), readTurn:turn => keysByTurn.get(turn) ?? [], readPosition:key => positions.get(key) ?? {turn:undefined, previous:undefined, next:undefined}, timeline:{turnOrder:[...timelineTurns.keys()], turns:timelineTurns}});
  const update = state.output();
  const groups = new Map((update?.groups.kind === 'replace' ? update.groups.snapshots : []).map(group => [group.key, group]));
  return {entries:update?.entries ?? [], nodes:byKey, groups, lastInputTurn:[...nodes].reverse().find(node => node.kind === 'user')?.location.turn.turn};
}
function renderChatSlot(name, props, options) {
  if (name === 'conversation.chat.reasoning.body') return <pre>{props.text}</pre>;
  if (name !== 'conversation.chat.node') return options?.fallback ?? null;
  const node = props.node;
  if (node.kind === 'user' || node.kind === 'steering') return <UserMessageNodeView node={node} renderFactorySlot={renderFactorySlot} loadImage={loadImage} renderSlotChain={renderSlotChain} t={tc} useSession={props.useSession} useProjection={useProjection} useAccess={useAccess}/>;
  if (node.kind === 'context') return <ContextMessageNodeView node={node} t={tc}/>;
  if (node.kind === 'assistant-step') return <AssistantNodeView node={node} groupPart={props.groupPart} turnProcess={props.turnProcess} openFile={noop} loadImage={loadImage} fileMentions={fileMentions} useDisclosure={useDisclosure} useGroupAction={useGroupAction} useTurnData={useTurnData} usePresentation={selector => selector(CHAT_POLICY)} renderSlot={renderChatSlot} t={tc} sessionId="main" useContextMenu={useContextMenu} resolveFilePath={path => path}/>;
  if (node.kind === 'tool-call') {
    const root = node.data.root;
    const toolProps = {toolName:root.name, block:root, cwd:'', home:'', openFile:noop, inspect:noop, useDisclosure, t:tc};
    return String(root.name).startsWith('job_') ? <DetailsRow {...toolProps}/> : <GenericToolCard {...toolProps} getFileTriggerProps={() => ({})}/>;
  }
  return options?.fallback ?? null;
}
function Assistant({node,streaming=false}) {return <AssistantMarkdown blocks={node.blocks} streaming={streaming} useDisclosure={useDisclosure} useGroupAction={useGroupAction} usePresentation={selector => selector(CHAT_POLICY)} renderSlot={renderChatSlot} loadImage={loadImage} t={tc}/>;}
function Conversation({events,busy,stream}) {
  const model = useMemo(() => chatModel(events, busy, stream), [events, busy, stream]);
  const rolledBackTurns = useMemo(() => new Set(), []);
  const useSession = selector => selector({running:!!busy, openState:'open', loadingOlder:false, hasMore:false, openError:null});
  const useChat = selector => selector({nodes:model.nodes, order:[...model.nodes.keys()], navigation:{items:() => []}});
  const useChatNode = (key, selector) => { const node = model.nodes.get(key); return typeof selector === 'function' ? selector(node) : node; };
  const useChatGroup = (key, selector) => { const group = model.groups.get(key); return typeof selector === 'function' ? selector(group) : group; };
  const slot = (name, props, options) => renderChatSlot(name, {...props, useSession}, options);
  if (!model.entries.length && !busy) return <div className="dsh-conversation"><p className="dsh-empty">暂无对话。</p></div>;
  return <div className="dsh-conversation"><ChatFlow entries={model.entries} pendingInputs={[]} lastInputTurn={model.lastInputTurn} deferCollapse={false} rolledBackTurns={rolledBackTurns} useSession={useSession} useChat={useChat} useChatNode={useChatNode} useChatNodeBottom={() => false} useChatNodeProcess={() => undefined} useChatGroup={useChatGroup} usePresentation={selector => selector(CHAT_POLICY)} useConnectionState={selector => selector('connected')} useStore={selector => selector({})} actions={{setTurnProcessOpen:noop}} renderSlot={slot} renderFactorySlot={renderFactorySlot} t={tc} useGroupAction={useGroupAction} useGroupHeaderAction={useGroupHeaderAction} cwd="" openFile={noop} inspectCall={noop} forkAt={noop} loadImage={loadImage}/></div>;
}
function trajectorySnapshot(events, busy, stream) {
  const projected = projectEvents(events);
  return {systemPrompts:projected.systemPrompts, eventNodes:projected.nodes, eventLocations:projected.eventLocations, requests:[], callSchemas:new Map(), partial:busy ? partialNode(stream) : null, runningCalls:projected.runningCalls};
}
function Trajectory({events,busy,stream}) {
  const [actualDuration, setActualDuration] = useState(false);
  const snapshot = useMemo(() => trajectorySnapshot(events, busy, stream), [events, busy, stream]);
  const useSession = selector => selector({openState:'open', loadingOlder:false, hasMore:false});
  return <div className="dsh-trajectory"><TrajectoryView useSession={useSession} useTrajectory={selector => selector(snapshot)} useDuration={selector => selector(actualDuration)} loadOlder={async () => false} loadImage={loadImage} setActualDuration={setActualDuration} renderSlot={() => null} completeViewRequest={noop} t={t}/></div>;
}
const WORKER_STATUS = {created:'已创建',starting:'启动中',running:'运行中',stopping:'停止中',completed:'已完成',failed:'失败',cancelled:'已取消'};

/** Pair task records with ordered worker journal requests; no synthetic executions are created. */
export function projectWorkers(events = [], tasks = []) {
  const runs = [], assigned = new Set();
  const byId = new Map(tasks.map(task => [task.id, task]));
  const findRun = data => [...runs].reverse().find(run => data.taskId ? run.taskId === data.taskId : run.capability === data.capability && !run.settled);
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'mooting/worker-request') {
      const task = data.taskId ? byId.get(data.taskId) : tasks.find(candidate => candidate.capability === data.capability && !assigned.has(candidate.id));
      if (task) assigned.add(task.id);
      runs.push({key:'request-'+event.seq,taskId:task?.id??data.taskId,capability:data.capability,model:data.model,messages:data.messages??[],text:'',reasoning:'',status:task?.status??'running',task,startedAt:timeOf(event),settled:false});
      continue;
    }
    if (!['mooting/worker-delta','mooting/worker-response','mooting/worker-error'].includes(event.type)) continue;
    const run = findRun(data);
    if (!run) continue;
    if (event.type === 'mooting/worker-delta') {
      if (typeof data.text === 'string') run.text += data.text;
      if (typeof data.reasoning === 'string') run.reasoning += data.reasoning;
    } else if (event.type === 'mooting/worker-response') {
      if (typeof data.text === 'string') run.text = data.text;
      if (typeof data.reasoning === 'string') run.reasoning = data.reasoning;
      run.model = data.model ?? run.model; run.status = run.task?.status ?? 'completed'; run.settled = true;
    } else {
      run.error = typeof data.error === 'string' ? data.error : 'Worker 执行失败'; run.status = 'failed'; run.settled = true;
    }
  }
  for (const task of tasks) {
    if (assigned.has(task.id)) continue;
    runs.push({key:'task-'+task.id,taskId:task.id,capability:task.capability,status:task.status,task,messages:[],text:task.capability==='realtime_subtitle'?'':typeof task.result?.text==='string'?task.result.text:'',error:task.result?.error,settled:['completed','failed','cancelled'].includes(task.status)});
  }
  const order = new Map(tasks.map((task,index)=>[task.id,index]));
  return runs.sort((a,b)=>(order.get(a.taskId)??tasks.length)-(order.get(b.taskId)??tasks.length));
}

function WorkerRun({run}) {
  const subtitle = run.capability === 'realtime_subtitle';
  const speaker = run.capability === 'speaker_identification';
  const blocks = [...(run.reasoning?[{kind:'reasoning',text:run.reasoning}]:[]),...(run.text?[{kind:'text',text:run.text}]:[])];
  const status = WORKER_STATUS[run.status] ?? run.status;
  return <article className="dsh-worker-run" data-worker-task={run.taskId??run.key}>
    <header className="dsh-worker-header"><strong>{run.capability??'Worker'}</strong><span>{status}</span></header>
    <div className="dsh-worker-meta">{run.taskId&&<code>{run.taskId}</code>}{run.model&&<span>模型：{run.model}</span>}</div>
    {run.messages.length>0&&<details className="dsh-worker-input"><summary>任务输入</summary><pre>{JSON.stringify(run.messages,null,2)}</pre></details>}
    {speaker?<p className="dsh-worker-note">面前说话人识别（模拟数据）。人物卡片在输出面板显示，再次点击圆形按钮关闭。</p>:subtitle?<p className="dsh-worker-note">实时字幕任务。持续输出在交互窗口显示。</p>:blocks.length>0?<Assistant node={{blocks}} streaming={run.status==='starting'||run.status==='running'}/>:!run.error&&<p className="dsh-worker-note">{run.status==='starting'||run.status==='running'?'等待模型输出…':'暂无模型输出。'}</p>}
    {run.error&&<p className="dsh-worker-error" role="alert">执行失败：{run.error}</p>}
    {run.task?.result?.reason&&<p className="dsh-worker-note">结束原因：{run.task.result.reason}</p>}
  </article>;
}
function Workers({events = [],tasks = []}) {
  const runs = useMemo(()=>projectWorkers(events,tasks),[events,tasks]);
  return <div className="dsh-workers">{runs.length?runs.map(run=><WorkerRun key={run.key} run={run}/>):<p className="dsh-empty">暂无任务。</p>}</div>;
}

const roots=new WeakMap();
function render(container,Component,props){mountIconSprite();let root=roots.get(container);if(!root){root=createRoot(container);roots.set(container,root);}root.render(<Component {...props}/>);}
window.MootingDSHViews={renderConversation:(container,props)=>render(container,Conversation,props),renderWorkers:(container,props)=>render(container,Workers,props),renderTrajectory:(container,props)=>render(container,Trajectory,props),projectEvents,projectWorkers,dispose(container){roots.get(container)?.unmount();roots.delete(container);}};
