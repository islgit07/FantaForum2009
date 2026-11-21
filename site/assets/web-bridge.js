/* 怪啖论坛 · 制卡工具网页桥接
 * 两种场景生效：
 *  1) 工具以 ?web=1 被 iframe 内嵌（由服务端注入本脚本）；
 *  2) 工具被内联进站点原生页面（register.html / publish.html，含 #cardtool / #guaitool 容器）。
 * 离线双击打开工具时本脚本不执行任何操作，不影响原工具。
 */
(() => {
  'use strict';
  const inIframe = window.parent !== window && /[?&]web=1/.test(location.search);
  const nativeHost = !!document.getElementById('cardtool') || !!document.getElementById('guaitool');
  if (!inIframe && !nativeHost) return;

  const notify = payload => {
    try { window.parent.postMessage(Object.assign({ source: 'fanta-bridge' }, payload), location.origin); } catch (e) {}
  };
  const statusEl = () => document.querySelector('.status');
  const setStatus = t => { const el = statusEl(); if (el) el.textContent = t; };

  /* ---- 图片压缩：优先 WebP，浏览器不支持时回退 PNG ----
   * 目的：服务器磁盘有限，卡面/立绘等大图在上传前压到可接受体积。
   * 全部在浏览器端完成，不占用服务器 CPU/内存。 */
  function webpOf(canvas, quality) {
    try {
      const out = canvas.toDataURL('image/webp', quality);
      if (out.slice(0, 14) === 'data:image/webp') return out; // 浏览器支持 WebP
    } catch (e) {}
    return canvas.toDataURL('image/png'); // 回退
  }
  async function loadImg(src) {
    const img = new Image();
    img.src = src;
    if (img.decode) { await img.decode(); }
    else await new Promise((ok, no) => { img.onload = ok; img.onerror = no; });
    return img;
  }
  /* 把已有 dataUrl/blobUrl 重新编码：可缩放 + WebP 压缩。maxEdge=0 表示不缩放。 */
  async function reencode(src, maxEdge, quality) {
    if (!src) return null;
    try {
      const img = await loadImg(src);
      if (!img.naturalWidth || !img.naturalHeight) return src;
      const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return webpOf(canvas, quality);
    } catch (e) { return src; } // 读不出来就原样提交，不阻断投稿
  }

  /* 把表单控件替换成同样式 div，保证 html2canvas 稳定渲染文字 */
  function flattenFields(doc, selector, valueOf) {
    const originals = [...document.querySelectorAll(selector)];
    doc.querySelectorAll(selector).forEach((field, index) => {
      const original = originals[index];
      const div = doc.createElement('div');
      const style = getComputedStyle(original);
      for (const key of style) div.style.setProperty(key, style.getPropertyValue(key));
      div.style.whiteSpace = original.tagName === 'TEXTAREA' ? 'pre-wrap' : 'nowrap';
      div.style.overflow = 'hidden';
      div.style.overflowWrap = 'anywhere';
      div.style.display = 'block';
      div.textContent = valueOf(original);
      field.replaceWith(div);
    });
  }
  async function shoot(el, width, height, onclone) {
    /* html2canvas 兜底：工具页自带 ensureHtml2Canvas（动态重载 capture 脚本），优先走它 */
    if (typeof window.html2canvas !== 'function' && typeof ensureHtml2Canvas === 'function') await ensureHtml2Canvas();
    if (typeof window.html2canvas !== 'function') throw new Error('卡面渲染组件未就绪，请刷新重试。');
    await document.fonts.ready;
    const canvas = await html2canvas(el, { scale: 2, width, height, logging: false, backgroundColor: null, onclone });
    return webpOf(canvas, 0.9); // 卡面文字多，质量取 0.9
  }
  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('提交失败（' + res.status + '）'));
    return data;
  }

  /* ================= 个人主页制卡工具 ================= */
  if (document.querySelector('#registration')) {
    const toolbar = document.querySelector('.toolbar');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.id = 'web-submit';
    button.textContent = '提交到怪啖论坛 · 创建账号';
    toolbar.appendChild(button);

    button.onclick = async () => {
      button.disabled = true;
      setStatus('正在生成卡面并提交…');
      try {
        const val = key => { const el = document.querySelector('[data-key="' + key + '"]'); return el ? el.value.trim() : ''; };
        const avatar = document.querySelector('#avatar');
        if (!avatar || !avatar.src) throw new Error('请先在注册页上传头像。');
        const portrait = document.querySelector('#portrait-image');
        // 上传前把头像/立绘压成 WebP（保持尺寸，仅换格式+有损压缩）
        const avatarSrc = await reencode(avatar.src, 0, 0.88);
        const portraitSrc = portrait && !portrait.hidden ? await reencode(portrait.src, 0, 0.85) : null;
        const card = await shoot(document.querySelector('#sheet'), 1600, 1000, doc => {
          doc.querySelector('#preview-viewport').style.width = '1600px';
          doc.querySelector('#preview-viewport').style.height = '1000px';
          doc.querySelector('#sheet').style.transform = 'none';
          flattenFields(doc, '[data-key]', el => el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).textContent || '' : el.value);
        });
        const result = await post('/api/register', {
          nickname: val('nickname'), playerName: val('playerName'),
          faction: document.querySelector('#sheet').classList.contains('office') ? 'office' : 'forum',
          publicGender: val('publicGender'), publicAge: val('publicAge'),
          signature: val('signature'), intro: val('intro'),
          realName: val('realName'), realGender: val('realGender'), realAge: val('realAge'),
          species: val('species'), height: val('height'), history: val('history'),
          avatar: avatarSrc, portrait: portraitSrc, card
        });
        setStatus('已提交，等待管理员审核。');
        notify({ tool: 'card', ok: true, status: result.status });
      } catch (err) {
        setStatus(err.message);
        notify({ tool: 'card', ok: false, message: err.message });
      } finally { button.disabled = false; }
    };
    notify({ tool: 'card', ok: true, ready: true });
    return;
  }

  /* ================= 怪谈档案制卡工具 ================= */
  if (document.querySelector('#type-choice')) {
    const actions = document.querySelector('.header-actions');
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'web-submit';
    button.textContent = '投稿到怪啖论坛';
    actions.appendChild(button);

    let me = null;
    fetch('/api/me', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : null)).then(u => {
      me = u;
      if (me) {
        const author = document.querySelector('#author');
        author.value = me.nickname;
        author.dispatchEvent(new Event('input'));
        const owner = document.querySelector('#owner');
        if (owner) owner.value = me.playerName || '';
      }
    }).catch(() => {});

    button.onclick = async () => {
      button.disabled = true;
      setStatus('正在生成卡面并投稿…');
      try {
        if (!me) throw new Error('请先在论坛登入账号后再投稿怪谈。');
        for (const id of ['name', areaId()]) {
          const el = document.querySelector('#' + id);
          if (!el.value.trim()) { el.reportValidity(); el.focus(); throw new Error('请填写怪谈名称和影响面积（含单位）。'); }
        }
        const puzzle = document.querySelector('#card').classList.contains('puzzle');
        const sharing = document.querySelector('input[name="sharing"]:checked');
        const portrait = document.querySelector('#portrait');
        const hasPortrait = portrait && !portrait.hidden;
        const card = await shoot(document.querySelector('#card'), 1000, 1580, doc => {
          doc.querySelector('#card').style.transform = 'none';
          doc.querySelector('.viewport').style.width = '1000px';
          doc.querySelector('.viewport').style.height = '1580px';
          doc.querySelector('#upload').hidden = true;
          for (const id of ['name', 'author']) {
            const el = doc.querySelector('#' + id);
            el.style.border = 'none'; el.style.background = 'transparent'; el.style.boxShadow = 'none'; el.style.outline = 'none';
          }
          const authorBox = doc.querySelector('.author-input');
          authorBox.style.border = 'none'; authorBox.style.background = 'transparent'; authorBox.style.boxShadow = 'none'; authorBox.style.outline = 'none';
          if (!hasPortrait) {
            const frame = doc.querySelector('#frame');
            const ph = doc.createElement('div');
            ph.style.cssText = 'position:absolute;inset:0;display:grid;place-content:center;text-align:center;background:#090b10;color:#e5d9d1;font:bold 34px SimSun,"Songti SC",serif;letter-spacing:6px;';
            ph.textContent = '暂未记录形象';
            frame.appendChild(ph);
          }
          doc.querySelectorAll('.sharing small').forEach(note => note.remove());
          flattenFields(doc, '[data-field]', el => el.value.trim() || (el.id === 'author' ? '匿名' : ''));
        });
        const mechanism = [...document.querySelectorAll('textarea[data-field]')]
          .find(t => (t.closest('section') || {}).querySelector && /怪谈机制/.test((t.closest('section').querySelector('h2') || {}).textContent || ''));
        const result = await post('/api/posts', {
          type: puzzle ? 'puzzle' : 'combat',
          name: document.querySelector('#name').value.trim(),
          area: document.querySelector('#' + areaId()).value.trim(),
          mechanism: mechanism ? mechanism.value.trim() : '',
          countermeasures: document.querySelector('#countermeasures').value.trim(),
          sharing: sharing ? sharing.value : 'yes',
          /* 投稿人与设主都按页面填写的文本提交，不再由登录账号代替 */
          author: (document.querySelector('#author') || {}).value ? document.querySelector('#author').value.trim() : '',
          owner: (document.querySelector('#owner') || {}).value ? document.querySelector('#owner').value.trim() : '',
          /* 是否公开：公开→调查委托，不公开→怪谈故事 */
          public: (document.querySelector('input[name="visibility"]:checked') || {}).value === 'no' ? 'no' : 'yes',
          portrait: hasPortrait ? await reencode(portrait.src, 0, 0.85) : null,
          card
        });
        const where = document.querySelector('input[name="visibility"]:checked') && document.querySelector('input[name="visibility"]:checked').value === 'no' ? '怪谈故事' : '调查委托';
        setStatus((result.status === 'approved' ? '投稿成功，已放入怪谈档案，并同步发帖到「' + where + '」。' : '投稿已提交，等待管理员审核；帖子已同步到「' + where + '」。'));
        notify({ tool: 'guaitan', ok: true, status: result.status });
      } catch (err) {
        setStatus(err.message);
        notify({ tool: 'guaitan', ok: false, message: err.message });
      } finally { button.disabled = false; }
    };
    function areaId() { return 'area'; }
    notify({ tool: 'guaitan', ok: true, ready: true });
  }
})();
