#!/usr/bin/env node
/* 怪啖论坛 Fanta Forum · 零依赖本地服务端
 * 运行：node server.js   （可选环境变量 PORT / HOST / FANTA_DATA）
 * 数据保存在 ./data/（db.json + files/），整目录拷贝即可迁移到服务器。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const installForum = require('./server-forum');

const ROOT = __dirname;
const SITE = path.join(ROOT, 'site');
const TOOL_CARD = path.join(ROOT, '怪啖论坛制卡工具');
const TOOL_GUAI = path.join(ROOT, '怪谈档案制卡工具');
const DATA = path.resolve(process.env.FANTA_DATA || path.join(ROOT, 'data'));
const FILES = path.join(DATA, 'files');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const BODY_LIMIT = 48 * 1024 * 1024;

/* ---------- 存储 ---------- */
const DB = { users: [], posts: [], messages: [], sessions: {}, messageSeq: 0, config: null };
let saveQueue = Promise.resolve();
function save() {
  saveQueue = saveQueue.then(async () => {
    const tmp = path.join(DATA, 'db.json.tmp');
    await fsp.writeFile(tmp, JSON.stringify(DB), 'utf8');
    await fsp.rename(tmp, path.join(DATA, 'db.json'));
  }).catch(err => console.error('[db] 保存失败:', err.message));
  return saveQueue;
}
function hashPass(pass, salt) { return crypto.createHash('sha256').update(salt + '::' + pass).digest('hex'); }
async function loadDb() {
  await fsp.mkdir(FILES, { recursive: true });
  const file = path.join(DATA, 'db.json');
  if (fs.existsSync(file)) Object.assign(DB, JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!DB.config) {
    const salt = crypto.randomBytes(8).toString('hex');
    DB.config = {
      adminUser: 'admin', salt,
      adminPassHash: hashPass('nopassword', salt),
      autoApproveUsers: false, autoApprovePosts: false, motd: ''
    };
    await save();
  }
}
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

/* ---------- 本日访问计数 ----------
 * 按服务端本地日期统计「今日论坛页面被访问的次数」。
 * 每次成功打开一个站点 HTML 页面就 +1；同一台机器反复打开也会累加。
 * 只计页面，不计 API、图片、制卡工具静态资源，避免 SSE / 图片请求刷数。
 */
function visitDateKey() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function todayVisits() {
  const key = visitDateKey();
  if (!DB.visits || DB.visits.date !== key) {
    DB.visits = { date: key, count: 0 };
    save();
  }
  return DB.visits.count;
}
function bumpVisit() {
  const key = visitDateKey();
  if (!DB.visits || DB.visits.date !== key) DB.visits = { date: key, count: 0 };
  DB.visits.count = (Number(DB.visits.count) || 0) + 1;
  save();
}

/* ---------- 小工具 ---------- */
function httpError(code, message) { const e = new Error(message); e.code = code; return e; }
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(httpError(413, '内容过大。')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw || '{}'); } catch { throw httpError(400, '请求格式错误。'); }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, opts = {}) {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge) parts.push('Max-Age=' + opts.maxAge);
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', name + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function text(v, max, label) {
  const s = String(v == null ? '' : v).replace(/\r/g, '').trim();
  if (s.length > max) throw httpError(400, label + '过长（最多 ' + max + ' 字）。');
  return s;
}
function requireText(v, max, label) {
  const s = text(v, max, label);
  if (!s) throw httpError(400, '请填写' + label + '。');
  return s;
}
function sessionUser(req) {
  const token = cookies(req).ff_session;
  const s = token && DB.sessions[token];
  if (!s || s.admin) return null;
  return DB.users.find(u => u.id === s.userId) || null;
}
/* 拥有管理员权限的角色卡：admin 卡与「管理员」卡。
 * 按 id 白名单判定（防冒充）；玩家名为 admin 的角色卡同样视为管理员，便于日后新增同玩家卡。
 * playerName 仅管理员可改，普通用户无法自行提权，故安全。 */
