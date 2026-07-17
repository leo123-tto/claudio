// 集中配置：读 .env / .env.local（不存在则用默认值）。所有模块从这里取配置。
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..');
const resourceRoot = path.resolve(process.env.CLAUDIO_RESOURCE_ROOT || sourceRoot);
const dataRoot = path.resolve(process.env.CLAUDIO_DATA_DIR || resourceRoot);

// 开发态继续读项目根目录；桌面 App 则只从用户 Application Support 读私有配置。
dotenv.config({ path: path.join(resourceRoot, '.env') });
dotenv.config({ path: path.join(resourceRoot, '.env.local'), override: true });
if (dataRoot !== resourceRoot) {
  dotenv.config({ path: path.join(dataRoot, '.env'), override: true });
  dotenv.config({ path: path.join(dataRoot, '.env.local'), override: true });
}
const env = process.env;

export function resolvePaths({ resourceRoot: resources, dataRoot: data }) {
  const root = path.resolve(resources);
  const writable = path.resolve(data);
  const cache = path.join(writable, 'cache');
  return {
    root,
    dataRoot: writable,
    web: path.join(root, 'web'),
    user: path.join(writable, 'user'),
    prompts: path.join(root, 'prompts'),
    cache,
    cacheTts: path.join(cache, 'tts'),
    logs: path.join(cache, 'logs'),
    state: path.join(cache, 'state.json'),
  };
}

const paths = resolvePaths({ resourceRoot, dataRoot });

export const config = {
  port: Number(env.PORT ?? 8080),

  ncm: {
    base: env.NCM_BASE ?? 'http://localhost:3000',
    cookie: env.NCM_COOKIE ?? '',
    level: env.NCM_LEVEL ?? 'exhigh', // standard/higher/exhigh(320k)/lossless/hires；无损需会员
  },

  llm: {
    provider: env.LLM_PROVIDER ?? 'claude', // claude | deepseek
    deepseek: {
      apiKey: env.DEEPSEEK_API_KEY ?? '',
      baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      model: env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      maxTokens: Number(env.DEEPSEEK_MAX_TOKENS ?? 1200),
      temperature: Number(env.DEEPSEEK_TEMPERATURE ?? 0.7),
      thinking: env.DEEPSEEK_THINKING ?? 'disabled', // enabled | disabled
    },
  },

  claude: {
    bin: env.CLAUDE_BIN ?? 'claude',
    model: env.CLAUDE_MODEL ?? 'sonnet', // 口播选歌用 sonnet 足够且快
    // 关键提速：默认关掉扩展思考。Claude Code 默认会让模型先「想」一分钟再开口（实测 TTFT 62s→6.8s）；
    // 写口播 + 选歌是创意/查表任务，不需要深度推理。想要更「用心」的编排可在 .env 设 CLAUDE_MAX_THINKING_TOKENS=2000 之类。
    maxThinkingTokens: env.CLAUDE_MAX_THINKING_TOKENS ?? '0',
    // 禁用工具：DJ 生成器不该联网/读写，禁掉防偶发多轮把延迟拖到几十秒
    disallowedTools: ['WebSearch', 'WebFetch', 'Bash', 'Task', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'],
  },

  tts: {
    provider: env.TTS_PROVIDER ?? 'fish', // 默认 Fish；绝不自动回退到 macOS say
    say: {
      voice: env.SAY_VOICE ?? 'Tingting',
    },
    fish: {
      apiKey: env.FISH_API_KEY ?? '',
      referenceId: env.FISH_REFERENCE_ID ?? '', // 默认/兜底音色
      voiceZh: env.FISH_VOICE_ZH ?? '', // 中文口播音色
      voiceEn: env.FISH_VOICE_EN ?? '', // 英文口播音色
      model: env.FISH_MODEL ?? 's1', // Fish TTS：s1（更快，实测同句快 ~35%）/ s2-pro（音质略好但慢）。默认 s1 求低延迟，想要更好音色可在 .env 设 FISH_MODEL=s2-pro
    },
  },

  weather: {
    city: env.WEATHER_CITY ?? '', // 留空 = 按本机出口 IP 自动定位
  },

  // 节律调度：默认关闭，只手动触发（用户定）。SCHEDULER_ENABLED=1 才开 07:00 规划 / 09:00 早间 / 整点情绪。
  scheduler: {
    enabled: env.SCHEDULER_ENABLED === '1',
  },

  paths: {
    ...paths,
  },
};
