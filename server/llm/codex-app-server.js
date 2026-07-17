import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { PROGRAM_OUTPUT_SCHEMA } from './normalize.js';

const BASE_INSTRUCTIONS = `你是 Claudio 个人电台的 DJ 大脑。只完成用户输入中描述的电台编排任务。
不得调用工具、联网、读写文件或执行命令。严格按 output schema 输出 JSON，不要 markdown。`;

const DEVELOPER_INSTRUCTIONS = `优先速度与自然感。say 必须先写、中文口语、1至2句、60字内。
自动推荐要优先挖掘贴合口味的小众作品，不要拿收藏原曲或热门榜单敷衍；play 给最多3个高质量候选供程序过滤。
先判断 chat / recommend / control；聊天必须 play=[]，只有 recommend 才能给歌，control 必须给真实可执行 action。
只有用户话语提供了新证据时才写 memoryCandidates，不得把 DJ 自己的话当记忆。`;

function errorMessage(error) {
  if (!error) return '未知错误';
  return typeof error === 'string' ? error : error.message || JSON.stringify(error);
}

export class CodexAppServer {
  constructor({
    spawnFn = spawn,
    bin = 'codex',
    cwd = config.paths.root,
    requestTimeout = 10000,
    onEvent = null,
  } = {}) {
    this.spawnFn = spawnFn;
    this.bin = bin;
    this.cwd = cwd;
    this.requestTimeout = requestTimeout;
    this.onEvent = onEvent;
    this.child = null;
    this.startPromise = null;
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.pending = new Map();
    this.turns = new Map();
  }

  async start() {
    if (this.child) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startProcess();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  async #startProcess() {
    const child = this.spawnFn(this.bin, [
      'app-server',
      '--listen', 'stdio://',
      '-c', 'mcp_servers={}',
    ], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-2000); });
    child.on('error', (error) => this.#onExit(error));
    child.on('close', (code) => {
      if (this.child === child) this.#onExit(new Error(`Codex app-server 已退出 (${code}): ${this.stderr.slice(-300)}`));
    });

    await this.#request('initialize', {
      clientInfo: { name: 'claudio', title: 'Claudio', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.#notify('initialized', {});
  }

  #onData(chunk) {
    this.buffer += chunk.toString();
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this.#onMessage(message);
    }
  }

  #onMessage(message) {
    try { this.onEvent?.({ direction: 'in', message }); } catch {}
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(errorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }

    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id;
    const threadId = params.threadId;
    if (!turnId || !threadId) return;
    const turn = this.turns.get(`${threadId}:${turnId}`);
    if (!turn) return;

    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      turn.text += params.delta;
      try { turn.onText?.(turn.text); } catch {}
      return;
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const finalText = params.item.text || params.item.content;
      if (typeof finalText === 'string' && finalText) turn.finalText = finalText;
      return;
    }
    if (message.method === 'turn/completed') {
      this.#finishTurn(threadId, turnId, null, turn.finalText || turn.text);
    }
  }

  #notify(method, params) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server 尚未启动');
    const message = { method, params };
    try { this.onEvent?.({ direction: 'out', message }); } catch {}
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method, params, timeout = this.requestTimeout) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Codex app-server 尚未启动'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 超时`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      try { this.onEvent?.({ direction: 'out', message }); } catch {}
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  #finishTurn(threadId, turnId, error, text = '') {
    const key = `${threadId}:${turnId}`;
    const turn = this.turns.get(key);
    if (!turn) return;
    this.turns.delete(key);
    clearTimeout(turn.timer);
    if (error) turn.reject(error);
    else if (!text) turn.reject(new Error('ChatGPT 返回空内容'));
    else turn.resolve(text);
  }

  async generate(prompt, {
    model = 'gpt-5.6-luna',
    effort = 'low',
    onText,
    timeout = 20000,
  } = {}) {
    await this.start();
    const threadResponse = await this.#request('thread/start', {
      model,
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      serviceTier: 'priority',
      baseInstructions: BASE_INSTRUCTIONS,
      developerInstructions: DEVELOPER_INSTRUCTIONS,
    });
    const threadId = threadResponse?.thread?.id;
    if (!threadId) throw new Error('Codex thread/start 未返回 thread id');

    const turnResponse = await this.#request('turn/start', {
      threadId,
      effort,
      input: [{ type: 'text', text: String(prompt) }],
      outputSchema: PROGRAM_OUTPUT_SCHEMA,
    });
    const turnId = turnResponse?.turn?.id;
    if (!turnId) throw new Error('Codex turn/start 未返回 turn id');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { this.#request('turn/interrupt', { threadId, turnId }, 1000).catch(() => {}); } catch {}
        this.#finishTurn(threadId, turnId, new Error('ChatGPT 生成超时'));
      }, timeout);
      this.turns.set(`${threadId}:${turnId}`, {
        resolve, reject, timer, onText, text: '', finalText: '',
      });
    });
  }

  #onExit(error) {
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [key, turn] of this.turns) {
      clearTimeout(turn.timer);
      turn.reject(error);
      this.turns.delete(key);
    }
  }

  close() {
    const child = this.child;
    this.child = null;
    try { child?.stdin?.end(); } catch {}
    try { child?.kill(); } catch {}
  }
}

export const codexAppServer = new CodexAppServer();