/* 管理员角色卡白名单：仅坛主与管理员。??? 已退出 admin 组，只保留陷阱页可点。 */
const ADMIN_ROLE_IDS = ['mwowhihsc56eb23a', '1a1f9cc9d3e1a313e90'];
function isAdminRole(u) {
  if (!u || u.status !== 'approved') return false;
  return ADMIN_ROLE_IDS.includes(u.id) || String(u.playerName || '').toLowerCase() === 'admin';
}
/* unknown 组：玩家名挂 unknown 的系统角色（匿名/档案馆等），主页不可访问；??? 例外（点开是陷阱页） */
function isNoProfileUser(u) {
  return !!u && String(u.playerName || '').toLowerCase() === 'unknown' && (u.nickname || '') !== '???';
}
function isAdmin(req) {
  // 后台虚拟 admin（旧路径）
  const token = cookies(req).ff_admin;
  const s = token && DB.sessions[token];
  if (s && s.admin) return true;
  // 管理员角色卡登录（新路径）
  return isAdminRole(sessionUser(req));
}
function publicUser(u) {
  const muted = !!u.mutedUntil && Date.now() < u.mutedUntil;
  return {
    id: u.id, nickname: u.nickname, playerName: u.playerName || '',
    avatar: u.avatar, status: u.status,
    muted, mutedUntil: muted ? u.mutedUntil : null,
    noProfile: isNoProfileUser(u),
    public: u.public, portrait: u.portrait || null, card: u.card || null, createdAt: u.createdAt
  };
}
/* 禁言判定：mutedUntil 为未来时间戳即处于禁言期 */
function isMutedUser(u) {
  return !!u && !!u.mutedUntil && Date.now() < u.mutedUntil;
}
function fullUser(u) {
  return Object.assign({}, u, { public: u.public, archive: u.archive });
}
function publicPost(p) {
  /* 投稿人按 authorId 实时解析网名（匿名投稿保持匿名）；设主以投稿时填写的 owner 文本为准 */
  const u = p.authorId && DB.users.find(x => x.id === p.authorId);
  const named = p.author && p.author !== '匿名';
  return {
    id: p.id, type: p.type, name: p.name,
    authorId: p.authorId || null,
    author: named && u && u.nickname ? u.nickname : p.author,
    owner: p.owner || (u && u.playerName) || null,
    area: p.area,
    mechanism: p.mechanism, countermeasures: p.countermeasures, sharing: p.sharing,
    closed: p.closed, status: p.status, portrait: p.portrait || null, card: p.card, createdAt: p.createdAt
  };
}

/* ---------- SSE ---------- */
const sseClients = new Set();
function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}
setInterval(() => { for (const res of sseClients) { try { res.write(': ping\n\n'); } catch {} } }, 25000).unref();

/* ---------- 在线人数（按 SSE 长连接统计，同一账号多开标签页只算一人） ---------- */
function onlineSnapshot() {
  const members = new Map();
  let guests = 0;
  for (const res of sseClients) {
    const m = res.__online;
    if (m && m.uid) {
      if (!members.has(m.uid)) members.set(m.uid, m.nickname || '未命名');
    } else guests++;
  }
  return { count: members.size + guests, members: members.size, guests, names: Array.from(members.values()) };
}
let onlineTimer = null;
function broadcastOnline() {
  if (onlineTimer) return;
  onlineTimer = setTimeout(() => {
    onlineTimer = null;
    broadcast('online', onlineSnapshot());
  }, 300);
  if (onlineTimer.unref) onlineTimer.unref();
}

function addMessage(kind, payload) {
  const msg = Object.assign({ id: ++DB.messageSeq, ts: Date.now(), kind }, payload);
  DB.messages.push(msg);
  if (DB.messages.length > 5000) DB.messages.splice(0, DB.messages.length - 5000);
  save();
  broadcast('message', msg);
  return msg;
}

/* ---------- 图片 ---------- */
async function saveImage(dataUrl, kind, id) {
  if (!dataUrl) return null;
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl).trim());
  if (!m) throw httpError(400, '图片仅支持 PNG / JPG / WebP 的 base64。');
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw httpError(400, '图片为空。');
  if (buf.length > 20 * 1024 * 1024) throw httpError(400, '图片过大（最多 20 MB）。');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const dir = path.join(FILES, kind);
  await fsp.mkdir(dir, { recursive: true });
  // 换格式（如 PNG→WebP）后清掉同 id 的其他扩展名旧文件，避免重复占用磁盘
  for (const e of ['png', 'jpg', 'webp']) {
    if (e === ext) continue;
    const old = path.join(dir, id + '.' + e);
    if (fs.existsSync(old)) { try { await fsp.unlink(old); } catch {} }
  }
  const name = id + '.' + ext;
  await fsp.writeFile(path.join(dir, name), buf);
  return '/files/' + kind + '/' + name;
}
/* 给图片 URL 加时间戳版本号，改图后强制浏览器重新加载（破缓存） */
function verUrl(url) {
  if (!url || url.indexOf('/files/') !== 0) return url;
  return url.split('?')[0] + '?v=' + Date.now();
}
/* 从可能带 ?v= 的 URL 还原出纯磁盘相对路径（/files/ 之后的部分） */
function fileRel(url) {
  return String(url || '').split('?')[0].replace(/^\/files\//, '');
}

/* ---------- 静态服务 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const full = path.normalize(path.join(root, decoded));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}
/* 静态服务缓存策略：
 * - HTML/CSS/JS：no-cache + ETag，每次协商；命中回 304（几乎零流量）
 * - 图片/音频：max-age=86400 + ETag，改图走 ?v= 时间戳破缓存（见 verUrl）
 * - 文本类按浏览器能力 gzip；SSE / API 不受影响
 */
const GZIP_TYPES = new Set(['.html', '.css', '.js', '.json', '.txt', '.svg']);
function clientAcceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}
function sendBody(req, res, status, headers, buf, ext) {
  const gz = GZIP_TYPES.has(ext) && buf.length > 512 && clientAcceptsGzip(req);
  if (gz) {
    buf = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(buf);
}
async function serveFile(req, res, filePath, { injectBridge = false, countVisit = false } = {}) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return notFoundPage(req, res); }
  if (stat.isDirectory()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  if (countVisit && ext === '.html') bumpVisit();
  const isText = ext === '.html' || ext === '.js' || ext === '.css';
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    /* 图片文件名唯一（id 命名，更新时 URL 带 ?v= 版本号），可长期缓存 */
    'Cache-Control': isText ? 'no-cache' : 'public, max-age=31536000, immutable'
  };
  let buf = null;
  if (injectBridge && ext === '.html') {
    const html = await fsp.readFile(filePath, 'utf8');
    const body = html.replace('</body>', '<script src="/assets/web-bridge.js"></script>\n</body>');
    buf = Buffer.from(body, 'utf8');
    headers['Content-Type'] = MIME['.html'];
  } else if (GZIP_TYPES.has(ext) && stat.size <= 4 * 1024 * 1024) {
    // 文本类需要整块读取才能 gzip；超过 4MB 的不压缩（避免占用内存）
    try { buf = await fsp.readFile(filePath); } catch { return notFound(res); }
  }
  // ETag 基于「内容长度 + 修改时间」，注入 bridge 的页面用最终 buffer 长度
  const etag = '"' + (buf ? buf.length : stat.size).toString(36) + '-' +
    Math.floor(stat.mtimeMs).toString(36) + '"';
  headers['ETag'] = etag;
  if (req.headers['if-none-match'] === etag) {
    headers['Content-Length'] = 0;
    res.writeHead(304, headers);
    return res.end();
  }
  if (buf) return sendBody(req, res, 200, headers, buf, ext);
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 未找到该页面。');
}
/* 页面类路径（无扩展名 / .html）缺失时：全屏「被吃掉了」404 彩蛋页；资源类路径走纯文本 */
function notFoundPage(req, res) {
  let pathname = '/';
  try { pathname = decodeURIComponent((req.url || '').split('?')[0]); } catch {}
  const ext = path.extname(pathname).toLowerCase();
  if (!ext || ext === '.html') {
    try {
      const buf = fs.readFileSync(path.join(SITE, '404.html'));
      res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(buf);
      return;
    } catch {}
  }
  notFound(res);
}

