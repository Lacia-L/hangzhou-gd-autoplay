// ==UserScript==
// @name         杭州国动视频 自动刷课 (gdypt autoplay)
// @namespace    https://github.com/Lacia-L/hangzhou-gd-autoplay
// @version      1.0.1
// @description  自动把「杭州国动视频」平台(gdypt.rf.hangzhou.gov.cn)上未学习的视频逐个以 1x 原速真实播放到结束，使其翻转为「已学习」。支持：前台可见检测、卡死自动跳过、定量/定时自动停机、进度本地持久化(刷新不丢)、悬浮控制面板。
// @author       Lacia-L
// @match        https://gdypt.rf.hangzhou.gov.cn/*
// @match        https://gdypt.rf.hangzhou.gov.cn:9443/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 用法：登录平台后，页面右下角会出现一个控制面板，点「开始」即可挂机。
 * 关键前提(务必知道)：
 *   1) 必须保持这个标签页在前台可见(Edge/Chrome 窗口在最前面、别最小化、别锁屏)。
 *      标签页一旦被浏览器判定为隐藏(document.hidden=true)，视频会被强制暂停，进度不走。
 *   2) 只能 1x 原速真实播放。倍速(哪怕 16x)、拖进度条都不会被计入「已学习」。
 *      整个目录 ~400 个视频要几十个小时真实时长，请合理安排或用「目标数/截止时间」分批。
 *   3) 大文件加载慢(几十~上百 MB，moov 在尾部、不支持 Range)，需要 30~120s 才开始播，
 *      脚本会等待；若一条视频超过 STUCK_MS 仍无进度，会标记为「已尝试」并跳过，不阻塞后续。
 */

