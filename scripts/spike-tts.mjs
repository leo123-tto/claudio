// spike：验证 TTS 能合成出音频（默认 say 本地；TTS_PROVIDER=fish 测 Fish）。
// 用法：[TTS_PROVIDER=fish] node scripts/spike-tts.mjs ["要念的话"]
import fs from 'node:fs';
import { synthesize } from '../server/tts/index.js';

const text = process.argv[2] ?? '你好，我是 Claudio，这是一次声音测试。';
console.log('provider =', process.env.TTS_PROVIDER ?? 'say (默认)');

try {
  const r = await synthesize(text);
  const size = fs.statSync(r.file).size;
  console.log(`✅ 合成成功：${r.url}`);
  console.log(`   文件：${r.file}（${size} bytes，cached=${r.cached}）`);
  if (size < 1000) console.log('⚠️ 文件偏小，可能没合成出有效音频，检查 voice / 网络');
} catch (e) {
  console.log('❌ 合成失败：', e.message);
  console.log((e.stack ?? '').split('\n').slice(0, 5).join('\n'));
}
