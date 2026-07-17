import { classifyDirectControl } from './intent.js';

// 短而明确的播放器指令直连前端播放层，几乎立即响应；其余自然语言交给模型做
// chat / recommend / control 三分判断，避免宽泛关键词误伤普通对话。
export function route(input = '') {
  const userInput = String(input).trim();
  return { userInput, control: classifyDirectControl(userInput) };
}
