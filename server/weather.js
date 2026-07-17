// 天气模块：拉 wttr.in（免 key、可按出口 IP 自动定位、JSON），缓存 30 分钟。
// 同步 summaryLine() 给 context.js 注入 prompt；CLI 启动也读它显示。
// 容错优先：拉不到就保留旧缓存（可能 null），绝不阻塞节目生成。
import { config } from './config.js';

let cache = null; // { cityName, tempC, feels, humidity, desc, summary, ts }
const TTL = 30 * 60 * 1000;

// worldweatheronline weatherCode → 中文（wttr.in 的 lang_zh 实测仍回英文，故自映射）
const CODE_ZH = {
  '113': '晴', '116': '晴间多云', '119': '多云', '122': '阴',
  '143': '薄雾', '248': '雾', '260': '冻雾',
  '176': '局部有雨', '263': '小毛雨', '266': '小毛雨', '281': '冻毛雨', '284': '强冻毛雨',
  '293': '局部小雨', '296': '小雨', '299': '间歇中雨', '302': '中雨', '305': '间歇大雨', '308': '大雨',
  '311': '小冻雨', '314': '中到大冻雨', '353': '阵雨', '356': '中到大阵雨', '359': '暴雨',
  '200': '雷阵雨', '386': '局部雷阵雨', '389': '雷阵雨',
  '179': '局部有雪', '182': '局部雨夹雪', '185': '局部冻毛雨',
  '227': '风雪', '230': '暴雪', '317': '小雨夹雪', '320': '中到大雨夹雪',
  '323': '局部小雪', '326': '小雪', '329': '局部中雪', '332': '中雪', '335': '局部大雪', '338': '大雪',
  '350': '冰粒', '362': '小雨夹雪', '365': '中到大阵雨夹雪', '368': '小阵雪', '371': '中到大阵雪',
  '392': '局部雷阵雪', '395': '雷阵雪',
};

// 拉一次并刷新缓存；返回最新（或失败时的旧）缓存
export async function refresh() {
  try {
    const city = config.weather?.city || '';
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('wttr ' + res.status);
    const j = await res.json();
    const c = j.current_condition?.[0];
    if (!c) throw new Error('no current_condition');
    const area = j.nearest_area?.[0];
    const cityName = area?.areaName?.[0]?.value || city || '';
    const desc = CODE_ZH[c.weatherCode] || c.weatherDesc?.[0]?.value?.trim() || '';
    const tempC = c.temp_C, feels = c.FeelsLikeC, humidity = c.humidity;
    const summary = `${cityName ? cityName + '，' : ''}${desc} ${tempC}°C（体感 ${feels}°C）湿度 ${humidity}%`;
    cache = { cityName, tempC, feels, humidity, desc, summary, ts: Date.now() };
  } catch {
    // 静默：保留旧缓存，不打断
  }
  return cache;
}

// 同步取缓存（过期也先返回旧的，后台 refresh 自会更新）
export function getCached() {
  return cache;
}

// 给 prompt / CLI 用的一句话；无数据返回空串
export function summaryLine() {
  return cache?.summary || '';
}

// 启动定时刷新：立即拉一次 + 每 TTL 续。返回可停止句柄。
export function startWeather() {
  refresh();
  const timer = setInterval(refresh, TTL);
  if (timer.unref) timer.unref();
  return { stop() { clearInterval(timer); } };
}
