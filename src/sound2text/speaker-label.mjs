/** Display name for one ASR speaker id. A matched voiceprint arrives as its registered name. */
export function speakerLabel(id) {
  const raw = String(id ?? '').trim();
  if (!raw) return '说话人 1';
  const numbered = /^(?:speaker[_-]?)?(\d+)$/iu.exec(raw);
  if (!numbered) return raw;
  const value = Number(numbered[1]);
  return `说话人 ${value >= 1 ? value : 1}`;
}

export function readSpeakerId(utterance) {
  const additions = utterance?.additions && typeof utterance.additions === 'object' ? utterance.additions : {};
  const candidates = [utterance?.speaker_id, utterance?.speaker, additions.speaker_id, additions.speaker];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Stable speaker id from ASR. Empty when the utterance has no speaker attribution. */
export function readSpeakerKey(utterance) {
  const raw = readSpeakerId(utterance);
  return raw || '';
}

/** One spoken sentence. The label is the speaker; the text after the colon is what was said. */
export function speakerLine(label, text) {
  const body = String(text ?? '').trim();
  if (!body) return '';
  return `${label || '说话人 1'}：${body}`;
}
