import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { normalizeAlias } from './rooms.js';

export function createRoomStore(file) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }
  return {
    read,
    set(id, alias) {
      const key = String(id || '');
      if (!key || key.length > 200) throw new Error('没有这台设备');
      const all = read();
      const name = normalizeAlias(alias);
      if (name) all[key] = name;
      else delete all[key];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all));
      return all;
    },
  };
}

export const roomStore = createRoomStore(path.join(config.paths.cache, 'rooms.json'));
