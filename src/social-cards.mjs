import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkSpeakerName } from './sound2text/voiceprints.mjs';

export const SOCIAL_CARD_PRIORITIES = Object.freeze({ confirm: 30, view: 20 });
export const SOCIAL_CARD_STATES = Object.freeze(['queued', 'active', 'closed']);
const FIELD_LIMIT = 200;

async function writePrivate(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readCards(path) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error.name === 'SyntaxError') return []; throw error; }
  const items = Array.isArray(value) ? value : value?.cards;
  return Array.isArray(items) ? items : [];
}

function textField(value) {
  const text = String(value ?? '').trim();
  return Array.from(text).length > FIELD_LIMIT ? Array.from(text).slice(0, FIELD_LIMIT).join('') : text;
}

function mbtiField(value) {
  const text = textField(value).toUpperCase();
  const match = /^([EI][NS][FT][JP])$/.exec(text);
  return match ? match[1] : textField(value);
}

function normalizeFields(fields = {}) {
  return {
    name: checkSpeakerName(fields.name),
    position: textField(fields.position),
    company: textField(fields.company),
    school: textField(fields.school),
    mbti: mbtiField(fields.mbti),
    topic: textField(fields.topic),
  };
}

export function personOf(card) {
  if (!card) return null;
  return {
    name: card.name, position: card.position ?? '', company: card.company ?? '', school: card.school ?? '',
    mbti: card.mbti ?? '', topic: card.topic ?? '', savedAt: card.savedAt ?? '',
    notes: [card.position, card.company, card.school, card.mbti, card.topic, card.savedAt ? `保存于 ${card.savedAt}` : ''].filter(Boolean),
  };
}

/** Local social-card archive. One card per saved speaker; names are unique. */
export class SocialCardStore extends EventEmitter {
  constructor({ dataRoot, filename = 'social-cards.json', now = () => Date.now() } = {}) {
    super();
    if (!dataRoot) throw new Error('社交卡片需要数据目录');
    this.dataRoot = dataRoot;
    this.path = join(dataRoot, filename);
    this.now = now;
    this.cards = [];
    this.writes = Promise.resolve();
    this.ready = this.load();
  }
  async load() {
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const rows = await readCards(this.path);
    this.cards = rows.filter(row => row && typeof row.speakerKey === 'string' && typeof row.name === 'string').map(row => ({
      speakerKey: row.speakerKey, name: row.name,
      position: row.position ?? '', company: row.company ?? '', school: row.school ?? '', mbti: row.mbti ?? '', topic: row.topic ?? '',
      savedAt: row.savedAt ?? '', voiceprintId: row.voiceprintId ?? '', lastSeenAt: row.lastSeenAt ?? null,
    }));
    this.emitChange();
  }
  emitChange() { this.emit('change'); }
  persist() {
    const text = JSON.stringify({ cards: this.cards }, null, 2) + '\n';
    const run = this.writes.then(() => writePrivate(this.path, text));
    this.writes = run.catch(() => {});
    return run;
  }
  list() { return this.cards.map(card => structuredClone(card)); }
  byName(name) { const value = String(name ?? '').trim(); return this.cards.find(card => card.name === value) ?? null; }
  byVoiceprint(id) { const value = String(id ?? '').trim(); return this.cards.find(card => card.voiceprintId === value) ?? null; }
  bySpeaker(key) { const value = String(key ?? '').trim(); return this.cards.find(card => card.speakerKey === value) ?? null; }
  async create(fields, voiceprintId = '') {
    const value = normalizeFields(fields);
    if (this.byName(value.name)) { const error = new Error('这个名字已有卡片，请改名或不保存'); error.status = 409; throw error; }
    const card = { speakerKey: randomUUID(), ...value, savedAt: new Date(this.now()).toISOString(), voiceprintId: String(voiceprintId ?? ''), lastSeenAt: this.now() };
    this.cards.push(card);
    await this.persist();
    this.emitChange();
    return structuredClone(card);
  }
  async update(speakerKey, fields) {
    const card = this.cards.find(item => item.speakerKey === speakerKey);
    if (!card) return null;
    const next = { ...card };
    for (const key of ['name', 'position', 'company', 'school', 'mbti', 'topic']) {
      if (fields[key] === undefined) continue;
      const value = key === 'name' ? checkSpeakerName(fields[key]) : key === 'mbti' ? mbtiField(fields[key]) : textField(fields[key]);
      if (key === 'name') {
        const existing = this.byName(value);
        if (existing && existing.speakerKey !== speakerKey) continue;
      }
      next[key] = value;
    }
    Object.assign(card, next);
    await this.persist();
    this.emitChange();
    return structuredClone(card);
  }
  async markSeen(speakerKey, at = this.now()) {
    const card = this.cards.find(item => item.speakerKey === speakerKey);
    if (!card) return null;
    card.lastSeenAt = at;
    await this.persist();
    this.emitChange();
    return structuredClone(card);
  }
  async remove(speakerKey) {
    const index = this.cards.findIndex(item => item.speakerKey === speakerKey);
    if (index === -1) return null;
    const [card] = this.cards.splice(index, 1);
    await this.persist();
    this.emitChange();
    return structuredClone(card);
  }
}

