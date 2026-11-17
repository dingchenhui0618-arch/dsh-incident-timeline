// Standalone preview page for the host route.
//
// Why this exists: the conversation panel is only visible inside the DSH web
// client, which makes the result hard to inspect during development and hard
// to screenshot for the README. The host serves this page at
// /dsh-incident-timeline/preview; it uses the same stylesheet and the same
// /state payload as the React view, so what it renders is the real projection,
// not a mock-up.

import css from './client-css.cjs'

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const KIND_LABEL = {
  'user-rejected': 'user rejected',
  'plugin-error': '插件/工具报错',
  'runtime-http': '运行时 HTTP',
}

/**
 * @param {{mountPath?:string}} [options]
 */
export function renderPreviewHtml(options) {
  const settings = options || {}
  const base = typeof settings.mountPath === 'string' && settings.mountPath.length > 0
    ? settings.mountPath.replace(/\/+$/, '')
    : '/dsh-incident-timeline'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 事故时间线 · 只读投影</title>
<style>
${css}
html,body{margin:0;min-height:100%;}
body{background:#070708;color:#f4f4f5;color-scheme:dark;font-family:var(--it-font-sans);}
body.light{background:#fbfbfa;color:#18181b;color-scheme:light;}
main{max-width:1120px;margin:0 auto;min-height:100vh;}
.it-root{min-height:100vh;}
</style>
</head>
<body>
<main>
<div class="it-root">
  <header class="it-head">
    <div class="it-eyebrow">Incident timeline · read-only</div>
    <div class="it-title-row">
      <h1 class="it-title">事故时间线</h1>
      <p class="it-sub">把审批拒绝、插件报错、运行时 HTTP 状态拆开，并保留原始日志行号。会话文件只读。</p>
    </div>
  </header>
  <div class="it-toolbar">
    <div class="it-segment" id="filters" role="group" aria-label="时间窗">
      <button type="button" data-window="all" aria-pressed="true">全部</button>
      <button type="button" data-window="24h" aria-pressed="false">24 小时</button>
      <button type="button" data-window="7d" aria-pressed="false">7 天</button>
    </div>
    <div class="it-spacer"></div>
    <button class="it-btn" type="button" id="sync">重新扫描</button>
    <a class="it-btn it-btn-primary" id="export" href="${base}/export?format=md&amp;download=1" download="incident-timeline.md">导出 Markdown</a>
  </div>
  <div class="it-error" id="error" hidden></div>
  <div class="it-stats" id="stats"></div>
  <section class="it-card">
    <div class="it-card-head"><h2>事件</h2><span id="window-label">加载中…</span></div>
    <div class="it-list" id="list"><div class="it-skeleton"></div><div class="it-skeleton"></div><div class="it-skeleton"></div></div>
  </section>
  <div class="it-note">
    <span>只读投影：会话文件未修改。</span>
    <span>行号是解压后 JSONL 的物理行号；摘录为原文截断。</span>
    <code id="db"></code>
  </div>
</div>
</main>
<script>
(function () {
  var base = ${JSON.stringify(base)};
  var current = 'all';
  var labels = ${JSON.stringify(KIND_LABEL)};
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function query() {
    var parts = ['limit=500'];
    if (current === '24h') parts.push('since=' + (Date.now() - 86400000));
    if (current === '7d') parts.push('since=' + (Date.now() - 7 * 86400000));
    return parts.join('&');
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function clock(ms) {
    if (typeof ms !== 'number') return '—';
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function day(ms) {
    if (typeof ms !== 'number') return '—';
    var d = new Date(ms);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function stat(value, label, tone) {
    return '<div class="it-stat ' + tone + '"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
  }
  function row(event) {
    var label = labels[event.kind] || event.kind;
    var object = event.status ? ('HTTP ' + event.status) : (event.tool || (event.detail && event.detail.source) || '—');
    var step = (typeof event.turn === 'number' && typeof event.step === 'number') ? (event.turn + '/' + event.step) : (event.step === undefined ? '—' : event.step);
    return '<div class="it-event it-' + esc(event.kind) + '">' +
      '<div class="it-kind-bar" aria-hidden="true"></div>' +
      '<div class="it-event-main">' +
        '<div class="it-event-top"><span class="it-badge it-' + esc(event.kind) + '">' + esc(label) + '</span>' +
        '<span class="it-tool">' + esc(object) + '</span></div>' +
        '<p class="it-excerpt">' + esc(event.excerpt) + '</p>' +
        '<div class="it-meta"><span>session ' + esc(event.sessionId) + '</span><span>step ' + esc(step) + '</span><span>L' + esc(event.line) + '</span></div>' +
      '</div>' +
      '<div class="it-event-side"><span>' + esc(clock(event.time)) + '</span><span>' + esc(day(event.time)) + '</span></div>' +
    '</div>';
  }
  function render(data) {
    var stats = data.stats || { total: 0 };
    document.getElementById('stats').innerHTML =
      stat(stats.total || 0, '事件', '') +
      stat(stats['user-rejected'] || 0, 'user rejected', 'it-rejected') +
      stat(stats['plugin-error'] || 0, '插件/工具报错', 'it-plugin') +
      stat(stats['runtime-http'] || 0, '运行时 HTTP', 'it-http');
    document.getElementById('window-label').textContent = (data.windowLabel || '当前时间窗') + ' · ' + (data.events || []).length + ' 条';
    document.getElementById('db').textContent = data.dbPath || '';
    var error = document.getElementById('error');
    if (data.ok === false) {
      error.hidden = false;
      error.textContent = 'host 返回失败：' + (data.error || '未知错误');
    } else {
      error.hidden = true;
    }
    var events = data.events || [];
    var list = document.getElementById('list');
    if (events.length === 0) {
      list.innerHTML = '<div class="it-empty"><strong>该时间窗内没有事件</strong><span>换一个时间窗，或点击「重新扫描」读取最新会话日志。</span></div>';
      return;
    }
    list.innerHTML = events.map(row).join('');
  }
  function load() {
    fetch(base + '/state?' + query(), { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json() })
      .then(render)
      .catch(function (error) {
        var node = document.getElementById('error');
        node.hidden = false;
        node.textContent = '与 host 通信失败：' + String(error && error.message ? error.message : error);
      });
  }
  document.getElementById('filters').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-window]');
    if (!button) return;
    current = button.getAttribute('data-window');
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (item) {
      item.setAttribute('aria-pressed', String(item === button));
    });
    document.getElementById('export').setAttribute('href', base + '/export?format=md&download=1&' + query());
    load();
  });
  document.getElementById('sync').addEventListener('click', function () {
    fetch(base + '/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(load).catch(load);
  });
  load();
  setInterval(load, 5000);
})();
</script>
</body>
</html>`
}
