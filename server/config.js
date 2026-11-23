// 集中配置：读 .env / .env.local（不存在则用默认值）。所有模块从这里取配置。
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..');
const resourceRoot = path.resolve(process.env.CLAUDIO_RESOURCE_ROOT || sourceRoot);
const dataRoot = path.resolve(process.env.CLAUDIO_DATA_DIR || resourceRoot);

// 开发态读项目根目录；容器（盒子）用 CLAUDIO_DATA_DIR=/data 另放私有配置和数据。
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
  // 留空 = 监听所有网卡（Mac 默认）。放到盒子上设 127.0.0.1，只经 Tailscale serve 对外。
  host: env.HOST || '',
  // 小智点歌额外放行的来源，逗号分隔。经 serve 转发进来的按真实来源（X-Forwarded-For）判断。
  remoteAllow: String(env.REMOTE_ALLOW || '').split(',').map((item) => item.trim()).filter(Boolean),
  episodeBuffer: Math.max(1, Number(env.EPISODE_BUFFER) || 2),

  ncm: {
    base: env.NCM_BASE ?? 'http://localhost:3000',
    cookie: env.NCM_COOKIE ?? '',
    level: env.NCM_LEVEL ?? 'exhigh', // standard/higher/exhigh(320k)/lossless/hires；无损需会员
    // 后台 / 垫场 / 发现池的搜索至少隔这么久一次；点歌不排队。成串搜索会被网易云回 405。
    searchGapMs: Number(env.NCM_SEARCH_GAP_MS ?? (env.NODE_TEST_CONTEXT ? 0 : 1500)),
    searchPerMin: Number(env.NCM_SEARCH_PER_MIN ?? (env.NODE_TEST_CONTEXT ? 0 : 6)),
    // 盒子上几个实例共用名额（server/ncm-shared.js）：老板实例填 NCM_SHARED_SERVE，别的实例填 NCM_SHARED_URL。
    sharedServe: env.NODE_TEST_CONTEXT ? '' : env.NCM_SHARED_SERVE ?? '',
    sharedUrl: env.NODE_TEST_CONTEXT ? '' : env.NCM_SHARED_URL ?? '',
    sharedReserve: Number(env.NCM_SHARED_RESERVE ?? 2),
  },

  // 备用音源插件（server/sources.js）：网易云拿不到时去别的平台找同一首。插件不进仓库，目录里没有就不启用。
  sources: {
    pluginDir: env.SOURCE_PLUGIN_DIR ?? (env.NODE_TEST_CONTEXT ? '' : path.join(paths.dataRoot, 'plugins')),
    // 每个源单独算：任意 60 秒内的搜索数、相邻间隔；别的实例（公用版）最多用到 perMin − reserve
    searchPerMin: Number(env.SOURCE_SEARCH_PER_MIN ?? 10),
    searchGapMs: Number(env.SOURCE_SEARCH_GAP_MS ?? (env.NODE_TEST_CONTEXT ? 0 : 1000)),
    guestReserve: Number(env.SOURCE_GUEST_RESERVE ?? 3),
  },

  llm: {
    deepseek: {
      apiKey: env.DEEPSEEK_API_KEY ?? '',
      baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      model: env.DEEPSEEK_MODEL ?? 'deepseek-flash',
      maxTokens: Number(env.DEEPSEEK_MAX_TOKENS ?? 1600),
      temperature: Number(env.DEEPSEEK_TEMPERATURE ?? 0.7),
      thinking: env.DEEPSEEK_THINKING ?? 'disabled', // enabled | disabled
    },
    local: {
      apiKey: env.LOCAL_LLM_API_KEY ?? '',
      baseUrl: env.LOCAL_LLM_BASE_URL ?? 'http://127.0.0.1:8001/v1', // 本机 / 局域网的 OpenAI 兼容服务；真实地址写 .env
      model: env.LOCAL_LLM_MODEL ?? 'DeepSeek-V4.1-Flash-1017',
    },
  },

  claude: {
    bin: env.CLAUDE_BIN ?? 'claude',
    model: env.CLAUDE_MODEL ?? 'sonnet', // 口播选歌用 sonnet 足够；haiku 实测反而更慢
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
    // 5090 台式机上的 Fish S2-Pro。主机名和地址都在 .env 里配（见 .env.example），代码里不写死。
    // 配了 tunnelHost 就经它开 ssh 隧道到 WSL 上的服务（tunnelTarget）；
    // tunnelHost 留空就直连 baseUrl。sshHost 用来叫 gpuctl 拉起语音档，经 jumpHost 跳过去。
    // 装在 5090 的 Windows 上时 gpuctl 设成 wsl：直接 wsl.exe 调，不用 ssh。
    pc5090: {
      baseUrl: env.PC5090_TTS_BASE_URL ?? 'http://127.0.0.1:18081',
      voice: env.PC5090_TTS_VOICE ?? 'claudio',
      tunnelHost: env.PC5090_TUNNEL_HOST ?? '',
      tunnelTarget: env.PC5090_TUNNEL_TARGET ?? '',
      sshHost: env.PC5090_SSH_HOST ?? '',
      jumpHost: env.PC5090_JUMP_HOST ?? '',
      gpuctl: env.PC5090_GPUCTL === 'wsl' ? 'wsl' : 'ssh',
      // 旧盒子那把切档钥匙只放行 --who/--what/--for/--wait，不认 --no-preempt；设 0 就不带。
      // 不带也不会抢卡：别人在用时 gpuctl 照样排队，--wait 10 秒后带 [arbiter] 退出。
      noPreempt: env.PC5090_NO_PREEMPT !== '0',
      // 2026-11-22 老板听样本后定：整段合成（逐句切会让句间停顿变短、听着赶），并加语气提示；PC5090_SPLIT=1 恢复逐句
      split: env.PC5090_SPLIT === '1',
      // 口播自带时段语气提示（server/tone.js）时用它的，这个只是兜底
      style: env.PC5090_STYLE ?? '[warm, relaxed late-night radio host, unhurried, with natural pauses]',
      // fishgw 支持流式（/v1/health 带 stream_audio）时整段边合成边念；PC5090_STREAM=0 退回首句先合成
      stream: env.PC5090_STREAM !== '0',
    },
  },

  weather: {
    city: env.WEATHER_CITY ?? '', // 留空 = 按本机出口 IP 自动定位
  },

  asr: {
    baseUrl: env.ASR_BASE_URL ?? '', // 转写网关（5090 上）。留空 = 不用语音点歌
    // 短句先走常驻的小识别服务（不占 5090）；不通再退回上面的网关。留空 = 不用
    fastUrl: env.ASR_FAST_URL ?? '',
  },

  // 节律调度：默认关闭，只手动触发（老板定）。SCHEDULER_ENABLED=1 才开 07:00 规划 / 09:00 早间 / 整点情绪。
  // 场景提示里的个人作息（如「周日晚上通常要出门」），只放本地 .env；留空就不提
  scene: {
    sundayEveningNote: env.SCENE_SUNDAY_EVENING_NOTE ?? '',
    fridayEveningNote: env.SCENE_FRIDAY_EVENING_NOTE ?? '',
    // 「我在 X」算上班的额外地点，逗号分隔（默认认单位 / 公司 / 办公室）
    workPlaces: String(env.SCENE_WORK_PLACES || '').split(',').map((item) => item.trim()).filter(Boolean),
  },

  // 口播语气档的钟点分界（HH:MM），见 server/tone.js。上班、午休跟着「此刻场景」走。
  // 公用版和个人版同一个 Vera、同样的语气档（2026-11-23 老板定）；PUBLIC_TONE=mild 可让公用版夜里不撩不耳语。
  tone: {
    morningFrom: env.TONE_MORNING_FROM ?? '05:00',
    dayFrom: env.TONE_DAY_FROM ?? '09:00',
    eveningFrom: env.TONE_EVENING_FROM ?? '18:00',
    nightFrom: env.TONE_NIGHT_FROM ?? '21:00',
    lateFrom: env.TONE_LATE_FROM ?? '23:00',
    publicLevel: env.PUBLIC_TONE === 'mild' ? 'mild' : 'full',
  },

  scheduler: {
    enabled: env.SCHEDULER_ENABLED === '1',
  },

  paths: {
    ...paths,
  },
};
