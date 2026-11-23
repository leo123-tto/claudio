// 驾驶模式：听众在开车（开着导航），DJ 口播只说一句，不抢导航的声音。
// 网页的「驾驶模式」开关告诉服务端；个人版后台备节目用这里记的状态，公用版每次点歌带着 drive。

export const DRIVE_PROMPT = '## 驾驶模式\n听众正在开车、开着导航：口播只说一句，20 字以内，不要第二句，不要问问题；控制确认 10 字内。';

// 留第一句；一句也太长就在逗号处截；都没有就按字数截。空的原样回。
export function oneSentence(text, max = 30) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  const first = clean.match(/^[\s\S]*?[。！？!?…]+/)?.[0] || clean;
  if (first.length <= max) return first.trim();
  const cut = first.slice(0, max);
  const comma = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf(','), cut.lastIndexOf('；'));
  return (comma >= 8 ? cut.slice(0, comma) : cut).trim() + '。';
}

// 网页开着驾驶模式时每隔一会儿报一次；关网页没报「关」的，过了 ttl 自己失效，免得回家后口播还一直短。
export function createDriveState({ ttlMs = 2 * 3600_000, now = () => Date.now() } = {}) {
  let until = 0;
  return {
    on: () => until > now(),
    // 回 true 表示开关变了
    set(on) {
      const before = until > now();
      until = on ? now() + ttlMs : 0;
      return before !== Boolean(on);
    },
  };
}