/* ---------- API 路由 ---------- */
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('GET', /^\/api\/session$/, async (req, res) => {
  const u = sessionUser(req);
  sendJSON(res, 200, {
    user: u ? Object.assign(publicUser(u), { playerName: u.playerName }) : null,
    admin: isAdmin(req),
    adminByRole: isAdminRole(sessionUser(req)),
    config: { motd: DB.config.motd || '' },
    /* unknown 组无主页角色（匿名/档案馆/广告位）：前端据此让「根本无法点击」 */
    noProfileIds: DB.users.filter(isNoProfileUser).map(x => x.id),
    unread: u ? (DB.notifications || []).filter(n => n.targetId === u.id && n.ts > (u.lastNoticeRead || 0)).length : 0
  });
});

route('POST', /^\/api\/register$/, async (req, res) => {
  const b = await readJSON(req);
  const nickname = requireText(b.nickname, 24, '用户名');
  const playerName = requireText(b.playerName, 24, '玩家名');
  const faction = b.faction === 'office' ? 'office' : 'forum';
  const taken = DB.users.some(u => u.nickname.toLowerCase() === nickname.toLowerCase());
  if (taken) throw httpError(409, '该用户名已被注册。如需使用已有账号，请在「切换账号」登入。');
  if (!b.avatar) throw httpError(400, '请在制卡工具中上传头像。');
  const id = uid();
  const approved = !!DB.config.autoApproveUsers;
  const user = {
    id, nickname, playerName, faction,
    status: approved ? 'approved' : 'pending',
    createdAt: Date.now(),
    public: {
      gender: text(b.publicGender, 12, '公开性别') || '保密',
      age: text(b.publicAge, 4, '公开年龄'),
      signature: text(b.signature, 60, '个性签名'),
      intro: text(b.intro, 180, '个人简介')
    },
    archive: {
      realName: text(b.realName, 24, '姓名'), realGender: text(b.realGender, 12, '性别'),
      realAge: text(b.realAge, 12, '年龄'), species: text(b.species, 24, '种族'),
      height: text(b.height, 12, '身高'), history: text(b.history, 1000, '人物设定')
    },
    avatar: await saveImage(b.avatar, 'avatars', id),
    portrait: await saveImage(b.portrait, 'portraits', id),
    card: await saveImage(b.card, 'cards', id),
    masked: {}
  };
  DB.users.push(user);
  save();
  broadcast('user', publicUser(user));
  sendJSON(res, 200, { ok: true, status: user.status, user: publicUser(user) });
});

route('POST', /^\/api\/login$/, async (req, res) => {
  const b = await readJSON(req);
  const nickname = requireText(b.nickname, 24, '角色名字');
  const playerName = requireText(b.playerName, 24, '玩家名字');
  /* 登入名字同时接受「角色名」（设卡档案 realName）与「网名」（nickname），
   * 玩家名必须一致；角色名撞多个账号且没有网名精确匹配时引导改用网名。 */
  const key = nickname.toLowerCase();
  const realOf = u => ((u.archive || {}).realName || '').trim().toLowerCase();
  const candidates = DB.users.filter(u =>
    u.playerName === playerName &&
    ((u.nickname || '').toLowerCase() === key || realOf(u) === key));
  const user = candidates.find(u => (u.nickname || '').toLowerCase() === key) || candidates[0];
  if (!user) throw httpError(403, '角色名字与玩家名字不匹配，请核对后重试。');
  if (candidates.length > 1 && !candidates.some(u => (u.nickname || '').toLowerCase() === key)) {
    throw httpError(409, '该角色名对应多个账号，请改用网名登入。');
  }
  if (user.status === 'rejected') throw httpError(403, '该账号未通过审核，请联系论坛管理员。');
  const token = crypto.randomBytes(24).toString('hex');
  DB.sessions[token] = { userId: user.id };
  save();
  setCookie(res, 'ff_session', token, { maxAge: 60 * 60 * 24 * 30 });
  sendJSON(res, 200, { ok: true, user: publicUser(user) });
});

