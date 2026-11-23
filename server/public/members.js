// 公用版每个人的本地数据：data/members/<memberId>/{ncm.enc, memory.json}
//
// - 网易云 cookie 用 AES-256-GCM 加密，密钥只从环境变量 PUBLIC_VAULT_KEY 来（不和数据放一起）。
// - 临时记忆：偏好几句、最近放过的歌、最近听过（100 首，网页能点回去）、红心、最近几轮对话、口味抽样。30 天没用自动删；朋友能自己清空。
// - 停用 / 到期 / 删除（hub 说的）或解绑时，整块删掉。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^mem_[0-9a-f]{8}$/;
export const MEMORY_IDLE_MS = 30 * 24 * 3600_000;
export const HISTORY_MAX = 100;

export function parseVaultKey(raw) {
  const text = String(raw || '').trim();
  const buf = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (buf.length !== 32) throw new Error('PUBLIC_VAULT_KEY 必须是 32 字节（64 位十六进制或 base64）');
  return buf;
}

export function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(key, packed) {
  const buf = Buffer.from(String(packed), 'base64');
  if (buf[0] !== 1) throw new Error('unknown vault format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13));
  decipher.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString('utf8');
}

function emptyMemory() {
  return { prefs: [], recent: [], history: [], hearts: [], turns: [], taste: null, account: null, lastActive: 0 };
}

export function createMemberStore({ root, vaultKey, now = () => Date.now() }) {
  const dir = (id) => {
    if (!ID_RE.test(String(id))) throw new Error('bad member id');
    return path.join(root, id);
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  function memory(id) {
    try {
      return { ...emptyMemory(), ...JSON.parse(fs.readFileSync(path.join(dir(id), 'memory.json'), 'utf8')) };
    } catch {
      return emptyMemory();
    }
  }

  function saveMemory(id, mem) {
    const clean = {
      ...mem,
      prefs: (mem.prefs || []).slice(-20),
      recent: (mem.recent || []).slice(-40),
      history: (mem.history || []).slice(0, HISTORY_MAX),
      turns: (mem.turns || []).slice(-6),
      lastActive: now(),
    };
    write(path.join(dir(id), 'memory.json'), JSON.stringify(clean));
    return clean;
  }

  function clearMemory(id) {
    fs.rmSync(path.join(dir(id), 'memory.json'), { force: true });
  }

  function setCookie(id, cookie) {
    write(path.join(dir(id), 'ncm.enc'), encrypt(vaultKey, cookie));
  }

  function getCookie(id) {
    try {
      return decrypt(vaultKey, fs.readFileSync(path.join(dir(id), 'ncm.enc'), 'utf8'));
    } catch {
      return '';
    }
  }

  function unbind(id) {
    fs.rmSync(path.join(dir(id), 'ncm.enc'), { force: true });
    const mem = memory(id);
    if (mem.account || mem.taste) saveMemory(id, { ...mem, account: null, taste: null });
  }

  function bound(id) {
    return fs.existsSync(path.join(dir(id), 'ncm.enc'));
  }

  function purge(id) {
    fs.rmSync(dir(id), { recursive: true, force: true });
  }

  function ids() {
    try {
      return fs.readdirSync(root).filter((name) => ID_RE.test(name));
    } catch {
      return [];
    }
  }

  // hub 给的状态表：不在表里或不是 active 的整块删；30 天没用的只删临时记忆（cookie 跟着成员有效期走）
  function sweep(states) {
    const active = new Set(states.filter((s) => s.status === 'active').map((s) => s.id));
    const removed = [];
    for (const id of ids()) {
      if (!active.has(id)) { purge(id); removed.push(id); continue; }
      const mem = memory(id);
      if (mem.lastActive && now() - mem.lastActive > MEMORY_IDLE_MS) clearMemory(id);
    }
    return removed;
  }

  return { memory, saveMemory, clearMemory, setCookie, getCookie, unbind, bound, purge, ids, sweep };
}
