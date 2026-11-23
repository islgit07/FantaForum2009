/* 怪啖论坛 · 站点公共脚本 */
'use strict';
const FF = (() => {
  /* 曲库：src 用 ASCII 文件名（省 URL 编码坑），name 是展示名。制卡工具主题曲=欢迎注册同一首，不重复收录 */
  const MUSIC_LIST = [
    { src: '/assets/music/music-1.mp3', name: '【新世纪】！' },
    { src: '/assets/music/music-2.mp3', name: '欢迎注册怪谈论坛！' },
    { src: '/assets/music/music-3.mp3', name: '然侕，它 祂 钔 逋止是 故事。' }
  ];
  let sessionCache = null;
  let music = null;
  let musicIdx = Math.max(0, Number(localStorage.getItem('ff_music_idx') || 0) || 0) % MUSIC_LIST.length;

  async function api(path, opts = {}) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      method: opts.method || (opts.body ? 'POST' : 'GET')
    }, opts, { body: opts.body ? JSON.stringify(opts.body) : undefined }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('请求失败（' + res.status + '）'));
    return data;
  }
  async function session(force) {
    if (!force && sessionCache) return sessionCache;
    sessionCache = await api('/api/session');
    return sessionCache;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Unknown 组：状态只是文字装饰，实际权限仍按 status 走（他们照常发帖回复） */
  const isUnknownUser = u => String((u && u.playerName) || '').toLowerCase() === 'unknown';
  const statusText = (u, short) => {
    if (isUnknownUser(u)) return '未通过审核';
    if (!u) return short ? '已驳回' : '未通过审核';
    if (u.status === 'approved') return short ? '已过审' : '已通过审核';
    if (u.status === 'pending') return '审核中';
    return short ? '已驳回' : '未通过审核';
  };

  /* Unknown 组故障特效：纯视觉，不拦截点击、不改内容。多种故障随机叠加，强度偏高 */
  const GLITCH_CHARS = '▓▒░@#$%&*?/\\|<>=+~^※×零壹贰叁肆伍陆柒捌玖';
  let glitchOn = false;
  function startUnknownGlitch() {
    if (glitchOn) return;
    glitchOn = true;
    document.body.classList.add('unknown-glitch');
    const layer = document.createElement('div');
    layer.className = 'glitch-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    const targets = () => Array.from(document.querySelectorAll(
      '.brand, .section-name, .kicker, .bar-title, .win-bar span, h1, h2, h3, .name, .hint, .btn, nav a, .ps-tag, .status'
    )).filter(e => e.children.length === 0 && e.textContent.trim().length > 1);
    const pulse = (cls, ms) => {
      document.body.classList.add(cls);
      setTimeout(() => document.body.classList.remove(cls), ms);
    };
    const scramble = () => {
      const els = targets().sort(() => Math.random() - 0.5).slice(0, 4 + Math.floor(Math.random() * 6));
      els.forEach(e => {
        const original = e.textContent;
        const garbled = Array.from(original).map(ch =>
          ch.trim() && Math.random() < 0.65 ? GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)] : ch
        ).join('');
        e.classList.add('glitch-scramble');
        e.textContent = garbled;
        setTimeout(() => {
          if (e.isConnected && e.textContent === garbled) e.textContent = original;
          e.classList.remove('glitch-scramble');
        }, 500 + Math.random() * 900);
      });
    };
    const shake = () => pulse('glitch-shake', 260 + Math.random() * 260);
    const flash = () => pulse('glitch-flash', 260 + Math.random() * 380);
    const invert = () => pulse('glitch-invert', 90 + Math.random() * 160);
    const tear = () => pulse('glitch-tear', 320 + Math.random() * 420);
    const jump = () => pulse('glitch-jump', 300 + Math.random() * 300);
    const blur = () => pulse('glitch-blur', 280 + Math.random() * 320);
    const skewCards = () => {
      const cards = Array.from(document.querySelectorAll('.win, .chan-card, .msg, .sg-card, .ps-win'))
        .sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 4));
      cards.forEach(e => {
        e.classList.add('glitch-card');
        e.style.setProperty('--gx', (Math.random() * 18 - 9).toFixed(1) + 'px');
        setTimeout(() => { e.classList.remove('glitch-card'); e.style.removeProperty('--gx'); }, 320 + Math.random() * 420);
      });
    };
    /* 抖动权重加倍，乱码也常出现；每次随机叠加 1~3 种 */
    const fx = [shake, shake, flash, invert, tear, jump, blur, scramble, scramble, skewCards];
    const loop = () => setTimeout(() => {
      const picks = fx.slice().sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
      picks.forEach(f => f());
      loop();
    }, 1400 + Math.random() * 3800);
    loop();
  }
  const TANZHU_ID = 'mwowhihsc56eb23a';
  const adminBadge = id => id === TANZHU_ID ? '<span class="admin-tag">管理员</span>' : '';
  const pad = n => String(n).padStart(2, '0');
  const YEAR_OFFSET = -17; /* 站点纪元：显示年份 = 真实年份 - 17（2026→2009，2027→2010，逐年自动偏移） */
  function fmtTime(ts) {
    const d = new Date(ts);
    return (d.getFullYear() + YEAR_OFFSET) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* 顶栏 */
  const NAV = [
    ['home.html', '主页', 'home'],
    ['index.html', '公共聊天室', 'chat'],
    ['archives.html', '怪谈档案', 'archives'],
    ['search.html', '搜索', 'search'],
    ['messages.html', '消息', 'messages'],
    ['register.html', '创建账号', 'register'],
    ['publish.html', '投稿怪谈', 'publish'],
    ['me.html', '我的主页', 'me']
  ];
  async function renderHeader() {
    const host = document.getElementById('site-header');
    if (!host) return;
    const active = document.body.dataset.section || '';
    const s = await session();
    const showDot = !!(s.user && s.unread > 0 && document.body.dataset.section !== 'messages');
    const nav = NAV.map(x => x.slice());
    if (s.user && isUnknownUser(s.user)) {
      for (const item of nav) if (item[2] === 'register') item[1] = '诡异入侵';
      startUnknownGlitch();
    }
    if (s.user && s.user.playerName === 'admin') nav.push(['admin.html', '管理后台', 'admin']);
    host.className = 'site-header';
    host.innerHTML =
      '<strong class="brand">怪啖论坛</strong><span class="slash">/</span>' +
      '<span class="section-name">' + esc(document.body.dataset.sectionName || '') + '</span>' +
      '<span class="kicker cool">FANTA FORUM / www.FantaForum.fmi</span>' +
      '<nav>' + nav.map(([href, label, key]) =>
        '<a href="' + href + '"' + (key === active ? ' class="active"' : '') + '>' +
        (key === 'messages' && showDot ? '<i class="nav-dot" aria-hidden="true"></i>' : '') + label + '</a>').join('') +
      '<button type="button" id="music-toggle" aria-pressed="false">音乐：关闭</button>' +
      '<span class="kicker" id="who-chip">' + (s.user ? '登入中：' + esc(s.user.nickname) + (isUnknownUser(s.user) ? '（未通过审核）' : (s.user.status !== 'approved' ? '（审核中）' : '')) + (s.user.muted ? ' <span class="mute-tag">已禁言</span>' : '') : '未登入') + '</span>' +
      (s.user ? '<button type="button" id="switch-account-btn" class="kicker switch-link">切换账号</button>'
        : '<button type="button" id="header-login-btn" class="kicker switch-link login-link">登入</button>') +
      '</nav>';
    initMusic();
    const sw = document.getElementById('switch-account-btn');
    if (sw) sw.onclick = () => switchAccount();
    const lg = document.getElementById('header-login-btn');
    if (lg) lg.onclick = () => openLogin();
    const brand = host.querySelector('.brand');
    if (brand) brand.onclick = pokeClick;
  }

  /* 同一玩家名下多账号快速切换 */
  async function switchAccount() {
    let data;
    try { data = await api('/api/switch-accounts'); }
    catch (err) { alert(err.message); return; }
    const list = data.accounts || [];
    const render = () => list.map(a =>
      '<button type="button" class="acct-item' + (a.current ? ' current' : '') + '" data-id="' + esc(a.id) + '"' + (a.current ? ' disabled' : '') + '>' +
        '<img src="' + esc(a.avatar || '') + '" alt="">' +
        '<span class="acct-name">' + esc(a.nickname) + (a.current ? ' <em>（当前）</em>' : '') + '</span>' +
        '<span class="acct-status">' + statusText(a, true) + '</span>' +
        '<span class="acct-go">' + (a.current ? '✓' : '切换 ›') + '</span>' +
      '</button>').join('');
    const back = openModal(
      '<h1 style="margin:0 0 4px;font-size:20px;letter-spacing:3px">切换账号</h1>' +
      '<p class="hint">请保护好你的名字，你的名字就是论坛上的全部……</p>' +
      (list.length > 1
        ? '<div class="acct-list">' + render() + '</div>'
        : '<p class="hint">该玩家名下目前只有 1 个角色。要添加角色，请到「创建账号」制卡。</p>') +
      '<p class="status" id="acct-status" role="status"></p>' +
      '<div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">' +
        '<button class="btn ghost" type="button" id="acct-logout">登出</button>' +
      '</div>'
    );
    const status = back.querySelector('#acct-status');
    back.querySelectorAll('.acct-item:not(.current)').forEach(btn => {
      btn.onclick = async () => {
        status.textContent = '正在切换…';
        try {
          await api('/api/switch-account', { method: 'POST', body: { id: btn.dataset.id } });
          location.reload();
        } catch (err) { status.textContent = err.message; }
      };
    });
    back.querySelector('#acct-logout').onclick = async () => {
      await api('/api/logout', { method: 'POST', body: {} });
      location.reload();
    };
  }

  /* 访客登入弹窗：顶栏「登入」按钮与各页面共用 */
  function openLogin() {
    const back = openModal(
      '<h1 style="margin:0 0 4px;font-size:20px;letter-spacing:3px">登入怪啖论坛</h1>' +
      '<p class="kicker cool">LOGIN / CHARACTER + PLAYER</p>' +
      '<label class="lab">角色名/网名<input class="field" id="login-nick" maxlength="24" autocomplete="off"></label>' +
      '<label class="lab">玩家名<input class="field" id="login-player" maxlength="24" autocomplete="off"></label>' +
      '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap"><button class="btn primary" type="button" id="login-go">登入</button><a class="btn" href="register.html">还没有账号？去制卡</a></div>' +
      '<p class="status" id="login-status" role="status"></p>'
    );
    const status = back.querySelector('#login-status');
    const go = async () => {
      status.textContent = '正在登入…';
      try {
        await api('/api/login', { body: {
          nickname: back.querySelector('#login-nick').value,
          playerName: back.querySelector('#login-player').value
        } });
        /* 借着这次点击的手势申请通知权限，之后解锁成就可直接弹系统通知 */
        await askNotifyPermission();
        location.reload();
      } catch (err) { status.textContent = err.message; }
    };
    back.querySelector('#login-go').onclick = go;
    back.querySelector('#login-player').onkeydown = e => { if (e.key === 'Enter') go(); };
    back.querySelector('#login-nick').focus();
  }

  /* 背景音乐：点按钮弹选歌菜单；点当前歌=播放/暂停，点别的歌=切换并播放 */
  function initMusic() {
    const btn = document.getElementById('music-toggle');
    if (!btn) return;
    if (!music) { music = new Audio(); music.loop = true; music.volume = .45; music.src = MUSIC_LIST[musicIdx].src; }
    const update = () => {
      btn.textContent = '音乐：' + (music.paused ? '关闭' : MUSIC_LIST[musicIdx].name);
      btn.setAttribute('aria-pressed', String(!music.paused));
    };
    let menu = null;
    const closeMenu = () => {
      if (!menu) return;
      document.removeEventListener('mousedown', onDocDown, true);
      menu.remove(); menu = null;
    };
    const onDocDown = e => { if (menu && !menu.contains(e.target) && e.target !== btn) closeMenu(); };
    function openMenu() {
      closeMenu();
      menu = document.createElement('div');
      menu.className = 'music-menu';
      MUSIC_LIST.forEach((s, i) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'music-item' + (i === musicIdx ? ' current' : '');
        item.textContent = (i === musicIdx && !music.paused ? '♪ ' : '') + s.name;
        item.onclick = async () => {
          const switching = i !== musicIdx;
          if (switching) {
            musicIdx = i;
            localStorage.setItem('ff_music_idx', String(i));
            music.src = s.src;
          }
          closeMenu();
          if (switching || music.paused) { try { await music.play(); } catch { update(); btn.textContent = '音乐：点击开启'; return; } }
          else music.pause();
          update();
        };
        menu.appendChild(item);
      });
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'music-item music-stop';
      stop.textContent = '■ 停止音乐';
      stop.onclick = () => { music.pause(); closeMenu(); update(); };
      menu.appendChild(stop);
      document.body.appendChild(menu);
      const r = btn.getBoundingClientRect();
      menu.style.top = Math.min(r.bottom + 6, window.innerHeight - 12) + 'px';
      menu.style.right = Math.max(6, window.innerWidth - r.right) + 'px';
      document.addEventListener('mousedown', onDocDown, true);
    }
    btn.onclick = e => { e.stopPropagation(); if (menu) closeMenu(); else openMenu(); };
    music.addEventListener('play', update);
    music.addEventListener('pause', update);
    update();
  }

  /* SSE */
  function sse(handlers) {
    const es = new EventSource('/api/events');
    /* 成就解锁：服务端只推给本人。所有页面共用这条连接，不必各自再开一条 */
    es.addEventListener('achievement', e => {
      try { notifyAchievement(JSON.parse(e.data)); } catch (err) { console.error(err); }
    });
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, e => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
    }
    return es;
  }

  /* ---------- 成就通知：系统通知优先，未授权时退化为页内横幅 ---------- */
  function achBanner(def) {
    const el = document.createElement('div');
    el.className = 'ach-pop';
    el.innerHTML = '<span class="ico">' + esc(def.icon || '★') + '</span>' +
      '<span class="tx"><b>获得成就</b>' + esc(def.name) + '</span>';
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => { if (el.isConnected) el.remove(); }, 3200);
  }
  function notifyAchievement(def) {
    if (!def || !def.name) return;
    achBanner(def);
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      /* 桌面端由系统接管（Windows 为右下角通知），不静音 */
      new Notification('怪啖论坛 · 获得成就', {
        body: def.name, icon: '/assets/openeye.webp', tag: 'ff-ach-' + (def.id || def.name)
      });
    } catch (err) {}
  }
  /* 浏览器要求「用户手势」才能申请权限，登入时顺手问一次 */
  function askNotifyPermission() {
    if (!('Notification' in window)) return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    try { return Notification.requestPermission().catch(() => 'denied'); }
    catch (err) { return Promise.resolve('denied'); }
  }
  function notifyState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;   // granted / denied / default
  }

  /* 网站之眼：被注视时睁眼；离开页面时闭眼，标题低语 */
  const EYE_OPEN = '/assets/openeye.webp';
  const EYE_CLOSED = '/assets/closedeye.webp';
  const REAL_TITLE = document.title;
  const HIDDEN_TITLE = '你似乎想从某处逃离…';
  function setEye(open) {
    let link = document.querySelector('link[rel~="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.type = 'image/png'; document.head.appendChild(link); }
    link.type = 'image/png';
    link.href = (open ? EYE_OPEN : EYE_CLOSED) + (open ? '?s=o' : '?s=c');
    document.title = open ? REAL_TITLE : HIDDEN_TITLE;
  }
  setEye(!document.hidden);
  document.addEventListener('visibilitychange', () => setEye(!document.hidden));

  /* 彩蛋：盯得太久的人，会被注意到（每个客户端只弹一次） */
  const EE_IDLE_MS = 60000;
  let eeTimer = null;
  let eeDone = false;
  function eeMarkSeen() {
    try {
      const attr = location.hostname.endsWith('xn--szrw0ciynt60c.cn') ? '; Domain=xn--szrw0ciynt60c.cn' : '';
      document.cookie = 'ff_dont_confirm=1; Max-Age=31536000; Path=/' + attr + '; SameSite=Lax';
    } catch (err) { /* cookie 不可用时仅本次会话生效 */ }
  }
  function eeAlreadySeen() { return document.cookie.indexOf('ff_dont_confirm=1') >= 0; }
  function eeModal(innerHtml) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop ee-modal';
    back.innerHTML = '<div class="win modal"><div class="win-body">' + innerHtml + '</div></div>';
    document.body.appendChild(back);
    return back;
  }
  function eeFire() {
    if (eeDone || eeAlreadySeen()) return;
    eeDone = true;
    eeMarkSeen();
    const first = eeModal(
      '<p class="ee-red">请勿确认</p>' +
      '<div class="ee-actions"><button type="button" class="btn" id="ee-confirm">确认</button></div>'
    );
    first.querySelector('#ee-confirm').onclick = () => {
      /* 成就：似乎被盯上了 = 在「请勿确认」里选了确认（需登入，失败静默） */
      api('/api/achievements/unlock', { body: { id: 'dont_confirm' } })
        .then(r => { if (r && r.unlocked && r.achievement) notifyAchievement(r.achievement); })
        .catch(() => {});
      first.remove();
      const second = eeModal(
        '<p class="ee-ask">你在盯着我看吗？</p>' +
        '<div class="ee-actions">' +
        '<button type="button" class="btn" id="ee-yes">是</button>' +
        '<button type="button" class="btn" id="ee-confirm2">确认</button>' +
        '</div>'
      );
      const close = () => second.remove();
      second.querySelector('#ee-yes').onclick = close;
      second.querySelector('#ee-confirm2').onclick = close;
    };
  }
  function eeReset() {
    if (eeDone) return;
    clearTimeout(eeTimer);
    eeTimer = setTimeout(eeFire, EE_IDLE_MS);
  }
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, eeReset, { passive: true, capture: true }));
  if (eeAlreadySeen()) eeDone = true; else eeReset();
  window.ffConfirmEgg = eeFire; /* 验证钩子：手动触发一次彩蛋 */

  /* 弹窗 */
  function openModal(innerHtml, wide) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = '<div class="win modal' + (wide ? ' wide' : '') + '"><div class="win-bar"><span class="bar-title">怪啖论坛</span><button class="corner" type="button" aria-label="关闭">×</button></div><div class="win-body">' + innerHtml + '</div></div>';
    document.body.appendChild(back);
    const close = () => back.remove();
    back.querySelector('.corner').onclick = close;
    back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    return back;
  }

  /* 手动黑方块打码编辑器（替代旧马赛克）：
   * 黑块按相对坐标（0~1）保存，不烙进原图——查看时才能点击揭开。
   * 编辑：拖动画块；点已有块移除；撤销 / 清空；应用回调相对坐标数组。 */
  function openBlackMask(src, label, initial, onApply) {
    if (!src) return;
    const back = openModal(
      '<h3 style="margin:0 0 8px;color:#ff5940">黑色方块打码 · ' + esc(label || '图片') + '</h3>' +
      '<p class="hint" style="margin:0 0 10px">按住拖动画黑方块；点击已有黑块可移除。黑块不写入原图，查看时点它即可揭开。</p>' +
      '<div class="mask-stage"><canvas id="bm-canvas"></canvas></div>' +
      '<div class="mask-bar">' +
        '<button class="btn ghost" type="button" id="bm-undo">撤销一块</button>' +
        '<button class="btn ghost" type="button" id="bm-clear">清空全部</button>' +
        '<span class="mask-count" id="bm-count">0 块</span>' +
        '<button class="btn" type="button" id="bm-cancel">取消</button>' +
        '<button class="btn primary" type="button" id="bm-apply">应用</button>' +
      '</div>' +
      '<p class="status" id="bm-status">正在载入图片…</p>', true);
    const cv = back.querySelector('#bm-canvas'), ctx = cv.getContext('2d');
    const status = back.querySelector('#bm-status'), countEl = back.querySelector('#bm-count');
    let img = null, blocks = (initial || []).map(r => ({ x: +r.x, y: +r.y, w: +r.w, h: +r.h })).filter(r => [r.x, r.y, r.w, r.h].every(Number.isFinite)), drag = null;

    const draw = () => {
      if (!img) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      ctx.fillStyle = '#000';
      for (const r of blocks) ctx.fillRect(r.x * cv.width, r.y * cv.height, r.w * cv.width, r.h * cv.height);
      if (drag) {
        const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
        const w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
        ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.fillRect(x * cv.width, y * cv.height, w * cv.width, h * cv.height);
        ctx.strokeStyle = '#ff5a40'; ctx.lineWidth = 2;
        ctx.strokeRect(x * cv.width + 1, y * cv.height + 1, w * cv.width - 2, h * cv.height - 2);
      }
      countEl.textContent = blocks.length + ' 块';
    };
    const pos = e => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    cv.addEventListener('pointerdown', e => {
      if (!img) return;
      const p = pos(e);
      /* 点在已有黑块上 → 移除它（后画的优先） */
      for (let i = blocks.length - 1; i >= 0; i--) {
        const r = blocks[i];
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
          blocks.splice(i, 1); draw(); return;
        }
      }
      drag = { x0: Math.max(0, Math.min(1, p.x)), y0: Math.max(0, Math.min(1, p.y)), x1: Math.max(0, Math.min(1, p.x)), y1: Math.max(0, Math.min(1, p.y)) };
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      draw();
    });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = pos(e);
      drag.x1 = Math.max(0, Math.min(1, p.x)); drag.y1 = Math.max(0, Math.min(1, p.y)); draw();
    });
    const finish = () => {
      if (!drag) return;
      const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
      const w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0);
      drag = null;
      if (w >= 0.01 && h >= 0.01) blocks.push({ x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) });
      draw();
    };
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', () => { drag = null; draw(); });
    back.querySelector('#bm-undo').onclick = () => { blocks.pop(); draw(); };
    back.querySelector('#bm-clear').onclick = () => { blocks = []; draw(); };
    back.querySelector('#bm-cancel').onclick = () => back.remove();
    back.querySelector('#bm-apply').onclick = () => {
      if (!img) return;
      back.remove();
      onApply(blocks.slice());
    };
    const im = new Image();
    im.onload = () => {
      img = im;
      const maxW = 640, maxH = 460;
      const sc = Math.min(1, maxW / im.naturalWidth, maxH / im.naturalHeight);
      cv.width = Math.max(1, Math.round(im.naturalWidth * sc));
      cv.height = Math.max(1, Math.round(im.naturalHeight * sc));
      cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
      status.textContent = '图片已载入：' + im.naturalWidth + '×' + im.naturalHeight;
      draw();
    };
    im.onerror = () => { status.textContent = '图片载入失败。'; };
    im.src = src;
  }

  /* 给图片套上黑块覆盖层：相对坐标转百分比，点击黑块即本次揭开（不改数据）。
   * img 会被包进 relative 容器并返回该容器；无黑块则直接返回 img。 */
  function maskOverlay(img, boxes) {
    if (!img || !Array.isArray(boxes) || !boxes.length) return img;
    const wrap = document.createElement('span');
    wrap.className = 'mask-wrap';
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    for (const r of boxes) {
      if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue;
      const b = document.createElement('i');
      b.className = 'mask-block';
      b.title = '点击揭开';
      b.style.left = (r.x * 100) + '%';
      b.style.top = (r.y * 100) + '%';
      b.style.width = (r.w * 100) + '%';
      b.style.height = (r.h * 100) + '%';
      b.onclick = e => { e.stopPropagation(); b.remove(); };
      wrap.appendChild(b);
    }
    return wrap;
  }

  /* 点击头像 / 网名 → 访问该用户的个人主页 */
  function showProfile(userId) {
    if (!userId) return;
    location.href = 'profile.html?id=' + encodeURIComponent(userId);
  }

  /* 聊天消息行 */
  function msgRow(msg) {
    const row = document.createElement('div');
    const bodyHtml = () => msg.adminDeleted
      ? '<span class="del-mark">【管理员已删除】</span>'
      : (msg.bannedCleared ? '<span class="banned-cleared">【已清除】</span>' : renderText(msg.text, msg.mentions));
    /* 记下原文与提及表，表情被删/新增时能原地重绘 */
    const markBody = () => {
      const b = row.querySelector('.body');
      if (b && !msg.adminDeleted && !msg.bannedCleared) {
        b._ffText = String(msg.text == null ? '' : msg.text);
        b._ffMentions = Array.isArray(msg.mentions) ? msg.mentions : [];
        b.classList.add('ff-emoji-host');
      }
    };
    if (msg.kind === 'system') {
      row.className = 'msg system';
      row.dataset.id = msg.id;
      row.innerHTML = '<div class="body">' + bodyHtml() + '　<span class="time">' + fmtTime(msg.ts) + '</span></div>';
      markBody();
      return row;
    }
    const mine = sessionCache && sessionCache.user && sessionCache.user.id === msg.userId;
    const canClick = !msg.noProfile;
    row.className = 'msg' + (mine ? ' mine' : '') + (msg.noProfile ? ' no-profile' : '');
    row.dataset.id = msg.id;
    row.innerHTML =
      (msg.avatar ? '<img class="avatar" loading="lazy" decoding="async" src="' + esc(msg.avatar) + '" alt="头像"' + (canClick ? ' data-user="' + esc(msg.userId) + '"' : '') + '>' : '<span></span>') +
      '<div><div class="meta"><span class="who"' + (canClick ? ' data-user="' + esc(msg.userId) + '"' : '') + '>' + esc(msg.nickname) + '</span>' + (msg.level ? '<span class="lv-tag" title="等级 LV' + msg.level + '">LV' + msg.level + '</span>' : '') + (msg.banned || msg.bannedCleared ? '<span class="ban-tag">已禁封</span>' : '') + (msg.muted ? '<span class="mute-tag">已禁言</span>' : '') + adminBadge(msg.userId) + '<span class="time">' + fmtTime(msg.ts) + '</span></div>' +
      '<div class="body">' + bodyHtml() + '</div></div>';
    markBody();
    return row;
  }
  function bindProfileClicks(root) {
    root.addEventListener('click', async e => {
      const t = e.target.closest('[data-user]');
      if (!t || !t.dataset.user) return;
      /* unknown 组角色（匿名/档案馆/广告位）根本无法点击主页；??? 例外（陷阱页） */
      const s = await session();
      if ((s.noProfileIds || []).includes(t.dataset.user)) return;
      showProfile(t.dataset.user);
    });
  }

  /* 凌晨三点：有些话只说给还醒着的人 */
  (() => {
    const n = new Date();
    if (n.getHours() === 3 && n.getMinutes() <= 32) {
      const w = document.createElement('div');
      w.className = 'am3-whisper';
      w.textContent = '三点了，别回头。';
      document.body.appendChild(w);
      setTimeout(() => w.classList.add('show'), 1500);
      setTimeout(() => w.classList.remove('show'), 9500);
      setTimeout(() => w.remove(), 12000);
    }
  })();

  /* 上上下下左右左右BA：它看见了 */
  const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA'];
  let kIdx = 0, crtTimer = null, crtBox = null;
  window.addEventListener('keydown', e => {
    if (e.code === KONAMI[kIdx]) kIdx++; else kIdx = (e.code === KONAMI[0] ? 1 : 0);
    if (kIdx !== KONAMI.length) return;
    kIdx = 0;
    document.documentElement.classList.add('crt-mode');
    if (!crtBox) { crtBox = document.createElement('div'); crtBox.className = 'crt-eyes'; crtBox.textContent = '它看见了。'; document.body.appendChild(crtBox); }
    crtBox.classList.add('show');
    clearTimeout(crtTimer);
    crtTimer = setTimeout(() => {
      document.documentElement.classList.remove('crt-mode');
      crtBox.classList.remove('show');
    }, 10000);
  });

  /* 彩蛋：戳左上角的怪啖论坛 */
  let pokeCount = 0, pokeStage = 0, pokeTimer = null; /* stage 0=没戳够 1=弹过别戳我 2=不理你了(完结) */
  function pokeReset() {
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(() => { pokeCount = 0; }, 2000);
  }
  function pokeModal(text) {
    const back = eeModal('<p class="poke-text">' + text + '</p><div class="ee-actions"><button type="button" class="btn" id="poke-ok">确认</button></div>');
    back.querySelector('#poke-ok').onclick = () => back.remove();
  }
  function pokeClick() {
    if (pokeStage === 2) return;
    pokeCount++;
    pokeReset();
    if (pokeCount < 5) return;
    pokeCount = 0;
    if (pokeStage === 0) { pokeStage = 1; pokeModal('别戳我'); }
    else { pokeStage = 2; pokeModal('哼，还戳？生气了 不理你了 :-<'); }
  }

  /* ---------- 表情包（全站共用） ----------
   * 消息与帖子正文里的占位符写作 [emoji:数字id]，渲染时换成 256×256 的 WebP。
   * 所有登入且过审的账号都有管理权：上传、删表情、建组、删组。
   */
  const EMOJI_SIZE = 256;
  let emojiData = { size: EMOJI_SIZE, groups: [], emojis: [] };
  let emojiById = new Map();
  let emojiLoaded = false;
  let pickerEl = null;

  function applyEmojiData(d) {
    if (!d || !Array.isArray(d.emojis)) return;
    emojiData = { size: d.size || EMOJI_SIZE, groups: d.groups || [], emojis: d.emojis };
    emojiById = new Map(emojiData.emojis.map(e => [e.id, e]));
    emojiLoaded = true;
    refreshEmojiText();
    if (pickerEl && pickerEl.__refresh) pickerEl.__refresh();
  }
  async function loadEmojis(force) {
    if (emojiLoaded && !force) return emojiData;
    try { applyEmojiData(await api('/api/emojis')); } catch { /* 掉线时按空表渲染，不影响正文 */ }
    return emojiData;
  }

  /* 把纯文本渲染成 HTML：先转义，再把 @网名 换成主页链接、[emoji:id] 换成图片 */
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* 外链图：只认 https 图片直链；<img> 标签本身不落地，仅取 src 重建，避免 XSS */
  const IMG_TOKEN = '\u0000ffimg';
  function safeImgUrl(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s.length < 12 || s.length > 1200) return null;
    if (!/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return null;                 // 必须 https，挡掉 data:/javascript:
    if (!/\.(png|jpe?g|gif|webp|avif)(\?[^\s"'<>]*)?$/i.test(s)) return null;
    return s;
  }
  function splitImages(src) {
    const imgs = [];
    const hold = u => { imgs.push(u); return IMG_TOKEN + (imgs.length - 1) + '\u0000'; };
    let out = String(src).replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (m, url) => {
      const u = safeImgUrl(url);
      return u ? hold(u) : m;                                              // 不合规就原样保留（随后转义成文字）
    });
    out = out.replace(/https?:\/\/[^\s<>"']+/gi, (m) => {
      const cut = m.replace(/[，。！？、；：）】」》]+$/, '');
      const u = safeImgUrl(cut);
      if (!u) return m;
      return hold(u) + m.slice(cut.length);                                 // 保留尾部标点
    });
    return { text: out, imgs };
  }
  function renderText(text, mentions) {
    const split = splitImages(String(text == null ? '' : text));
    const imgs = split.imgs;
    const src = split.text;
    const list = (Array.isArray(mentions) ? mentions : [])
      .filter(m => m && m.id && String(m.name || '').trim())
      .map(m => ({ id: m.id, name: String(m.name).trim(), noProfile: !!m.noProfile }))
      .sort((a, b) => b.name.length - a.name.length);
    /* 把占位符换回 <img>；没有外链图时保持原样 */
    const imgBack = html => imgs.length
      ? html.replace(/\u0000ffimg(\d+)\u0000/g, (m, i) => {
          const url = imgs[Number(i)];
          return url
            ? '<a class="inline-img-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
              '<img class="inline-img" src="' + esc(url) + '" alt="外链图片" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>'
            : '';
        })
      : html;
    if (!list.length && src.indexOf('[emoji:') < 0) return imgBack(esc(src));
    const parts = [];
    if (list.length) parts.push('@(?:' + list.map(m => escapeRe(m.name)).join('|') + ')');
    parts.push('\\[emoji:(\\d+)\\]');
    const re = new RegExp(parts.join('|'), 'g');
    let out = '', i = 0, m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(i, m.index));
      if (m[0].charAt(0) === '@') {
        const name = m[0].slice(1);
        const hit = list.find(x => x.name === name);
        out += hit && !hit.noProfile
          ? '<a class="mention" href="' + esc('profile.html?id=' + encodeURIComponent(hit.id)) + '">@' + esc(name) + '</a>'
          : esc(m[0]);
      } else {
        const em = emojiById.get(Number(m[1]));
        out += em
          ? '<img class="emoji" src="' + esc(em.url) + '" alt="' + esc(':' + (em.name || '表情') + ':') +
            '" title="' + esc(em.name || '表情') + '" loading="lazy" decoding="async">'
          : '<span class="emoji-gone" title="该表情已被删除">[表情]</span>';
      }
      i = m.index + m[0].length;
    }
    out += esc(src.slice(i));
    return imgBack(out);
  }

  /* 记录原文与提及表，表情增删后可以原地重绘（不刷新页面） */
  function fillText(el, text, mentions) {
    if (!el) return;
    el._ffText = String(text == null ? '' : text);
    el._ffMentions = Array.isArray(mentions) ? mentions : [];
    el.classList.add('ff-emoji-host');
    el.innerHTML = renderText(el._ffText, el._ffMentions);
  }
  function refreshEmojiText() {
    document.querySelectorAll('.ff-emoji-host').forEach(el => {
      if (typeof el._ffText === 'string') el.innerHTML = renderText(el._ffText, el._ffMentions);
    });
  }

  function closePicker() {
    if (!pickerEl) return;
    pickerEl.remove();
    pickerEl = null;
    document.removeEventListener('mousedown', pickerOutside, true);
    document.removeEventListener('keydown', pickerKeys, true);
  }
  function pickerOutside(e) {
    /* 弹窗（新建分组等）本身在面板之外，不能因为点它就关掉面板 */
    if (e.target.closest && e.target.closest('.modal-backdrop')) return;
    if (pickerEl && !pickerEl.contains(e.target) && !(pickerEl.__anchor && pickerEl.__anchor.contains(e.target))) closePicker();
  }
  function pickerKeys(e) {
    if (e.key === 'Escape') { closePicker(); }
  }

  function emojiToast(panel, msg) {
    const st = panel.querySelector('.ep-status');
    if (!st) return;
    st.textContent = msg;
    clearTimeout(panel.__toastTimer);
    panel.__toastTimer = setTimeout(() => { st.textContent = ''; }, 2600);
  }

  async function emojiSquare(file) {
    const bmp = await new Promise((resolve, reject) => {
      if (window.createImageBitmap) {
        createImageBitmap(file).then(resolve, reject);
      } else {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = reject;
        img.src = url;
      }
    });
    const S = EMOJI_SIZE;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    /* 等比缩放到刚好放进正方形，居中留透明边，不裁切不变形 */
    const r = Math.min(S / bmp.width, S / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * r));
    const h = Math.max(1, Math.round(bmp.height * r));
    g.drawImage(bmp, Math.round((S - w) / 2), Math.round((S - h) / 2), w, h);
    return c.toDataURL('image/webp', 0.92);
  }

  async function openEmojiPicker(anchor, opts) {
    opts = opts || {};
    const already = pickerEl && pickerEl.__anchor === anchor;
    closePicker();
    if (already) return;
    await loadEmojis();
    const s = await session();
    const canEdit = !!(s.user && s.user.status === 'approved');
    let groupId = (emojiData.groups[0] || {}).id || null;
    let manage = false;

    const panel = document.createElement('div');
    panel.className = 'emoji-panel';
    panel.__anchor = anchor;
    panel.innerHTML =
      '<div class="ep-head"><span class="ep-title">表情包</span>' +
      (canEdit ? '<button class="ep-link" type="button" data-act="manage">管理</button>' : '') +
      '<button class="ep-link ep-close" type="button" data-act="close" aria-label="关闭">×</button></div>' +
      '<div class="ep-tabs"></div><div class="ep-grid scan"></div>' +
      (canEdit ? '<div class="ep-foot"><button class="ep-act" type="button" data-act="upload">＋ 上传表情</button>' +
        '<button class="ep-act" type="button" data-act="newgroup">＋ 新建分组</button></div>' : '') +
      '<p class="ep-status" role="status"></p>';
    document.body.appendChild(panel);
    pickerEl = panel;
    panel.style.visibility = 'hidden';

    function tabs() {
      const box = panel.querySelector('.ep-tabs');
      box.innerHTML = emojiData.groups.map(g =>
        '<button class="ep-tab' + (g.id === groupId ? ' on' : '') + '" type="button" data-g="' + g.id + '">' +
        esc(g.name) + '<i>' + g.count + '</i></button>').join('') || '<span class="ep-hint">还没有分组</span>';
      if (canEdit && manage && emojiData.groups.length > 1) {
        box.insertAdjacentHTML('beforeend', '<button class="ep-tab ep-del-g" type="button" data-act="delgroup">删除本组</button>');
      }
    }

    function grid() {
      const box = panel.querySelector('.ep-grid');
      const list = emojiData.emojis.filter(e => e.groupId === groupId);
      if (!list.length) {
        box.innerHTML = '<p class="ep-hint">' + (canEdit ? '这个分组还是空的，点下方「上传表情」加一个。' : '这个分组还没有表情。') + '</p>';
        return;
      }
      box.innerHTML = list.map(e =>
        '<button class="ep-cell" type="button" data-id="' + e.id + '" title="' + esc(e.name) + '">' +
        '<img src="' + esc(e.url) + '" alt="' + esc(e.name) + '" loading="lazy" decoding="async">' +
        '<span class="ep-name">' + esc(e.name) + '</span>' +
        (canEdit && manage ? '<span class="ep-x" data-del="' + e.id + '" title="删除这个表情">×</span>' : '') +
        '</button>').join('');
    }

    function render() { tabs(); grid(); }
    panel.__refresh = render;
    render();

    /* 定位：默认贴在触发按钮上方，空间不够就翻到下方 */
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.top - ph - 8;
    if (top < 8) top = Math.min(window.innerHeight - ph - 8, r.bottom + 8);
    panel.style.left = left + 'px';
    panel.style.top = Math.max(8, top) + 'px';
    panel.style.visibility = '';

    document.addEventListener('mousedown', pickerOutside, true);
    document.addEventListener('keydown', pickerKeys, true);

    function newGroup() {
      const back = openModal(
        '<h1 style="margin:0 0 4px;font-size:18px;letter-spacing:3px">新建表情分组</h1>' +
        '<p class="kicker cool">EMOJI GROUP</p>' +
        '<label class="lab">分组名称（最多 12 字）<input class="field" id="eg-name" maxlength="12" autocomplete="off" placeholder="例如：怪谈生物"></label>' +
        '<div style="display:flex;gap:10px;margin-top:14px"><button class="btn primary" type="button" id="eg-go">创建</button></div>' +
        '<p class="status" id="eg-status" role="status"></p>');
      const st = back.querySelector('#eg-status');
      const go = async () => {
        const name = back.querySelector('#eg-name').value.trim();
        if (!name) { st.textContent = '写个名字吧。'; return; }
        try {
          const res = await api('/api/emoji-groups', { body: { name } });
          applyEmojiData(res.snapshot);
          const g = emojiData.groups.find(x => x.name === name);
          if (g) groupId = g.id;
          back.remove();
          render();
        } catch (err) { st.textContent = err.message; }
      };
      back.querySelector('#eg-go').onclick = go;
      back.querySelector('#eg-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      back.querySelector('#eg-name').focus();
    }

    function upload() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        emojiToast(panel, '正在处理…');
        try {
          const dataUrl = await emojiSquare(f);
          const name = (f.name || '表情').replace(/\.[^.]+$/, '').slice(0, 16) || '表情';
          const res = await api('/api/emojis', { body: { groupId, dataUrl, name } });
          applyEmojiData(res.snapshot);
          emojiToast(panel, '已上传');
          render();
        } catch (err) { emojiToast(panel, err.message); }
      };
      inp.click();
    }

    panel.addEventListener('click', async e => {
      const tab = e.target.closest('.ep-tab');
      const cell = e.target.closest('.ep-cell');
      const act = e.target.closest('[data-act]');
      const del = e.target.closest('[data-del]');
      const delG = e.target.closest('[data-del-g]');
      if (delG) {
        const g = emojiData.groups.find(x => x.id === groupId);
        if (!g) return;
        if (!confirm('删除分组「' + g.name + '」会连带删掉它里面的 ' + g.count + ' 个表情，确定？')) return;
        try {
          const res = await api('/api/emoji-groups/' + encodeURIComponent(groupId), { method: 'DELETE', body: {} });
          applyEmojiData(res.snapshot);
          groupId = (emojiData.groups[0] || {}).id || null;
          render();
          emojiToast(panel, '分组已删除');
        } catch (err) { emojiToast(panel, err.message); }
        return;
      }
      if (del) {
        e.stopPropagation();
        if (!confirm('删除这个表情？已发出的消息里它会显示成 [表情]。')) return;
        try {
          const res = await api('/api/emojis/' + encodeURIComponent(del.dataset.del), { method: 'DELETE', body: {} });
          applyEmojiData(res.snapshot);
          render();
        } catch (err) { emojiToast(panel, err.message); }
        return;
      }
      if (tab && tab.dataset.g) { groupId = Number(tab.dataset.g); render(); return; }
      if (act) {
        const a = act.dataset.act;
        if (a === 'close') { closePicker(); return; }
        if (a === 'manage') {
          manage = !manage;
          act.classList.toggle('on', manage);
          act.textContent = manage ? '完成' : '管理';
          render();
          return;
        }
        if (a === 'upload') { if (!groupId) { emojiToast(panel, '先建一个分组'); return; } upload(); return; }
        if (a === 'newgroup') { newGroup(); return; }
      }
      if (cell && !del) {
        const em = emojiById.get(Number(cell.dataset.id));
        if (em && opts.onPick) opts.onPick(em);
      }
    });
  }

  return { api, session, esc, isUnknownUser, statusText, startUnknownGlitch, fmtTime, renderHeader, sse, openModal, openBlackMask, maskOverlay, openLogin, showProfile, msgRow, bindProfileClicks, switchAccount,
    notifyAchievement, askNotifyPermission, notifyState,
    loadEmojis, applyEmojiData, renderText, fillText, refreshEmojiText, openEmojiPicker, closeEmojiPicker: closePicker };
})();