route('POST', /^\/api\/logout$/, async (req, res) => {
  const token = cookies(req).ff_session;
  if (token) { delete DB.sessions[token]; save(); }
  clearCookie(res, 'ff_session');
  sendJSON(res, 200, { ok: true });
});

/* 同一玩家名下的账号列表（用于快速切换）。仅列同 playerName，脱敏输出。 */
route('GET', /^\/api\/switch-accounts$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  const playerName = u.playerName || '';
  const accounts = DB.users
    .filter(x => (x.playerName || '') === playerName && x.status !== 'rejected')
    .map(x => Object.assign(publicUser(x), { current: x.id === u.id }));
  sendJSON(res, 200, { playerName, accounts });
});

/* 切换到同一玩家名下的另一个账号。严格校验 playerName，防跨玩家切换。 */
route('POST', /^\/api\/switch-account$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  const b = await readJSON(req);
  const id = requireText(b.id, 64, '账号');
  const target = DB.users.find(x => x.id === id);
  if (!target) throw httpError(404, '未找到该账号。');
  if ((target.playerName || '') !== (u.playerName || '')) throw httpError(403, '只能切换到同一玩家名下的账号。');
  if (target.status === 'rejected') throw httpError(403, '该账号未通过审核，无法切换。');
  const oldToken = cookies(req).ff_session;
  if (oldToken) delete DB.sessions[oldToken];
  const token = crypto.randomBytes(24).toString('hex');
  DB.sessions[token] = { userId: target.id };
  save();
  setCookie(res, 'ff_session', token, { maxAge: 60 * 60 * 24 * 30 });
  sendJSON(res, 200, { ok: true, user: publicUser(target) });
});

route('GET', /^\/api\/me$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  sendJSON(res, 200, fullUser(u));
});

/* 网名唯一性校验：排除自己，忽略大小写 */
function checkNicknameAvailable(nickname, selfId) {
  const value = requireText(nickname, 24, '网名');
  const taken = DB.users.some(x => x.id !== selfId && x.nickname.toLowerCase() === value.toLowerCase());
  if (taken) throw httpError(409, '该网名已被使用，请换一个。');
  return value;
}

/* 用户自助修改自己的公开资料 / 真实档案，字段与管理员编辑一致 */
route('POST', /^\/api\/me\/edit$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  const b = await readJSON(req);
  const p = b.public || {}, a = b.archive || {};
  if ('nickname' in b && b.nickname !== u.nickname) {
    u.nickname = checkNicknameAvailable(b.nickname, u.id);
  }
  u.public = {
    gender: text(p.gender, 12, '公开性别') || '保密',
    age: text(p.age, 4, '公开年龄'),
    signature: text(p.signature, 60, '个性签名'),
    intro: text(p.intro, 180, '个人简介')
  };
  /* 字段级合并：未提交的字段保留原值（防止旧页面/空档案载荷清空真实档案） */
  const prevArchive = u.archive || {};
  u.archive = {
    realName: text('realName' in a ? a.realName : (prevArchive.realName || ''), 24, '姓名'), realGender: text('realGender' in a ? a.realGender : (prevArchive.realGender || ''), 12, '性别'),
    realAge: text('realAge' in a ? a.realAge : (prevArchive.realAge || ''), 12, '年龄'), species: text('species' in a ? a.species : (prevArchive.species || ''), 24, '种族'),
    height: text('height' in a ? a.height : (prevArchive.height || ''), 12, '身高'), history: text('history' in a ? a.history : (prevArchive.history || ''), 1000, '人物设定')
  };
  save();
  broadcast('user', publicUser(u));
  sendJSON(res, 200, { ok: true, user: fullUser(u) });
});

route('GET', /^\/api\/users\/([a-z0-9]+)\/public$/, async (req, res, m) => {
  const u = DB.users.find(x => x.id === m[1] && x.status === 'approved');
  if (!u) throw httpError(404, '未找到该用户。');
  /* unknown 组角色（匿名/档案馆等）没有可访问的主页；??? 例外（陷阱页） */
  if (isNoProfileUser(u)) throw httpError(404, '未找到该用户。');
  sendJSON(res, 200, publicUser(u));
});

route('GET', /^\/api\/posts$/, async (req, res, m, url) => {
  const all = url.searchParams.get('all') === '1' && isAdmin(req);
  const list = DB.posts.filter(p => all || p.status === 'approved');
  sendJSON(res, 200, list.slice().reverse().map(publicPost));
});

