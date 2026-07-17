// macOS `say` 本地 TTS（开发期默认占位）：离线、零依赖、免费、中文嗓音多。
// 输出 wav（浏览器 <audio> 普遍支持）。仅 macOS 可用。
// 可用中文嗓音示例：Tingting(婷婷) / Meijia(美佳) / Sinji(善怡)。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

export const ext = 'wav';

export async function synthesize(text) {
  const voice = config.tts.say.voice;
  const tmp = path.join(os.tmpdir(), `claudio-say-${process.pid}-${crypto.randomUUID()}.wav`); // 随机量防同毫秒并发撞名写坏

  await new Promise((resolve, reject) => {
    const args = ['-o', tmp, '--file-format=WAVE', '--data-format=LEI16@24000'];
    if (voice) args.push('-v', voice);
    args.push(text);

    const child = spawn('say', args);
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`say exit ${code}: ${err}`)),
    );
  });

  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return buf;
}
