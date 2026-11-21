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
    if (s.user && String(s.user.playerName || '').toLowerCase() === 'unknown') {
      for (const item of nav) if (item[2] === 'register') item[1] = '诡异入侵';
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
      '<span class="kicker" id="who-chip">' + (s.user ? '登入中：' + esc(s.user.nickname) + (s.user.status !== 'approved' ? '（审核中）' : '') + (s.user.muted ? ' <span class="mute-tag">已禁言</span>' : '') : '未登入') + '</span>' +
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
        '<span class="acct-status">' + (a.status === 'approved' ? '已过审' : '审核中') + '</span>' +
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
      '<label class="lab">角色名（设卡上的角色名字，也可填网名）<input class="field" id="login-nick" maxlength="24" autocomplete="off"></label>' +
      '<label class="lab">玩家名（CN / 车主）<input class="field" id="login-player" maxlength="24" autocomplete="off"></label>' +
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
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, e => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
    }
    return es;
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
      : renderText(msg.text);
    /* 记下原文并打标记，表情被删/新增时能原地重绘 */
    const markBody = () => {
      const b = row.querySelector('.body');
      if (b && !msg.adminDeleted) { b._ffText = String(msg.text == null ? '' : msg.text); b.classList.add('ff-emoji-host'); }
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
    row.className = 'msg' + (mine ? ' mine' : '');
    row.dataset.id = msg.id;
    row.innerHTML =
      (msg.avatar ? '<img class="avatar" loading="lazy" decoding="async" src="' + esc(msg.avatar) + '" alt="头像"' + (canClick ? ' data-user="' + esc(msg.userId) + '"' : '') + '>' : '<span></span>') +
      '<div><div class="meta"><span class="who"' + (canClick ? ' data-user="' + esc(msg.userId) + '"' : '') + '>' + esc(msg.nickname) + '</span>' + (msg.muted ? '<span class="mute-tag">已禁言</span>' : '') + adminBadge(msg.userId) + '<span class="time">' + fmtTime(msg.ts) + '</span></div>' +
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

  /* 把纯文本渲染成 HTML：先转义，再把 [emoji:id] 换成图片 */
  function renderText(text) {
    const src = String(text == null ? '' : text);
    if (src.indexOf('[emoji:') < 0) return esc(src);
    let out = '', i = 0, m;
    const re = /\[emoji:(\d+)\]/g;
    while ((m = re.exec(src))) {
      out += esc(src.slice(i, m.index));
      const em = emojiById.get(Number(m[1]));
      out += em
        ? '<img class="emoji" src="' + esc(em.url) + '" alt="' + esc(':' + (em.name || '表情') + ':') +
          '" title="' + esc(em.name || '表情') + '" loading="lazy" decoding="async">'
        : '<span class="emoji-gone" title="该表情已被删除">[表情]</span>';
      i = m.index + m[0].length;
    }
    out += esc(src.slice(i));
    return out;
  }

  /* 记录原文，表情增删后可以原地重绘（不刷新页面） */
  function fillText(el, text) {
    if (!el) return;
    el._ffText = String(text == null ? '' : text);
    el.classList.add('ff-emoji-host');
    el.innerHTML = renderText(el._ffText);
  }
  function refreshEmojiText() {
    document.querySelectorAll('.ff-emoji-host').forEach(el => {
      if (typeof el._ffText === 'string') el.innerHTML = renderText(el._ffText);
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

  return { api, session, esc, fmtTime, renderHeader, sse, openModal, openLogin, showProfile, msgRow, bindProfileClicks, switchAccount,
    loadEmojis, applyEmojiData, renderText, fillText, refreshEmojiText, openEmojiPicker, closeEmojiPicker: closePicker };
})();