route('POST', /^\/api\/posts$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  if (u.status !== 'approved') throw httpError(403, '账号审核中，通过审核后即可投稿怪谈。');
  const b = await readJSON(req);
  const name = requireText(b.name, 60, '怪谈名称');
  const area = requireText(b.area, 160, '怪谈影响范围');
  const type = b.type === 'puzzle' ? 'puzzle' : 'combat';
  const sharing = b.sharing === 'no' ? 'no' : 'yes';
  const id = uid();
  const approved = !!DB.config.autoApprovePosts;
  const post = {
    id, type, name, area,
    author: u.nickname, authorId: u.id, owner: u.playerName,
    mechanism: text(b.mechanism, 300, '怪谈机制'),
    countermeasures: text(b.countermeasures, 300, '怪谈对策'),
    sharing, closed: sharing === 'no',
    status: approved ? 'approved' : 'pending',
    portrait: await saveImage(b.portrait, 'post-images', id),
    card: await saveImage(b.card, 'post-cards', id),
    masked: {},
    createdAt: Date.now()
  };
  if (!post.card) throw httpError(400, '卡面导出失败，请重试。');
  DB.posts.push(post);
  save();
  if (approved) addMessage('system', { text: '「' + u.nickname + '」投稿了新怪谈《' + name + '》，已放入怪谈档案。' });
  broadcast('post', publicPost(post));
  sendJSON(res, 200, { ok: true, status: post.status, post: publicPost(post) });
});

route('GET', /^\/api\/messages$/, async (req, res, m, url) => {
  const after = Number(url.searchParams.get('after') || 0);
  /* 发言人名字按 userId 实时解析网名，改名后旧消息也统一显示；并附带禁言状态 */
  const list = (after ? DB.messages.filter(x => x.id > after) : DB.messages.slice(-200)).map(x => {
    if (x.kind !== 'chat' || !x.userId) return x;
    const u = DB.users.find(y => y.id === x.userId);
    if (!u) return x;
    const out = Object.assign({}, x);
    if (u.nickname && u.nickname !== x.nickname) out.nickname = u.nickname;
    out.muted = isMutedUser(u);
    out.noProfile = isNoProfileUser(u);
    return out;
  });
  sendJSON(res, 200, list);
});

route('POST', /^\/api\/messages$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  if (u.status !== 'approved') throw httpError(403, '账号审核中，通过审核后即可发言。');
  /* 被禁言的用户不能发聊天 */
  if (isMutedUser(u)) {
    const d = new Date(u.mutedUntil);
    throw httpError(403, '您已被禁言（至 ' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '）。');
  }
  const b = await readJSON(req);
  const body = requireText(b.text, 500, '发言');
  const msg = addMessage('chat', { userId: u.id, nickname: u.nickname, avatar: u.avatar, text: body });
  sendJSON(res, 200, msg);
});

/* 当前在线人数（聊天室展示用） */
route('GET', /^\/api\/online$/, async (req, res) => {
  sendJSON(res, 200, onlineSnapshot());
});

route('GET', /^\/api\/events$/, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  /* 记录这条连接属于谁，用于在线人数统计（未登入按访客计一次） */
  const su = sessionUser(req);
  res.__online = su ? { uid: su.id, nickname: su.nickname } : null;
  sseClients.add(res);
  res.write('event: online\ndata: ' + JSON.stringify(onlineSnapshot()) + '\n\n');
  req.on('close', () => { sseClients.delete(res); broadcastOnline(); });
  broadcastOnline();
});

/* 用户自助修改自己的头像 / 立绘 / 设卡 */
route('POST', /^\/api\/me\/image$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  const b = await readJSON(req);
  const slot = SLOT_DIR.users[b.slot] ? b.slot : null;
  if (!slot) throw httpError(400, '不支持的图片位置。');
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.dataUrl || '').trim());
  if (!m) throw httpError(400, '图片仅支持 PNG / JPG / WebP 的 base64。');
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length || buf.length > 20 * 1024 * 1024) throw httpError(400, '图片大小不合法（最多 20 MB）。');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const dir = SLOT_DIR.users[slot];
  await fsp.mkdir(path.join(FILES, dir), { recursive: true });
  const name = u.id + '.' + ext;
  for (const e of ['png', 'jpg', 'webp']) {
    if (e === ext) continue;
    const old = path.join(FILES, dir, u.id + '.' + e);
    if (fs.existsSync(old)) { try { await fsp.unlink(old); } catch {} }
  }
  await fsp.writeFile(path.join(FILES, dir, name), buf);
  u[slot] = verUrl('/files/' + dir + '/' + name);
  save();
  broadcast('user', publicUser(u));
  sendJSON(res, 200, { ok: true, url: u[slot], user: fullUser(u) });
});

/* ---------- 管理员 ---------- */
function needAdmin(req) { if (!isAdmin(req)) throw httpError(401, '需要管理员登入。'); }