(function () {
  'use strict';
  if (window.__gd && window.__gd.timer) { try { clearInterval(window.__gd.timer); } catch (e) {} }

  // ---- 可按需调整的参数 ----
  const CFG = {
    CARD: '.unit-video-zUBDJE',       // 视频卡片
    READ: '.is-read-ejnl30',          // 「已学习」角标(存在即已学)
    NAME: '.video-name-qEjzBZ',       // 卡片内标题
    LOAD_TIMEOUT_MS: 200000,          // 打开后等待可播的最长时间(大文件)
    STUCK_MS: 180000,                 // 播放中无进度多久判定为卡死并跳过
    TICK_MS: 1000
  };

  const LS_TRIED = 'gd_tried';        // 已尝试的视频 id 列表
  const LS_DONE = 'gd_done';          // 已确认播放到结束的视频 id 列表

  const qa = s => Array.prototype.slice.call(document.querySelectorAll(s));
  const safeParse = (s, f) => { try { return JSON.parse(s); } catch (e) { return f; } };
  const lsGet = (k, f) => { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch (e) { return f; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  const G = window.__gd = {
    timer: null,
    running: false,
    stopAfterCurrent: false,
    state: 'idle',
    curName: '',
    curId: '',
    page: 1,
    played: 0,          // 本次会话完成
    skipped: 0,         // 本次会话跳过
    tried: {},          // id -> true (本次+历史，来自 localStorage)
    done: {},           // id -> true (已确认完成，来自 localStorage)
    loadStart: 0,
    lastCur: -1,
    lastProgress: 0,
    log: [],
    finished: false
  };

  // ---- 恢复历史进度(刷新/重进页面不丢) ----
  (function restore() {
    const t = lsGet(LS_TRIED, []); const d = lsGet(LS_DONE, []);
    (Array.isArray(t) ? t : []).forEach(id => G.tried[id] = true);
    (Array.isArray(d) ? d : []).forEach(id => G.done[id] = true);
  })();
  const persist = () => {
    lsSet(LS_TRIED, Object.keys(G.tried));
    lsSet(LS_DONE, Object.keys(G.done));
  };

  const doneCount = () => Object.keys(G.done).length;

  function log(m) {
    G.log.push(m + '@' + new Date().toTimeString().slice(0, 8));
    if (G.log.length > 60) G.log.shift();
    if (els && els.log) els.log.textContent = G.log.slice(-6).reverse().join('\n');
  }

  // 取卡片稳定唯一 id：getFileThumbnail/{id} 可能出现在背景图(span.bg-video-*)或旧版 <img>，都兼容；再退化到标题
  function cardId(card) {
    const idFrom = s => { const m = (s || '').match(/getFileThumbnail\/([A-Za-z0-9_\-]+)/); return m ? m[1] : null; };
    let id = null;
    const bgs = card.querySelectorAll('[class*="bg-video"], [style*="getFileThumbnail"]');
    for (let i = 0; i < bgs.length && !id; i++) {
      id = idFrom(bgs[i].getAttribute('style')) || idFrom(getComputedStyle(bgs[i]).backgroundImage);
    }
    if (!id) {
      const imgs = card.querySelectorAll('img');
      for (let i = 0; i < imgs.length && !id; i++) id = idFrom(imgs[i].getAttribute('src') || imgs[i].currentSrc);
    }
    if (!id) {
      const any = card.querySelectorAll('*');
      for (let i = 0; i < any.length && !id; i++) { const el = any[i]; if (el.style) id = idFrom(el.style.background) || idFrom(el.style.backgroundImage); }
    }
    if (id) return 't' + id;
    const name = ((card.querySelector(CFG.NAME) || {}).textContent || 'untitled').trim();
    return 'n' + name;
  }

  const unlearned = () => qa(CFG.CARD).filter(c => !c.querySelector(CFG.READ));

  // ---- 目标数 / 截止时间(存在 localStorage) ----
  function getTarget() { return parseInt(localStorage.getItem('gd_target') || '0', 10) || 0; }
  function getDeadline() { return parseInt(localStorage.getItem('gd_deadline') || '0', 10) || 0; }
  function reachedLimit() {
    const t = getTarget();
    if (t > 0 && G.played >= t) return '已达本次目标(' + G.played + '/' + t + ')';
    const dl = getDeadline();
    if (dl > 0 && Date.now() >= dl) return '已到截止时间';
    return null;
  }

  function paginate() {
    const nx = document.querySelector('.ant-pagination-next:not(.ant-pagination-disabled) button, .ant-pagination-next:not(.ant-pagination-disabled)');
    if (nx) { nx.click(); G.page++; log('翻页 -> ' + G.page); return true; }
    return false;
  }

  function tick() {
    if (els && els.status) paint();
    if (!G.running) return;
    if (document.hidden) { G.state = 'hidden-wait'; return; }   // 前台可见前提

    const v = document.querySelector('video');
    const close = document.querySelector('.ant-modal-close');

    // A) 弹窗里有视频：驱动 1x 播放
    if (v) {
      if (!isFinite(v.duration) || v.readyState < 1) {          // 大文件仍在加载
        if (Date.now() - G.loadStart > CFG.LOAD_TIMEOUT_MS) {
          log('加载超时，跳过 ' + G.curId);
          G.tried[G.curId] = true; G.skipped++; persist();
          close && close.click(); G.state = 'idle';
          setTimeout(() => { G.state = 'idle'; }, 1200);
        } else { G.state = 'loading'; }
        return;
      }
      if (v.paused) { v.muted = true; try { v.playbackRate = 1; } catch (e) {} const p = v.play(); if (p && p.catch) p.catch(() => {}); G.state = 'play'; }

      // 进度/卡死检测
      if (Math.abs(v.currentTime - G.lastCur) < 0.25) {
        if (Date.now() - G.lastProgress > CFG.STUCK_MS) {
          log('卡死跳过 ' + G.curName);
          G.tried[G.curId] = true; G.skipped++; persist();
          close && close.click(); G.state = 'idle';
          setTimeout(() => { G.state = 'idle'; }, 1200);
        } else { G.state = 'play'; }
      } else { G.lastProgress = Date.now(); G.lastCur = v.currentTime; G.state = 'play'; }

      if (v.ended) {
        if (!G.done[G.curId]) { G.done[G.curId] = true; G.played++; persist(); }
        log('完成 ' + G.curName);
        close && close.click(); G.state = 'closing';
        setTimeout(() => {
          if (G.stopAfterCurrent) { G.running = false; G.state = 'stopped'; log('已按' + (reachedLimit() || '手动') + '停机'); paint(); }
          else { G.state = 'idle'; }
        }, 1500);
      }
      return;
    }

    // 停机判定：看完当前条才停，绝不打断正在播的视频
    if (!G.stopAfterCurrent && reachedLimit()) { G.stopAfterCurrent = true; }
    if (G.stopAfterCurrent) { G.running = false; G.state = 'stopped'; log('到达停机条件，停止'); paint(); return; }

    // B) 无弹窗：挑下一条未学习
    const list = unlearned();
    if (list.length) {
      let target = null, tid = null;
      for (let i = 0; i < list.length; i++) {
        const id = cardId(list[i]);
        if (!G.tried[id]) { target = list[i]; tid = id; break; }
      }
      if (!target) {
        // 本页未学习项都已尝试过 -> 可能角标未及时翻转，翻页继续；无下一页则收尾
        if (!paginate()) { G.finished = true; G.state = 'done'; log('全部完成(本页无新可学)'); }
        return;
      }
      const name = ((target.querySelector(CFG.NAME) || {}).textContent || 'untitled').trim();
      G.tried[tid] = true; persist();
      G.curId = tid; G.curName = name; G.state = 'open';
      G.loadStart = Date.now(); G.lastCur = -1; G.lastProgress = Date.now();
      target.scrollIntoView({ block: 'center' });
      target.click();
      log('打开 ' + name);
      return;
    }

    // C) 当前页没有未学习卡片：翻页
    if (!paginate()) {
      // 没有下一页：从头重扫一遍(角标翻转/懒加载可能导致漏网)；两轮都空则结束
      const still = unlearned().length;
      if (still === 0) { G.finished = true; G.state = 'done'; log('全部完成'); }
    }
  }

  // ---------------- 悬浮控制面板 ----------------
  let els = null;
  function fmtDur(sec) { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return (h ? h + 'h' : '') + m + 'm'; }
  function stateLabel() {
    return ({ 'idle': '待命', 'loading': '加载中', 'play': '播放中', 'closing': '关闭中', 'hidden-wait': '⚠ 页面被隐藏,已暂停', 'open': '打开卡片', 'stopped': '已停机', 'done': '全部完成' })[G.state] || G.state;
  }
  function paint() {
    if (!els) return;
    els.status.textContent = (G.running ? '● 运行中' : '○ 已停止') + ' · ' + stateLabel();
    els.status.style.color = G.running ? '#0a7d32' : '#888';
    els.cur.textContent = G.curName || '—';
    els.count.textContent = '本次完成 ' + G.played + ' · 跳过 ' + G.skipped + ' · 累计已学 ' + doneCount();
    const v = document.querySelector('video');
    els.prog.textContent = v ? (Math.round(v.currentTime) + ' / ' + (isFinite(v.duration) ? Math.round(v.duration) : '?') + 's') : '';
  }

  function buildPanel() {
    if (document.getElementById('gd-panel')) return;
    const box = document.createElement('div');
    box.id = 'gd-panel';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:280px;background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.15);font:13px/1.5 -apple-system,"Segoe UI",Microsoft YaHei,sans-serif;color:#222;padding:0;overflow:hidden';
    box.innerHTML =
      '<div id="gd-head" style="background:#1677ff;color:#fff;padding:8px 12px;cursor:move;display:flex;justify-content:space-between;align-items:center;user-select:none">' +
        '<b>国动自动刷课</b><span id="gd-min" style="cursor:pointer;padding:0 6px;font-weight:bold">–</span></div>' +
      '<div id="gd-body" style="padding:10px 12px">' +
        '<div id="gd-status" style="font-weight:600;margin-bottom:4px">○ 已停止</div>' +
        '<div>当前：<span id="gd-cur" style="color:#555">—</span></div>' +
        '<div id="gd-prog" style="color:#555;height:16px"></div>' +
        '<div id="gd-count" style="margin:4px 0;color:#333"></div>' +
        '<div style="display:flex;gap:6px;margin:6px 0">' +
          '<button id="gd-start" style="flex:1;padding:6px;background:#0a7d32;color:#fff;border:0;border-radius:6px;cursor:pointer">开始</button>' +
          '<button id="gd-pause" style="flex:1;padding:6px;background:#e6a23c;color:#fff;border:0;border-radius:6px;cursor:pointer">暂停</button>' +
          '<button id="gd-stop" style="flex:1;padding:6px;background:#909399;color:#fff;border:0;border-radius:6px;cursor:pointer">停止</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
          '<label style="width:56px">目标数</label><input id="gd-target" type="number" min="0" placeholder="0=不限" style="flex:1;padding:4px;border:1px solid #ccc;border-radius:4px">' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
          '<label style="width:56px">截止</label><input id="gd-deadline" type="datetime-local" style="flex:1;padding:4px;border:1px solid #ccc;border-radius:4px">' +
        '</div>' +
        '<label style="display:flex;align-items:center;gap:6px;margin:4px 0"><input id="gd-auto" type="checkbox"> 打开页面后自动开始</label>' +
        '<div style="display:flex;gap:6px;margin-top:6px">' +
          '<button id="gd-reset" style="flex:1;padding:5px;background:#fff;color:#d4380d;border:1px solid #d4380d;border-radius:6px;cursor:pointer">清除本地进度</button>' +
        '</div>' +
        '<pre id="gd-log" style="margin:8px 0 0;height:64px;overflow:auto;background:#f6f7f9;border-radius:6px;padding:6px;font-size:11px;color:#555;white-space:pre-wrap"></pre>' +
      '</div>';
    document.body.appendChild(box);

    els = {
      status: box.querySelector('#gd-status'), cur: box.querySelector('#gd-cur'),
      prog: box.querySelector('#gd-prog'), count: box.querySelector('#gd-count'), log: box.querySelector('#gd-log')
    };

    box.querySelector('#gd-start').onclick = () => { G.running = true; G.stopAfterCurrent = false; G.finished = false; log('开始'); paint(); };
    box.querySelector('#gd-pause').onclick = () => { G.running = false; G.state = 'idle'; log('暂停'); paint(); };
    box.querySelector('#gd-stop').onclick = () => { G.running = false; G.state = 'idle'; log('停止'); paint(); };
    box.querySelector('#gd-reset').onclick = () => {
      if (confirm('清除本地已尝试/已完成进度记录？不会取消已学的视频，只是让脚本重新扫描。')) {
        G.tried = {}; G.done = {}; G.played = 0; G.skipped = 0; persist(); log('已清除本地进度'); paint();
      }
    };
    box.querySelector('#gd-auto').checked = localStorage.getItem('gd_autostart') === '1';
    box.querySelector('#gd-auto').onchange = e => localStorage.setItem('gd_autostart', e.target.checked ? '1' : '0');
    const tg = box.querySelector('#gd-target'); tg.value = getTarget() || ''; tg.onchange = () => { localStorage.setItem('gd_target', String(parseInt(tg.value, 10) || 0)); };
    const dl = box.querySelector('#gd-deadline'); const dlv = getDeadline(); if (dlv) { const d = new Date(dlv); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); dl.value = d.toISOString().slice(0, 16); }
    dl.onchange = () => { localStorage.setItem('gd_deadline', dl.value ? String(new Date(dl.value).getTime()) : '0'); };

    // 折叠 + 拖拽
    const body = box.querySelector('#gd-body'); let min = false;
    box.querySelector('#gd-min').onclick = () => { min = !min; body.style.display = min ? 'none' : ''; box.querySelector('#gd-min').textContent = min ? '+' : '–'; };
    (function drag() {
      const head = box.querySelector('#gd-head'); let sx, sy, ox, oy, down = false;
      head.onmousedown = e => { if (e.target.id === 'gd-min') return; down = true; sx = e.clientX; sy = e.clientY; const r = box.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); };
      document.addEventListener('mousemove', e => { if (!down) return; box.style.left = (ox + e.clientX - sx) + 'px'; box.style.top = (oy + e.clientY - sy) + 'px'; box.style.right = 'auto'; box.style.bottom = 'auto'; });
      document.addEventListener('mouseup', () => down = false);
    })();

    paint();
  }

  function boot() {
    buildPanel();
    if (!G.timer) G.timer = setInterval(tick, CFG.TICK_MS);
    if (localStorage.getItem('gd_autostart') === '1' && document.querySelector(CFG.CARD)) {
      G.running = true; log('自动开始'); paint();
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
