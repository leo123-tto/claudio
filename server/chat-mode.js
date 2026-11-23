// 聊天模式（事项 24）：两版共用的纯逻辑。
// 听众在跟 Vera 聊天、歌在背景压低。服务端不存「在不在聊天」，只认每次请求带的 chatMode。
// - 提示词：多轮对话 + 聊天规则，放在提示词末尾（前面的大块不变，好命中盒子的前缀缓存）。
// - 换歌时机由程序定，不靠大脑自觉：听众这句明确要歌才马上换（now）；
//   没要歌、是 Vera 自己想推的，排在当前这首后面（next），不打断这首。
import { styleConstraints } from './style-request.js';

const MUSIC_ASK = /(播放|播一下|放一下|放首|放一首|放点|放几首|来一首|来首|来点|来几首|来段|想听|要听|听听|听点|听首|换首|换一首|换个|换成|换一批|换歌|切歌|切到|推荐|下一首|点首|点一首|\bplay\b)/i;
// 句首的「放」「播」：放周杰伦的晴天、播陈奕迅（放松、放心、放假这类不算）
const LEADING_PLAY = /^(请|帮我|给我)?(放|播)(?![松心假弃下学工空])/;

// 这句话是不是在要歌（要马上换）
export function askedForMusic(text = '') {
  const value = String(text || '').trim();
  if (!value) return false;
  if (styleConstraints(value).length) return true;
  if (/《[^》]+》/.test(value)) return true;
  return MUSIC_ASK.test(value) || LEADING_PLAY.test(value);
}

// 推荐什么时候放：不在聊天模式 / 不是推荐 → null（照旧马上换）；聊天模式里没要歌就排到下一首
export function chatWhen({ chatMode = false, intent = '', userInput = '' } = {}) {
  if (!chatMode || intent !== 'recommend') return null;
  return askedForMusic(userInput) ? 'now' : 'next';
}

// 最近几轮对话（旧 → 新），给大脑接着聊。messages：[{role:'user'|'claudio'|..., content}]
export function recentTurnsText(messages = [], { turns = 8, name = 'Vera', max = 120 } = {}) {
  const lines = (messages || [])
    .filter((item) => item && (item.role === 'user' || item.role === 'claudio') && String(item.content || '').trim())
    .slice(-turns * 2)
    .map((item) => `${item.role === 'user' ? '听众' : name}：${String(item.content).replace(/\s+/g, ' ').trim().slice(0, max)}`);
  return lines.length ? lines.join('\n') : '';
}

// 聊天模式的规则（覆盖输出契约里 say 的字数）。drive：驾驶模式只说一句。
export function chatModeRules({ drive = false } = {}) {
  return `## 聊天模式（听众在跟你聊天，歌在背景压低，这一段覆盖前面关于 say 字数和推歌的要求）
- 先接话：大多数时候 intent=chat、play=[]，让当前的歌继续。像朋友聊天，${drive ? '只说一句，越短越好。' : 'say 1 到 3 句、10 到 60 字，可以很短（比如「嗯，我在听。」）。'}
- 不聊也行：对方明显不需要回应（只是「嗯」「好」「哈哈」），say 可以是 ""。
- 接着上面的对话聊，别重复问过的问题，别每句都扯到歌。
- 没给歌（play=[]）就别许诺「待会儿 / 这首完了给你接…」：说了要接就得真给歌。
- 想到合适的歌、听众又没开口要：intent=recommend 照常给候选，程序会等这首放完再接，say 可以说「这首完了给你接…」。
- 听众明确要歌（点了歌名、歌手、风格，或说换一首）：程序马上换，say 直接说放什么，不要说「先让这首放完」「收个尾」。`;
}