route('POST', /^\/api\/admin\/login$/, async (req, res) => {
  const b = await readJSON(req);
  const username = requireText(b.username, 40, '账号');
  const password = String(b.password == null ? '' : b.password);
  if (username !== DB.config.adminUser || hashPass(password, DB.config.salt) !== DB.config.adminPassHash) {
    throw httpError(403, '管理员账号或密码错误。');
  }
  const token = crypto.randomBytes(24).toString('hex');
  DB.sessions[token] = { admin: true };
  save();
  setCookie(res, 'ff_admin', token, { maxAge: 60 * 60 * 12 });
  sendJSON(res, 200, { ok: true });
});

route('POST', /^\/api\/admin\/logout$/, async (req, res) => {
  const token = cookies(req).ff_admin;
  if (token) { delete DB.sessions[token]; save(); }
  clearCookie(res, 'ff_admin');
  sendJSON(res, 200, { ok: true });
});

route('GET', /^\/api\/admin\/overview$/, async (req, res) => {
  needAdmin(req);
  sendJSON(res, 200, {
    counts: {
      users: DB.users.length,
      pendingUsers: DB.users.filter(u => u.status === 'pending').length,
      posts: DB.posts.length,
      pendingPosts: DB.posts.filter(p => p.status === 'pending').length,
      messages: DB.messages.length,
      channels: (DB.channels || []).length,
      threads: (DB.threads || []).filter(t => !t.deleted).length
    },
    users: DB.users.slice().reverse().map(fullUser),
    posts: DB.posts.slice().reverse().map(publicPost),
    messages: DB.messages.slice(-80).reverse(),
    config: {
      adminUser: DB.config.adminUser,
      autoApproveUsers: !!DB.config.autoApproveUsers,
      autoApprovePosts: !!DB.config.autoApprovePosts,
      motd: DB.config.motd || ''
    }
  });
});

route('POST', /^\/api\/admin\/users\/([a-z0-9]+)\/(approve|reject|delete)$/, async (req, res, m) => {
  needAdmin(req);
  const u = DB.users.find(x => x.id === m[1]);
  if (!u) throw httpError(404, '未找到该用户。');
  if (m[2] === 'delete') {
    DB.users = DB.users.filter(x => x.id !== u.id);
    for (const [token, s] of Object.entries(DB.sessions)) if (s.userId === u.id) delete DB.sessions[token];
    addMessage('system', { text: '管理员移除了账号「' + u.nickname + '」。' });
  } else {
    u.status = m[2] === 'approve' ? 'approved' : 'rejected';
    if (u.status === 'approved') addMessage('system', { text: '「' + u.nickname + '」通过审核，加入怪啖论坛。' });
  }
  save();
  broadcast('user', publicUser(u));
  sendJSON(res, 200, { ok: true, user: fullUser(u) });
});

route('POST', /^\/api\/admin\/posts\/([a-z0-9]+)\/(approve|reject|delete|toggleClosed)$/, async (req, res, m) => {
  needAdmin(req);
  const p = DB.posts.find(x => x.id === m[1]);
  if (!p) throw httpError(404, '未找到该怪谈。');
  if (m[2] === 'delete') {
    DB.posts = DB.posts.filter(x => x.id !== p.id);
    addMessage('system', { text: '管理员移除了怪谈《' + p.name + '》。' });
  } else if (m[2] === 'toggleClosed') {
    p.closed = !p.closed;
  } else {
    p.status = m[2] === 'approve' ? 'approved' : 'rejected';
    if (p.status === 'approved') addMessage('system', { text: '「' + p.author + '」投稿的新怪谈《' + p.name + '》通过审核，已放入怪谈档案。' });
  }
  save();
  broadcast('post', publicPost(p));
  sendJSON(res, 200, { ok: true, post: publicPost(p) });
});

route('POST', /^\/api\/admin\/messages\/(\d+)\/delete$/, async (req, res, m) => {
  needAdmin(req);
  let b = {};
  try { b = await readJSON(req); } catch {}
  const mode = b.mode === 'trace' ? 'trace' : 'purge';
  const id = Number(m[1]);
  const msg = DB.messages.find(x => x.id === id);
  if (!msg) throw httpError(404, '未找到该消息。');
  if (mode === 'trace') {
    // 带痕：保留说话人(kind/nickname/userId/avatar/ts)，仅替换内容并显示红字标记
    msg.adminDeleted = true;
    msg.text = '【管理员已删除】';
    save();
    broadcast('messageUpdate', msg);
    sendJSON(res, 200, { ok: true, mode });
    return;
  }
  // 无痕：整条移除
  DB.messages = DB.messages.filter(x => x.id !== id);
  save();
  broadcast('messageDelete', { id });
  sendJSON(res, 200, { ok: true, mode });
});

route('POST', /^\/api\/admin\/announce$/, async (req, res) => {
  needAdmin(req);
  const b = await readJSON(req);
  const body = requireText(b.text, 500, '公告');
  const msg = addMessage('system', { nickname: '论坛管理', text: body });
  sendJSON(res, 200, msg);
});

route('GET', /^\/api\/admin\/config$/, async (req, res) => {
  needAdmin(req);
  sendJSON(res, 200, {
    adminUser: DB.config.adminUser,
    autoApproveUsers: !!DB.config.autoApproveUsers,
    autoApprovePosts: !!DB.config.autoApprovePosts,
    motd: DB.config.motd || ''
  });
});

