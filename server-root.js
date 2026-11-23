/* 怪啖论坛 · root 服务器监控模块（与 admin.html 完全隔离）
 * - 独立 root 密码：DB.config.rootSalt/rootPassHash（首次启动自动生成，默认 rootpassword，
 *   登入后请在页面里立即修改）；会话复用 DB.sessions（{root:true}）+ 独立 cookie ff_root。
 * - 访问数据独立存放 data/visits.json（服务器本地数据，gitignored），内存聚合 + 10 秒节流落盘。
 * - 硬件采样：CPU 用 os.cpus() times 两次采样差值；内存优先 /proc/meminfo MemAvailable；
 *   磁盘 fs.statfsSync（Node<18.15 回退 df -kP）；网速优先 /proc/net/dev（Windows 回退 netstat -e），
 *   均为 5 秒后台采样差值，接口只读现成结果，开销恒定。
 * - API：/api/root/ping | login | logout | password | stats | visits（全部需 root 会话）。
 * - 安全约定：绝不通过 SSE 广播访问数据（/api/events 是公开的），root 页一律轮询。
 */
'use strict';
const geo = require('./server-geo');

module.exports = function installRoot(deps) {
  const {
    DB, save, route, cookies, setCookie, clearCookie,
    httpError, sendJSON, readJSON, hashPass,
    DATA, SITE, path, fs, fsp, os, crypto, execFile, sseClients
  } = deps;

  const VFILE = path.join(DATA, 'visits.json');
  const DAY_KEEP = 90;             /* 天级聚合保留天数 */
  const LOG_KEEP = 6000;           /* 明细条数上限（约 10 天） */
  const ONLINE_MS = 5 * 60 * 1000; /* 在线判定：5 分钟内打开过页面 */
  const GEO_CACHE_MAX = 5000;      /* IP→归属地缓存上限 */
  const SESSION_MS = 12 * 3600 * 1000;

  /* ---------- 访问数据（visits.json） ---------- */
  const V = { days: {}, log: [], geoCache: {} };
  let vLoaded = false, vDirty = false;

  async function loadVisits() {
    try {
      const raw = JSON.parse(await fsp.readFile(VFILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        V.days = raw.days && typeof raw.days === 'object' ? raw.days : {};
        V.log = Array.isArray(raw.log) ? raw.log : [];
        V.geoCache = raw.geoCache && typeof raw.geoCache === 'object' ? raw.geoCache : {};
      }
    } catch { /* 首次运行或文件损坏：从零开始 */ }
    vLoaded = true;
  }

  function flushVisits(force) {
    if ((!vDirty && !force) || !vLoaded) return;
    vDirty = false;
    /* 裁剪：天聚合保留 90 天；recent 只留 3 倍在线窗口；明细封顶；缓存封顶 */
    const keys = Object.keys(V.days).sort();
    while (keys.length > DAY_KEEP) delete V.days[keys.shift()];
    const cutoff = Date.now() - ONLINE_MS * 3;
    for (const k of keys) {
      const rec = V.days[k];
      if (rec && rec.recent) for (const ip of Object.keys(rec.recent)) if (rec.recent[ip] < cutoff) delete rec.recent[ip];
    }
    if (V.log.length > LOG_KEEP) V.log = V.log.slice(-LOG_KEEP);
    if (Object.keys(V.geoCache).length > GEO_CACHE_MAX) V.geoCache = {};
    const tmp = VFILE + '.tmp';
    fsp.writeFile(tmp, JSON.stringify(V), 'utf8')
      .then(() => fsp.rename(tmp, VFILE))
      .catch(err => console.error('[root] visits.json 保存失败：' + err.message));
  }

  function flushVisitsSync() {
    if (!vDirty || !vLoaded) return;
    vDirty = false;
    try {
      const tmp = VFILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(V), 'utf8');
      fs.renameSync(tmp, VFILE);
    } catch { /* 退出时尽力而为 */ }
  }

  const dayKey = d => {
    d = d || new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  function dayRec(key) {
    let rec = V.days[key];
    if (!rec) rec = V.days[key] = { pv: 0, ips: {}, paths: {}, hourly: new Array(24).fill(0), geo: {}, recent: {} };
    if (!Array.isArray(rec.hourly) || rec.hourly.length !== 24) rec.hourly = new Array(24).fill(0);
    return rec;
  }

  /* ---------- 请求信息提取 ---------- */
  function clientIp(req) {
    /* nginx 在前：取 x-forwarded-for 首跳（最原始客户端）；否则回退 socket 地址 */
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
    let ip = (req.socket && req.socket.remoteAddress) || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip === '::1') ip = '127.0.0.1';
    return ip;
  }
  function isPrivateIp(ip) {
    if (!ip || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true;
    const m = /^172\.(\d+)\./.exec(ip);
    return !!(m && +m[1] >= 16 && +m[1] <= 31);
  }
  function parseUA(ua) {
    const s = String(ua || '').slice(0, 220);
    let b = '其他';
    if (/MicroMessenger/i.test(s)) b = '微信';
    else if (/MQQBrowser/i.test(s)) b = 'QQ浏览器';
    else if (/Edg(e|A|iOS)?\//i.test(s)) b = 'Edge';
    else if (/OPR\/|Opera/i.test(s)) b = 'Opera';
    else if (/Firefox\//i.test(s)) b = 'Firefox';
    else if (/Chrome\//i.test(s)) b = 'Chrome';
    else if (/Version\/\d/.test(s) && /Safari\//i.test(s)) b = 'Safari';
    else if (/MSIE |Trident\//i.test(s)) b = 'IE';
    else if (/curl|wget|python|okhttp|java|bot|spider|slurp|crawler|bingpreview|headless/i.test(s)) b = '程序/爬虫';
    let o = '其他';
    if (/Windows/i.test(s)) o = 'Windows';
    else if (/Android/i.test(s)) o = 'Android';
    else if (/iPhone|iPod/i.test(s)) o = 'iOS';
    else if (/iPad/i.test(s)) o = 'iPadOS';
    else if (/Mac OS X|Macintosh/i.test(s)) o = 'macOS';
    else if (/Linux/i.test(s)) o = 'Linux';
    const d = /iPad|Tablet/i.test(s) ? '平板' : (/Mobi|Android|iPhone|iPod/i.test(s) ? '移动' : '桌面');
    return { b, o, d };
  }

  /* ---------- 归属地 ---------- */
  function formatRegion(raw) {
    /* 「中国|广东省|深圳市|电信|CN」→「中国·广东省·深圳市·电信」，跳过 0/空段 */
    if (!raw) return '';
    const parts = String(raw).split('|');
    const c = parts[0] && parts[0] !== '0' ? parts[0] : '';
    const r = parts[1] && parts[1] !== '0' ? parts[1] : '';
    const city = parts[2] && parts[2] !== '0' && parts[2] !== r ? parts[2] : '';
    const isp = parts[3] && parts[3] !== '0' ? parts[3] : '';
    return [c, r, city, isp].filter(Boolean).join('·');
  }
  function geoOf(ip) {
    if (isPrivateIp(ip)) return '内网';
    if (!vLoaded) return '';
    if (V.geoCache[ip] !== undefined) return V.geoCache[ip];
    const g = formatRegion(geo.search(ip));
    if (Object.keys(V.geoCache).length > GEO_CACHE_MAX) V.geoCache = {};
    V.geoCache[ip] = g;
    vDirty = true;
    return g;
  }
  function geoBucket(g) {
    /* 省级聚合桶：中国按省，海外按国家 */
    if (g === '内网') return '内网';
    if (!g) return '未知';
    const seg = g.split('·');
    if (seg[0] === '中国') return seg[1] ? '中国·' + seg[1] : '中国';
    return seg[0];
  }

  /* ---------- 记录访问（server.js serveFile 挂钩） ---------- */
  function recordVisit(req, filePath) {
    if (!vLoaded) return;
    /* root 监控页自身不计入，避免自看自涨 */
    if (path.basename(filePath) === 'root.html') return;
    const ip = clientIp(req);
    if (!ip) return;
    let rel = '';
    try { rel = path.relative(SITE, filePath).replace(/\\/g, '/'); } catch { rel = String(filePath); }
    const ua = parseUA(req.headers['user-agent']);
    const g = geoOf(ip);
    const ts = Date.now();
    const rec = dayRec(dayKey());
    rec.pv += 1;
    rec.ips[ip] = (rec.ips[ip] || 0) + 1;
    rec.paths[rel] = (rec.paths[rel] || 0) + 1;
    rec.hourly[new Date(ts).getHours()] += 1;
    rec.recent[ip] = ts;
    rec.geo[geoBucket(g)] = (rec.geo[geoBucket(g)] || 0) + 1;
    V.log.push({ t: ts, ip, p: rel, r: String(req.headers.referer || '').slice(0, 200), b: ua.b, o: ua.o, d: ua.d, g });
    vDirty = true;
  }

  /* ---------- 聚合视图 ---------- */
  function trend7() {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const k = dayKey(new Date(Date.now() - i * 86400000));
      const rec = V.days[k];
      out.push({ day: k, pv: rec ? rec.pv : 0, uv: rec ? Object.keys(rec.ips).length : 0 });
    }
    return out;
  }
  const topList = obj => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ k, v }));

  /* ---------- 内容运营聚合（新增：内容运营看板，仅 root 可见） ----------
   * 全部来自内存 DB，不落盘、不经 SSE；口径：
   *   发帖数 = 未删除的 threads；回复数 = 未删除的 replies；档案数 = approved 的 posts；
   *   获赞数 = thread/reply 的 likes 累计；活跃用户 = 发帖+回复+档案 的总动作数 Top10。 */
  function contentOverview(days) {
    const now = Date.now();
    const startTs = now - days * 86400000;
    const dayKeys = [];
    for (let i = days - 1; i >= 0; i--) dayKeys.push(dayKey(new Date(now - i * 86400000)));
    const trendMap = {};
    dayKeys.forEach(k => { trendMap[k] = { threads: 0, replies: 0, posts: 0 }; });
    const dayOf = ts => { const n = Number(ts); return n > 0 ? dayKey(new Date(n)) : ''; };
    const todayK = dayKey();

    const channelStats = {};
    (DB.channels || []).forEach(c => { channelStats[c.id] = { id: c.id, name: c.name, threads: 0, replies: 0, likes: 0, recent: 0 }; });
    const userStats = {};
    const touchUser = (id, fallback) => {
      if (!id) return null;
      if (!userStats[id]) userStats[id] = { id, name: fallback || '', threads: 0, replies: 0, posts: 0, likes: 0, recent: 0 };
      const s = userStats[id];
      if (fallback && !s.name) s.name = fallback;
      return s;
    };

    let totalThreads = 0, totalReplies = 0, totalPosts = 0, totalLikes = 0;
    let todayThreads = 0, todayReplies = 0, todayPosts = 0;

    for (const t of (DB.threads || [])) {
      if (t.deleted) continue;
      totalThreads++;
      const tk = dayOf(t.createdAt);
      if (trendMap[tk]) trendMap[tk].threads++;
      if (tk === todayK) todayThreads++;
      const lk = (t.likes || []).length;
      totalLikes += lk;
      const u = touchUser(t.authorId, t.author);
      if (u) { u.threads++; u.likes += lk; }
      const ch = channelStats[t.channelId];
      const recent = Number(t.createdAt) >= startTs;
      if (ch) { ch.threads++; ch.likes += lk; if (recent) ch.recent++; }
      if (u && recent) u.recent++;
      for (const r of (t.replies || [])) {
        if (r.deleted) continue;
        totalReplies++;
        const rk = dayOf(r.createdAt);
        if (trendMap[rk]) trendMap[rk].replies++;
        if (rk === todayK) todayReplies++;
        const rl = (r.likes || []).length;
        totalLikes += rl;
        const ru = touchUser(r.authorId, r.author);
        if (ru) { ru.replies++; ru.likes += rl; }
        if (ch) ch.replies++;
        if (Number(r.createdAt) >= startTs) {
          if (ch) ch.recent++;
          if (ru) ru.recent++;
        }
      }
    }
    for (const p of (DB.posts || [])) {
      if (p.status !== 'approved') continue;
      totalPosts++;
      const pk = dayOf(p.createdAt);
      if (trendMap[pk]) trendMap[pk].posts++;
      if (pk === todayK) todayPosts++;
      const pu = touchUser(p.submitterId || p.authorId, p.author);
      if (pu) pu.posts++;
    }
    /* 网名以用户库为准（改名后看板也显示当前网名） */
    for (const u of (DB.users || [])) {
      if (userStats[u.id]) userStats[u.id].name = u.nickname || userStats[u.id].name;
    }

    const trend = dayKeys.map(k => ({ day: k, threads: trendMap[k].threads, replies: trendMap[k].replies, posts: trendMap[k].posts }));
    const channels = Object.keys(channelStats).map(id => channelStats[id])
      .sort((a, b) => (b.threads + b.replies) - (a.threads + a.replies));
    const active = Object.keys(userStats).map(id => {
      const s = userStats[id];
      return { id: s.id, name: s.name || '（无名）', threads: s.threads, replies: s.replies, posts: s.posts, likes: s.likes, actions: s.threads + s.replies + s.posts, recent: s.recent };
    }).sort((a, b) => b.actions - a.actions || b.recent - a.recent).slice(0, 10);

    return {
      days, updated: now,
      overview: {
        threads: totalThreads, replies: totalReplies, posts: totalPosts, likes: totalLikes,
        users: (DB.users || []).filter(u => u.status === 'approved').length,
        today: { threads: todayThreads, replies: todayReplies, posts: todayPosts }
      },
      trend, channels, active
    };
  }

  /* ---------- 认证 ---------- */
  function ensureRootAuth() {
    if (DB.config.rootPassHash) return;
    DB.config.rootSalt = crypto.randomBytes(8).toString('hex');
    DB.config.rootPassHash = hashPass('rootpassword', DB.config.rootSalt);
    save();
  }
  const isRoot = req => {
    const token = cookies(req).ff_root;
    return !!(token && DB.sessions[token] && DB.sessions[token].root);
  };
  const needRoot = req => { if (!isRoot(req)) throw httpError(401, '需要 root 登入。'); };

  /* ---------- 硬件采样 ---------- */
  let cpuPrev = null, cpuPct = 0, cpuModel = '', cpuCores = 0, cpuLoad = [0, 0, 0];
  function cpuSample() {
    const list = os.cpus();
    let idle = 0, total = 0;
    for (const c of list) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    cpuCores = list.length;
    cpuModel = (list[0] && list[0].model || '').replace(/\s+/g, ' ').trim();
    cpuLoad = os.loadavg().map(x => Math.round(x * 100) / 100);
    if (cpuPrev) {
      const dT = total - cpuPrev.total, dI = idle - cpuPrev.idle;
      if (dT > 0) cpuPct = Math.max(0, Math.min(100, Math.round((1 - dI / dT) * 1000) / 10));
    }
    cpuPrev = { idle, total };
  }

  let netPrev = null, netPrevTs = 0;
  const netNow = { rx: 0, tx: 0, rxRate: 0, txRate: 0, sinceRx: 0, sinceTx: 0, src: null };
  function readProcNet() {
    try {
      const txt = fs.readFileSync('/proc/net/dev', 'utf8');
      let rx = 0, tx = 0, hit = false;
      for (const line of txt.split('\n').slice(2)) {
        if (!/:/.test(line)) continue;
        const name = line.slice(0, line.indexOf(':')).trim();
        if (!name || name === 'lo' || /^(veth|docker|br-|virbr)/.test(name)) continue;
        const cols = line.slice(line.indexOf(':') + 1).trim().split(/\s+/).map(Number);
        if (cols.length < 9) continue;
        rx += cols[0]; tx += cols[8]; hit = true; /* rx bytes / tx bytes */
      }
      return hit ? { rx, tx, src: 'proc' } : null;
    } catch { return null; }
  }
  function readNetstat() {
    return new Promise(resolve => {
      execFile('netstat', ['-e'], { timeout: 4000, windowsHide: true, encoding: 'latin1' }, (err, out) => {
        if (err || !out) return resolve(null);
        /* 中文 Windows 输出为 GBK：「字节」= \xD7\xD6\xBD\xDA（latin1 保字节不转码）；
         * 英文系统输出为 Bytes。取「Bytes/字节」行（第一个数值行）的自开机累计收发。 */
        const m = /^(?:Bytes|\xD7\xD6\xBD\xDA)[ \t]+(\d+)[ \t]+(\d+)/m.exec(out);
        resolve(m ? { rx: +m[1], tx: +m[2], src: 'netstat' } : null);
      });
    });
  }
  async function netSample() {
    const cur = readProcNet() || (await readNetstat());
    if (!cur || !Number.isFinite(cur.rx) || !Number.isFinite(cur.tx)) { netNow.src = null; return; }
    const now = Date.now();
    if (netPrev && cur.src === netNow.src) {
      const dt = (now - netPrevTs) / 1000;
      const dRx = cur.rx - netPrev.rx, dTx = cur.tx - netPrev.tx;
      if (dt > 0 && dRx >= 0 && dTx >= 0) {
        netNow.rxRate = Math.round(dRx / dt);
        netNow.txRate = Math.round(dTx / dt);
        netNow.sinceRx += dRx;
        netNow.sinceTx += dTx;
      }
    }
    netPrev = { rx: cur.rx, tx: cur.tx };
    netPrevTs = now;
    netNow.rx = cur.rx;
    netNow.tx = cur.tx;
    netNow.src = cur.src;
  }

  function memInfo() {
    const total = os.totalmem();
    let avail = null;
    try {
      const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) avail = +m[1] * 1024;
    } catch { /* 非 Linux */ }
    if (avail == null) avail = os.freemem();
    const pm = process.memoryUsage();
    return {
      total, avail,
      used: total - avail,
      pct: Math.round((total - avail) / total * 1000) / 10,
      rss: pm.rss, heap: pm.heapUsed
    };
  }
  function statfsDisk() {
    try {
      if (typeof fs.statfsSync !== 'function') return null;
      const s = fs.statfsSync(DATA);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      return { total, free, used: s.blocks * s.bsize - s.bfree * s.bsize, pct: total ? Math.round((s.blocks - s.bfree) / s.blocks * 1000) / 10 : 0 };
    } catch { return null; }
  }
  function dfDisk() {
    return new Promise(resolve => {
      execFile('df', ['-kP', DATA], { timeout: 4000, windowsHide: true }, (err, out) => {
        if (err || !out) return resolve(null);
        const cols = String(out).trim().split('\n').pop().trim().split(/\s+/);
        if (cols.length >= 4 && /^\d+$/.test(cols[1]) && +cols[1] > 0) {
          const total = +cols[1] * 1024, used = +cols[2] * 1024, free = +cols[3] * 1024;
          resolve({ total, used, free, pct: Math.round(used / total * 1000) / 10 });
        } else resolve(null);
      });
    });
  }

  /* ---------- 初始化 ---------- */
  async function init() {
    ensureRootAuth();
    geo.init(path.join(__dirname, 'geo'));
    await loadVisits();
    cpuSample();
    netSample();
    setInterval(() => { cpuSample(); netSample(); }, 5000).unref();
    setInterval(() => flushVisits(), 10000).unref();
  }
  process.on('exit', flushVisitsSync);
  const onTerm = () => { flushVisitsSync(); process.exit(0); };
  process.on('SIGINT', onTerm);
  process.on('SIGTERM', onTerm);

  /* ---------- API ---------- */
  route('GET', /^\/api\/root\/ping$/, async (req, res) => {
    needRoot(req);
    sendJSON(res, 200, { ok: true });
  });

  route('POST', /^\/api\/root\/login$/, async (req, res) => {
    ensureRootAuth();
    const b = await readJSON(req);
    const pass = String(b.password || '');
    if (!pass) throw httpError(400, '请输入 root 密码。');
    if (hashPass(pass, DB.config.rootSalt) !== DB.config.rootPassHash) throw httpError(401, '密码不正确。');
    const token = crypto.randomBytes(24).toString('hex');
    const cutoff = Date.now() - SESSION_MS;
    for (const k of Object.keys(DB.sessions)) {
      if (DB.sessions[k] && DB.sessions[k].root && (DB.sessions[k].ts || 0) < cutoff) delete DB.sessions[k];
    }
    DB.sessions[token] = { root: true, ts: Date.now() };
    save();
    setCookie(res, 'ff_root', token, { maxAge: SESSION_MS / 1000 });
    sendJSON(res, 200, { ok: true });
  });

  route('POST', /^\/api\/root\/logout$/, async (req, res) => {
    const token = cookies(req).ff_root;
    if (token && DB.sessions[token]) { delete DB.sessions[token]; save(); }
    clearCookie(res, 'ff_root');
    sendJSON(res, 200, { ok: true });
  });

  route('POST', /^\/api\/root\/password$/, async (req, res) => {
    needRoot(req);
    const b = await readJSON(req);
    const next = String(b.next || '');
    if (hashPass(String(b.old || ''), DB.config.rootSalt) !== DB.config.rootPassHash) throw httpError(401, '当前密码不正确。');
    if (next.length < 6) throw httpError(400, '新密码至少 6 位。');
    if (next.length > 64) throw httpError(400, '新密码过长（64 位以内）。');
    DB.config.rootSalt = crypto.randomBytes(8).toString('hex');
    DB.config.rootPassHash = hashPass(next, DB.config.rootSalt);
    /* 改密后作废全部 root 会话，强制重新登入 */
    for (const k of Object.keys(DB.sessions)) if (DB.sessions[k] && DB.sessions[k].root) delete DB.sessions[k];
    save();
    clearCookie(res, 'ff_root');
    sendJSON(res, 200, { ok: true });
  });

  route('GET', /^\/api\/root\/stats$/, async (req, res) => {
    needRoot(req);
    const disk = statfsDisk() || (await dfDisk());
    const rec = V.days[dayKey()];
    const now = Date.now();
    const online = rec && rec.recent ? Object.values(rec.recent).filter(ts => now - ts <= ONLINE_MS).length : 0;
    const fsize = p => { try { return fs.statSync(p).size; } catch { return null; } };
    sendJSON(res, 200, {
      time: Date.now(),
      cpu: { pct: cpuPct, cores: cpuCores, model: cpuModel, load: cpuLoad },
      mem: memInfo(),
      disk,
      net: { rxRate: netNow.rxRate, txRate: netNow.txRate, sinceRx: netNow.sinceRx, sinceTx: netNow.sinceTx, src: netNow.src },
      up: { sys: Math.round(os.uptime()), proc: Math.round(process.uptime()) },
      sys: { node: process.version, platform: os.platform(), release: os.release(), host: os.hostname(), arch: os.arch() },
      visit: { pv: rec ? rec.pv : 0, uv: rec ? Object.keys(rec.ips).length : 0, online },
      files: { db: fsize(path.join(DATA, 'db.json')), visits: fsize(VFILE) },
      sse: sseClients ? sseClients.size : null
    });
  });

  route('GET', /^\/api\/root\/visits$/, async (req, res, m, url) => {
    needRoot(req);
    const q = url.searchParams;
    const today = dayKey();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.get('day') || '') ? q.get('day') : today;
    const rec = V.days[day] || { pv: 0, ips: {}, paths: {}, hourly: new Array(24).fill(0), geo: {}, recent: {} };
    let peak = -1, peakV = 0;
    (Array.isArray(rec.hourly) ? rec.hourly : []).forEach((v, h) => { if (v > peakV) { peakV = v; peak = h; } });
    const online = day === today && rec.recent
      ? Object.values(rec.recent).filter(ts => Date.now() - ts <= ONLINE_MS).length
      : 0;
    /* 明细筛选 + 倒序分页（V.log 按时间正序存放，页 1 = 最新） */
    const ipF = (q.get('ip') || '').trim(), pF = (q.get('p') || '').trim();
    let list = V.log;
    if (ipF) list = list.filter(x => String(x.ip).includes(ipF));
    if (pF) list = list.filter(x => String(x.p).includes(pF));
    const total = list.length;
    const size = 50;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(parseInt(q.get('page'), 10) || 1, 1), pages);
    const start = Math.max(0, total - page * size);
    const end = total - (page - 1) * size;
    sendJSON(res, 200, {
      day,
      days: Object.keys(V.days).sort().reverse(),
      summary: { pv: rec.pv || 0, uv: Object.keys(rec.ips || {}).length, online, peak, peakV },
      hourly: Array.isArray(rec.hourly) ? rec.hourly : new Array(24).fill(0),
      trend: trend7(),
      topPaths: topList(rec.paths),
      topGeo: topList(rec.geo),
      log: { total, pages, page, size, list: list.slice(start, end).reverse() }
    });
  });

  /* 内容运营看板（新增）：仅 root 会话可读；天数限 7/14/30，默认 14 */
  route('GET', /^\/api\/root\/content$/, async (req, res, m, url) => {
    needRoot(req);
    const n = parseInt(url.searchParams.get('days'), 10);
    const days = [7, 14, 30].indexOf(n) >= 0 ? n : 14;
    sendJSON(res, 200, contentOverview(days));
  });

  return { init, recordVisit };
};
