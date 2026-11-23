// 首屏前按上次选的深浅色上色（单独成文件：公用版的 CSP 不放行内联脚本）
try { const t = localStorage.getItem('claudio-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* 读不到就用默认深色 */ }