route('POST', /^\/api\/admin\/config$/, async (req, res) => {
  needAdmin(req);
  const b = await readJSON(req);
  if ('autoApproveUsers' in b) DB.config.autoApproveUsers = !!b.autoApproveUsers;
  if ('autoApprovePosts' in b) DB.config.autoApprovePosts = !!b.autoApprovePosts;
  if ('motd' in b) DB.config.motd = text(b.motd, 300, '公告栏文字');
  save();
  broadcast('config', { motd: DB.config.motd || '' });
  sendJSON(res, 200, { ok: true });
});

/* ---------- 档案修改：打码编辑器 / 打码保护 / 文字编辑 ---------- */
const SLOT_DIR = {
  users: { avatar: 'avatars', portrait: 'portraits', card: 'cards' },
  posts: { portrait: 'post-images', card: 'post-cards' }
};
function recordOf(kind, id) {
  const list = kind === 'users' ? DB.users : DB.posts;
  return list.find(x => x.id === id);
}
function origPathOf(filePath) {
  const ext = path.extname(filePath);
  return filePath.slice(0, -ext.length) + '.orig' + ext;
}
async function dataUrlOf(filePath) {
  const buf = await fsp.readFile(filePath);
  const ext = path.extname(filePath).slice(1);
  const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

route('POST', /^\/api\/admin\/image$/, async (req, res) => {
  needAdmin(req);
  const b = await readJSON(req);
  const kind = b.kind === 'posts' ? 'posts' : 'users';
  const slot = SLOT_DIR[kind][b.slot] ? b.slot : null;
  if (!slot) throw httpError(400, '不支持的图片位置。');
  const rec = recordOf(kind, requireText(b.id, 40, '档案'));
  if (!rec) throw httpError(404, '未找到该档案。');
  const dir = SLOT_DIR[kind][slot];
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.dataUrl || '').trim());
  if (!m) throw httpError(400, '图片仅支持 PNG / JPG / WebP 的 base64。');
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length || buf.length > 20 * 1024 * 1024) throw httpError(400, '图片大小不合法。');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  await fsp.mkdir(path.join(FILES, dir), { recursive: true });
  const oldUrl = rec[slot];
  let oldPath = null;
  if (oldUrl && oldUrl.startsWith('/files/')) oldPath = path.join(FILES, fileRel(oldUrl));
  if (oldPath && fs.existsSync(oldPath)) {
    const orig = origPathOf(oldPath);
    if (!fs.existsSync(orig)) await fsp.copyFile(oldPath, orig); // 保留原始备份
  }
  // 清掉同 id 的其他扩展名旧文件（不动 .orig 备份）
  for (const e of ['png', 'jpg', 'webp']) {
    if (e === ext) continue;
    const old = path.join(FILES, dir, rec.id + '.' + e);
    if (fs.existsSync(old)) { try { await fsp.unlink(old); } catch {} }
  }
  const name = rec.id + '.' + ext;
  await fsp.writeFile(path.join(FILES, dir, name), buf);
  rec[slot] = verUrl('/files/' + dir + '/' + name);
  save();
  broadcast(kind === 'users' ? 'user' : 'post', kind === 'users' ? publicUser(rec) : publicPost(rec));
  sendJSON(res, 200, { ok: true, url: rec[slot] });
});

route('GET', /^\/api\/admin\/image$/, async (req, res, m, url) => {
  needAdmin(req);
  const file = url.searchParams.get('file') || '';
  if (!/^\/files\/(avatars|portraits|cards|post-images|post-cards)\/[a-z0-9]+\.(png|jpg|webp)(\?v=\d+)?$/.test(file)) throw httpError(400, '文件路径不合法。');
  const filePath = path.join(FILES, fileRel(file));
  const target = url.searchParams.get('orig') === '1' ? origPathOf(filePath) : filePath;
  if (!fs.existsSync(target)) throw httpError(404, '没有该文件（或没有原始备份）。');
  sendJSON(res, 200, { dataUrl: await dataUrlOf(target) });
});

route('POST', /^\/api\/admin\/mask$/, async (req, res) => {
  needAdmin(req);
  const b = await readJSON(req);
  const kind = b.kind === 'posts' ? 'posts' : 'users';
  if (!SLOT_DIR[kind][b.slot]) throw httpError(400, '不支持的图片位置。');
  const rec = recordOf(kind, requireText(b.id, 40, '档案'));
  if (!rec) throw httpError(404, '未找到该档案。');
  rec.masked = rec.masked || {};
  rec.masked[b.slot] = !!b.masked;
  save();
  broadcast(kind === 'users' ? 'user' : 'post', kind === 'users' ? publicUser(rec) : publicPost(rec));
  sendJSON(res, 200, { ok: true, masked: rec.masked });
});