/** Function-panel queue for social cards. One active card; no suspended state. */
export class SocialCardQueue extends EventEmitter {
  constructor({ onChange = () => {} } = {}) {
    super();
    this.onChange = onChange;
    this.cards = [];
    this.activeId = null;
    this.tail = Promise.resolve();
  }
  enqueue(op) {
    const job = this.tail.then(op, op);
    this.tail = job.then(() => {}, () => {});
    return job;
  }
  emitChange() { this.onChange(); this.emit('change'); }
  active() { return this.cards.find(card => card.id === this.activeId && card.state === 'active') ?? null; }
  pendingCount() { return this.cards.filter(card => card.state !== 'closed').length; }
  activeConfirm() { const card = this.active(); return card?.kind === 'confirm' ? card : null; }
  findView(speakerKey) { return this.cards.find(card => card.kind === 'view' && card.speakerKey === speakerKey && card.state !== 'closed') ?? null; }
  push(card) {
    return this.enqueue(() => {
      const entry = { id: randomUUID(), state: 'queued', ...card };
      this.cards.push(entry);
      this.promote();
      this.emitChange();
      return entry;
    });
  }
  promote() {
    if (this.active()) return;
    const waiting = this.cards.filter(card => card.state === 'queued');
    if (!waiting.length) { this.activeId = null; return; }
    waiting.sort((left, right) => right.priority - left.priority);
    const next = waiting[0];
    next.state = 'active';
    this.activeId = next.id;
  }
  closeActive({ interrupt = false } = {}) {
    return this.enqueue(() => {
      const card = this.active();
      if (!card) return { closed: false };
      if (card.kind === 'confirm' && !interrupt) { const error = new Error('请先保存或不保存这张社交卡片'); error.status = 409; throw error; }
      card.state = 'closed';
      this.activeId = null;
      this.promote();
      this.emitChange();
      return { closed: true, card };
    });
  }
  async resolveActive(save) {
    return this.enqueue(async () => {
      const card = this.activeConfirm();
      if (!card) { const error = new Error('当前没有待保存的社交卡片'); error.status = 409; throw error; }
      const result = await save(card);
      card.state = 'closed';
      this.activeId = null;
      this.promote();
      this.emitChange();
      return result;
    });
  }
  async removeWhere(match) {
    return this.enqueue(() => {
      let removed = 0;
      for (const card of this.cards) {
        if (card.state === 'closed' || !match(card)) continue;
        card.state = 'closed';
        removed += 1;
      }
      if (!this.active()) { this.activeId = null; this.promote(); }
      if (removed) this.emitChange();
      return removed;
    });
  }
  async idle() { await this.tail; }
  async dispose() {
    await this.enqueue(() => {
      for (const card of this.cards) if (card.state !== 'closed') card.state = 'closed';
      this.activeId = null;
      this.emitChange();
    });
    await this.idle();
  }
}
