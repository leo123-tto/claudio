// DJ 人格（Vera）：两版共用同一个人格核心 prompts/vera.md（不含任何听众的个人信息）。
// 人格正文放在提示词最前面（不变，好命中缓存），「此刻用哪一面」随时段放在后面。
// 个人版另读数据目录 user/persona.md 追加在核心后面（听众本人的背景等，不进仓库）；公用版不读它。
// 追加文件开头可写 ---\nclosing: 每晚的结束语\n---，睡前最后一段用它收尾。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const DJ_NAME = 'Vera';
export const DEFAULT_CLOSING = '今天就到这儿。灯我帮你留着，晚安。';

const DEFAULT_FILE = path.join(config.paths.prompts, 'vera.md');

function parse(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const closing = match?.[1].match(/^closing\s*:\s*(.+)$/m)?.[1]?.trim() || '';
  return { body: (match ? raw.slice(match[0].length) : raw).trim(), closing };
}

export function loadPersona({ file = path.join(config.paths.user, 'persona.md'), core = DEFAULT_FILE } = {}) {
  let body = '';
  try { body = parse(fs.readFileSync(core, 'utf8')).body; } catch { /* 用下面的一句话兜底 */ }
  if (!body) body = `你是 ${DJ_NAME}，Claudio 电台的 DJ。`;
  let closing = '';
  if (file) {
    try {
      const extra = parse(fs.readFileSync(file, 'utf8'));
      if (extra.body) body = `${body}\n\n${extra.body}`;
      closing = extra.closing;
    } catch { /* 没有追加文件 */ }
  }
  return { body, closing: closing || DEFAULT_CLOSING };
}

const CASUAL = /随便放|随便来|随便听|随便吧|随便挑/;

// 此刻用哪一面：晚上、深夜是守夜人；周末白天或听众说「随便放」是策展人；其余是老朋友。驾驶模式只管简短，按老朋友。
export function personaMode({ toneKey, now = new Date(), text = '' }) {
  if (toneKey === 'night' || toneKey === 'late') return 'night';
  if (CASUAL.test(String(text || ''))) return 'curator';
  const day = now.getDay();
  if ((day === 0 || day === 6) && toneKey !== 'drive') return 'curator';
  return 'friend';
}

const MODE_TEXT = {
  friend: '此刻是平时的你：有反差的老朋友。',
  night: '此刻是晚上和深夜的你：守夜人，话少、先听后答。',
  curator: '此刻是策展人的你：给这一段定个小主题，留一首冒险曲并说清为什么推它。',
};

export function personaNow(mode, { closing = '' } = {}) {
  return [`## 此刻的 ${DJ_NAME}`, MODE_TEXT[mode] || MODE_TEXT.friend,
    closing ? `这是今晚最后一段：话说完后，用这句结束语收尾，一字不改：「${closing}」` : '',
  ].filter(Boolean).join('\n');
}