route('POST', /^\/api\/admin\/users\/([a-z0-9]+)\/edit$/, async (req, res, m) => {
  needAdmin(req);
  const u = DB.users.find(x => x.id === m[1]);
  if (!u) throw httpError(404, '未找到该用户。');
  const b = await readJSON(req);
  const p = b.public || {}, a = b.archive || {};
  if ('nickname' in b && b.nickname !== u.nickname) {
    u.nickname = checkNicknameAvailable(b.nickname, u.id);
  }
  u.public = {
    gender: text(p.gender, 12, '公开性别') || '保密',
    age: text(p.age, 4, '公开年龄'),
    signature: text(p.signature, 60, '个性签名'),
    intro: text(p.intro, 180, '个人简介')
  };
  /* 字段级合并：未提交的字段保留原值（防止旧页面/空档案载荷清空真实档案） */
  const prevArchive = u.archive || {};
  u.archive = {
    realName: text('realName' in a ? a.realName : (prevArchive.realName || ''), 24, '姓名'), realGender: text('realGender' in a ? a.realGender : (prevArchive.realGender || ''), 12, '性别'),
    realAge: text('realAge' in a ? a.realAge : (prevArchive.realAge || ''), 12, '年龄'), species: text('species' in a ? a.species : (prevArchive.species || ''), 24, '种族'),
    height: text('height' in a ? a.height : (prevArchive.height || ''), 12, '身高'), history: text('history' in a ? a.history : (prevArchive.history || ''), 1000, '人物设定')
  };
  save();
  broadcast('user', publicUser(u));
  sendJSON(res, 200, { ok: true, user: fullUser(u) });
});

route('POST', /^\/api\/admin\/posts\/([a-z0-9]+)\/edit$/, async (req, res, m) => {
  needAdmin(req);
  const p = DB.posts.find(x => x.id === m[1]);
  if (!p) throw httpError(404, '未找到该怪谈。');
  const b = await readJSON(req);
  /* 归属修正：投稿玩家（authorId，null/空串=匿名）与设主（owner 文本） */
  if ('authorId' in b) {
    if (b.authorId === null || b.authorId === '') {
      p.authorId = null;
      p.author = '匿名';
    } else {
      const au = DB.users.find(x => x.id === b.authorId);
      if (!au) throw httpError(404, '未找到该投稿玩家账号。');
      p.authorId = au.id;
      p.author = au.nickname;
    }
  }
  if ('owner' in b) p.owner = text(b.owner, 24, '设主') || null;
  p.name = requireText(b.name, 60, '怪谈名称');
  p.area = requireText(b.area, 160, '怪谈影响范围');
  p.mechanism = text(b.mechanism, 300, '怪谈机制');
  p.countermeasures = text(b.countermeasures, 300, '怪谈对策');
  if (b.type === 'puzzle' || b.type === 'combat') p.type = b.type;
  if (b.sharing === 'yes' || b.sharing === 'no') { p.sharing = b.sharing; p.closed = b.sharing === 'no'; }
  save();
  broadcast('post', publicPost(p));
  sendJSON(res, 200, { ok: true, post: publicPost(p) });
});

/* ---------- 频道 / 帖子 / 公告 / 搜索 / 站内消息 扩展 ---------- */
const forum = installForum({
  DB, save, route, broadcast, saveImage, addMessage,
  sessionUser, isAdmin, isAdminRole, isNoProfileUser, needAdmin,
  httpError, sendJSON, readJSON, text, requireText, uid,
  FILES, path, fs, fsp, getVisits: todayVisits
});

/* ---------- 请求分发 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(pathname);
        if (m) { await r.handler(req, res, m, url); return; }
      }
      throw httpError(404, '接口不存在。');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, '方法不允许。');
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (pathname.startsWith('/files/')) {
      const rel = pathname.slice('/files/'.length);
      if (!/^[a-z-]+\/[a-z0-9-]+\.(png|jpg|webp)$/.test(rel)) return notFound(res);
      return await serveFile(req, res, path.join(FILES, rel));
    }
    if (pathname.startsWith('/tools/card/')) {
      const rel = pathname.slice('/tools/card/'.length);
      const inject = rel === 'fantaforum_card.html' && url.searchParams.get('web') === '1';
      return await serveFile(req, res, safeJoin(TOOL_CARD, rel) || '', { injectBridge: inject });
    }
    if (pathname.startsWith('/tools/guaitan/')) {
      const rel = pathname.slice('/tools/guaitan/'.length);
      const inject = rel === 'guaitan_card.html' && url.searchParams.get('web') === '1';
      return await serveFile(req, res, safeJoin(TOOL_GUAI, rel) || '', { injectBridge: inject });
    }
    const rel = pathname === '/' ? 'home.html' : pathname.slice(1);
    const filePath = safeJoin(SITE, rel);
    if (!filePath) return notFound(res);
    return await serveFile(req, res, filePath, { countVisit: req.method === 'GET' });
  } catch (err) {
    if (res.headersSent) { res.end(); return; }
    const code = err.code && Number.isInteger(err.code) ? err.code : 500;
    if (code === 500) console.error('[server]', err);
    sendJSON(res, code, { error: err.message || '服务器错误。' });
  }
});

loadDb().then(() => {
  const migrated = forum.migrate();
  if (migrated.channels || migrated.threads) console.log('[forum] 频道 ' + migrated.channels + ' 个，帖子 ' + migrated.threads + ' 条');
  server.listen(PORT, HOST, () => {
    console.log('怪啖论坛已启动：http://' + HOST + ':' + PORT + '/');
    console.log('数据目录：' + DATA);
    console.log('管理员：' + DB.config.adminUser + '（初始密码见启动说明）');
  });
});
