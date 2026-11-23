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
const os = require('os');
const { execFile } = require('child_process');
const zlib = require('zlib');
const installForum = require('./server-forum');
const installRoot = require('./server-root');

const ROOT = __dirname;
const SITE = path.join(ROOT, 'site');
/* 禁封账号统一替换为封号头像（新增：禁封功能） */
const BANNED_AVATAR = '/assets/banned.svg';
const TOOL_CARD = path.join(ROOT, '怪啖论坛制卡工具');
const TOOL_GUAI = path.join(ROOT, '怪谈档案制卡工具');
const DATA = path.resolve(process.env.FANTA_DATA || path.join(ROOT, 'data'));
const FILES = path.join(DATA, 'files');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const BODY_LIMIT = 96 * 1024 * 1024;

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
  /* 表情包字段：老数据库没有这两项，补一个「默认」分组，保证第一次打开就能上传 */
  let emojiInit = false;
  if (!Array.isArray(DB.emojis)) { DB.emojis = []; emojiInit = true; }
  if (!Array.isArray(DB.emojiGroups) || !DB.emojiGroups.length) {
    DB.emojiGroups = [{ id: 1, name: '默认', createdAt: Date.now(), createdBy: null }];
    emojiInit = true;
  }
  if (typeof DB.emojiSeq !== 'number') { DB.emojiSeq = 0; emojiInit = true; }
  if (typeof DB.emojiGroupSeq !== 'number') { DB.emojiGroupSeq = 1; emojiInit = true; }
  if (emojiInit) await save();
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
  const u = DB.users.find(x => x.id === s.userId);
  /* 禁封账号视为未登入：所有发言/发帖/改资料接口统一拦住（新增：禁封功能） */
  if (!u || u.banned) return null;
  return u;
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
/* ---------- 等级 / 勋章 / 成就 / 签到（新增） ----------
 * 数据落在用户对象：achievements{id:ts} / loginDays[YYYY-MM-DD] / checkin{last,streak,total}。
 * 等级不落库，按发帖数·获赞数·档案数实时算，数据始终与内容一致（允许刷，不做防刷）。 */
const ACHIEVEMENTS = [
  { id: 'hello_world',  icon: '言',  name: '你好世界',     desc: '在聊天室说第一句话' },
  { id: 'spam_machine', icon: '刷',  name: '刷屏机器',     desc: '在聊天室连续发 4 条，中间无人插话（系统不算）' },
  { id: 'home_forum',   icon: '坛',  name: '论坛是我家',   desc: '累计登入论坛 7 天' },
  { id: 'dont_confirm', icon: '窥',  name: '似乎被盯上了', desc: '在弹窗「请勿确认」中选择了确认' },
  { id: 'contributor',  icon: '贡',  name: '社区贡献值',   desc: '发布 5 条帖子' },
  { id: 'emoji_master', icon: '表',  name: '表情包大师',   desc: '上传 5 条表情包' },
  { id: 'cleaner',      icon: '净',  name: '净坛使者',     desc: '进行了一次举报' },
  { id: 'heart',        icon: '心',  name: '因你心动',     desc: '关注了一个人' },
  { id: 'is_this',      icon: '？', name: '这是？',       desc: '点开用户「???」的人设卡' },
  { id: 'eaten',        icon: '404', name: '被吃掉了',    desc: '触发 404 界面' },
  { id: 'night_fail',   icon: '夜',  name: '跨夜失败',     desc: '触发首页过 00:00 的彩蛋' }
];
/* 只有纯彩蛋类允许前端直接解锁；内容类（发帖/举报/关注等）一律由服务端判定 */
const ACH_FRONT_UNLOCK = ['dont_confirm', 'is_this', 'eaten', 'night_fail'];
const LEVEL_TITLES = [
  { min: 0,    title: '无名访客' },
  { min: 20,   title: '门外徘徊者' },
  { min: 60,   title: '初入门径' },
  { min: 140,  title: '热心的听众' },
  { min: 280,  title: '怪谈记录者' },
  { min: 500,  title: '异常调查员' },
  { min: 850,  title: '档案守夜人' },
  { min: 1400, title: '诡异杀手' },
  { min: 2200, title: '一线攻略组' },
  { min: 3500, title: '新世界' }
];
function beijingDay(ts) {
  return new Date((ts || Date.now()) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function userGrowth(u) {
  const uid = u && u.id;
  let threads = 0, likes = 0, archives = 0;
  if (uid) {
    /* 帖子维度：只统计本人发布的主题（发帖数 + 主题获赞）
       回复维度：遍历全部未删除主题，凡本人回复不论主题作者是谁都计入获赞
       （修正：此前回复获赞只在本人主题内统计，导致在他人主题下的回复获赞漏算） */
    for (const t of (DB.threads || [])) {
      if (t.deleted) continue;
      if (t.authorId === uid) {
        threads++;
        likes += (t.likes || []).length;
      }
      for (const r of (t.replies || [])) if (!r.deleted && r.authorId === uid) likes += (r.likes || []).length;
    }
    for (const p of (DB.posts || [])) if (p.status === 'approved' && (p.submitterId === uid || p.authorId === uid)) archives++;
  }
  /* 发帖 ×10 + 获赞 ×3 + 档案 ×20 */
  const score = threads * 10 + likes * 3 + archives * 20;
  let idx = 0;
  for (let i = 0; i < LEVEL_TITLES.length; i++) if (score >= LEVEL_TITLES[i].min) idx = i;
  const cur = LEVEL_TITLES[idx], next = LEVEL_TITLES[idx + 1] || null;
  return {
    lv: idx + 1, title: cur.title, score,
    nextScore: next ? next.min : null,
    percent: next ? Math.min(100, Math.round((score - cur.min) / (next.min - cur.min) * 100)) : 100,
    stats: { threads, likes, archives }
  };
}
function unlockAchievement(u, id) {
  const def = ACHIEVEMENTS.find(a => a.id === id);
  if (!u || !def) return false;
  u.achievements = u.achievements || {};
  if (u.achievements[id]) return false;
  u.achievements[id] = Date.now();
  save();
  /* 解锁瞬间推给本人：前端据此发系统通知 / 页内横幅 */
  broadcastTo(u.id, 'achievement', { id, name: def.name, icon: def.icon, ts: u.achievements[id] });
  return true;
}
function recordLoginDay(u) {
  if (!u) return false;
  const days = Array.isArray(u.loginDays) ? u.loginDays : (u.loginDays = []);
  const day = beijingDay();
  if (days.indexOf(day) >= 0) return false;
  days.push(day);
  if (days.length > 400) { days.splice(0, days.length - 400); }
  if (days.length >= 7) unlockAchievement(u, 'home_forum');
  save();
  return true;
}
function publicUser(u) {
  const muted = !!u.mutedUntil && Date.now() < u.mutedUntil;
  const c = u.checkin || {};
  return {
    id: u.id, nickname: u.nickname, playerName: u.playerName || '',
    /* 禁封账号展示封号头像，并带 banned 标记供前端显示「已禁封」（新增：禁封功能） */
    avatar: u.banned ? BANNED_AVATAR : u.avatar,
    banned: !!u.banned,
    status: u.status,
    muted, mutedUntil: muted ? u.mutedUntil : null,
    noProfile: isNoProfileUser(u),
    public: u.public, portrait: u.portrait || null, card: u.card || null,
    masks: u.masks || {}, createdAt: u.createdAt,
    /* 等级 / 勋章 / 成就 / 签到（新增） */
    level: userGrowth(u),
    medals: Array.isArray(u.medals) ? u.medals.slice() : [],
    achievements: Object.assign({}, u.achievements || {}),
    checkin: { streak: c.streak || 0, total: c.total || 0, todayDone: c.last === beijingDay() }
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
  /* 投稿人一律以投稿时页面填写的文本为准（@？？？ / 匿名），不按玩家账号反查网名。
     authorId 只表示「这个名字对应到哪张角色卡」，用于点击跳转；找不到就是 null。 */
  const u = p.authorId && DB.users.find(x => x.id === p.authorId);
  return {
    id: p.id, type: p.type, name: p.name,
    authorId: p.authorId || null,
    author: p.author || (u && u.nickname) || '匿名',
    owner: p.owner || (u && u.playerName) || null,
    area: p.area,
    mechanism: p.mechanism, countermeasures: p.countermeasures, sharing: p.sharing,
    closed: p.closed, status: p.status, portrait: p.portrait || null, card: p.card,
    masks: p.masks || {},
    createdAt: p.createdAt, editedAt: p.editedAt || null
  };
}

/* 投稿人可编辑判定（新增：投稿人编辑档案）
 * 实际投稿账号 submitterId 或档案署名对应账号 authorId，本人且已过审即可编辑。
 * 匿名投稿（authorId 为空）仍可由实际投稿账号按 submitterId 认领编辑。 */
function canEditPost(req, p) {
  const u = sessionUser(req);
  if (!u || u.status !== 'approved') return false;
  return u.id === p.submitterId || (!!p.authorId && u.id === p.authorId);
}

/* 黑方块打码坐标规范化：0~1 相对坐标，每图最多 30 块（新增：黑方块打码） */
function normMasks(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const slot of ['avatar', 'card', 'portrait']) {
    if (!Array.isArray(src[slot])) continue;
    out[slot] = src[slot].slice(0, 30).map(r => {
      const x = Math.max(0, Math.min(1, Number(r && r.x) || 0));
      const y = Math.max(0, Math.min(1, Number(r && r.y) || 0));
      const w = Math.max(0.005, Math.min(1 - x, Number(r && r.w) || 0));
      const h = Math.max(0.005, Math.min(1 - y, Number(r && r.h) || 0));
      return { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) };
    });
  }
  return out;
}

/* ---------- 投稿 → 频道帖子同步 ----------
 * 所有怪谈投稿统一同步到「怪谈故事」（仅作档案留存）。
 * 帖子作者只认页面填写的投稿人文本；能对应到角色卡时挂 authorId 供点击跳转，
 * 对应不到（或「匿名」「档案」这类无主页角色）就不挂，避免化名投稿被账号暴露。
 */
function syncPostToForum(post) {
  if (!post) return null;
  if (!Array.isArray(DB.channels) || !DB.channels.length) return null;
  if (!Array.isArray(DB.threads)) DB.threads = [];
  /* 同一份档案只同步一次（重复审核 / 改档都不会再发一条） */
  if (DB.threads.some(t => t.source && t.source.kind === 'archive' && t.source.postId === post.id)) return null;
  /* 投稿统一归入「怪谈故事」，不再按是否公开分发到调查委托 */
  const wantName = '怪谈故事';
  const ch = DB.channels.find(c => c.name === wantName)
    || DB.channels.find(c => c.name === '怪谈故事') || DB.channels[0];
  if (!ch) return null;
  const body = [
    '影响范围：' + (post.area || '（未填写）'),
    '机制：' + (post.mechanism || '（未填写）'),
    (post.type === 'puzzle' ? '谜底：' : '对策：') + (post.countermeasures || '（未填写）')
  ].join('\n');
  const owner = post.authorId ? DB.users.find(x => x.id === post.authorId) : null;
  const t = {
    id: uid(), channelId: ch.id, title: post.name, body,
    images: [post.card, post.portrait].filter(Boolean),
    authorId: post.authorId || null,
    author: post.author || '匿名',
    avatar: (owner && owner.avatar) || null,
    anon: false, authorNoProfile: !post.authorId,
    createdAt: Date.now(), updatedAt: Date.now(),
    likes: [], replies: [], pinned: false, pinnedBy: null,
    deleted: false, deletedBy: null, status: 'approved',
    source: { kind: 'archive', postId: post.id }
  };
  DB.threads.push(t);
  broadcast('thread', t);
  return t;
}

/* ---------- SSE ---------- */
const sseClients = new Set();
function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}
/* 只推给某个账号自己的 SSE 连接（成就解锁等私人事件，不广播给其他人） */
function broadcastTo(userId, event, data) {
  if (!userId) return;
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) {
    const o = res.__online;
    if (o && o.uid === userId) { try { res.write(payload); } catch {} }
  }
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
  /* 聊天消息实时推送也要带 noProfile：unknown 组（？？？除外）的头像与网名不可点。
     /api/messages 读取时仍按当前账号状态重算，避免这里存的标记过期。 */
  if (msg.kind === 'chat' && msg.userId) {
    const u = DB.users.find(x => x.id === msg.userId);
    if (u) {
      msg.noProfile = isNoProfileUser(u); msg.muted = isMutedUser(u);
      /* 聊天室显示发言人等级：随消息一起广播 */
      if (!u.banned) msg.level = userGrowth(u).lv;
      /* 禁封账号发出的聊天消息直接按已清除处理，实时广播也一致（新增：禁封功能） */
      if (u.banned) {
        msg.banned = true;
        msg.bannedCleared = true;
        msg.avatar = BANNED_AVATAR;
        msg.text = '【已清除】';
      }
    }
  }
  DB.messages.push(msg);
  if (DB.messages.length > 5000) DB.messages.splice(0, DB.messages.length - 5000);
  save();
  broadcast('message', msg);
  return msg;
}

/* 禁封账号：撤销会话，并把该账号的历史聊天/帖子/评论打上有痕清除标记（新增：禁封功能） */
function applyUserBan(u, banned) {
  banned = !!banned;
  if (u.banned === banned) return;
  u.banned = banned;
  if (!banned) return; // 解封不恢复已清除的内容，避免旧内容复活
  for (const [token, s] of Object.entries(DB.sessions)) if (s.userId === u.id) delete DB.sessions[token];
  for (const m of DB.messages || []) {
    if (m.kind === 'chat' && m.userId === u.id) {
      m.bannedCleared = true;
      m.avatar = BANNED_AVATAR;
    }
  }
  for (const t of DB.threads || []) {
    if (t.authorId === u.id) t.bannedCleared = true;
    for (const r of (t.replies || [])) if (r.authorId === u.id) r.bannedCleared = true;
  }
}

/* ---------- 图片 ---------- */
/* 上传拦截：所有非 WebP 图片在落盘前统一转码
 * 浏览器回退路径（老 Safari 的 canvas.toDataURL、publish.html 的默认 PNG）以及
 * 制卡工具直传都可能塞进 PNG / JPEG。这里从源头断掉，避免 PNG 再进磁盘。
 * 编码用系统 cwebp（libwebp 官方编码器），不引入 npm 依赖。
 * cwebp 缺失或转码失败时降级保存原格式，绝不因为压缩让上传直接报错。
 */
const WEBP_QUALITY = 90;  // 与站内已有图片同一档质量
const WEBP_METHOD = 6;    // 编码耗时换压缩率：上传是低频操作，值得
let cwebpMissing = false;

function cwebpEncode(buf, srcExt) {
  return new Promise(resolve => {
    if (cwebpMissing) return resolve(null);
    const tag = crypto.randomBytes(8).toString('hex');
    const src = path.join(os.tmpdir(), 'ff-upload-' + tag + '.' + (srcExt === 'jpeg' ? 'jpg' : srcExt));
    const dst = path.join(os.tmpdir(), 'ff-upload-' + tag + '.webp');
    const cleanup = () => { for (const f of [src, dst]) { try { fs.unlinkSync(f); } catch {} } };
    fs.writeFile(src, buf, err => {
      if (err) { cleanup(); return resolve(null); }
      execFile('cwebp', ['-quiet', '-q', String(WEBP_QUALITY), '-m', String(WEBP_METHOD),
        '-metadata', 'icc', src, '-o', dst], { timeout: 60000 }, async e => {
        let out = null;
        if (!e) { try { out = await fsp.readFile(dst); } catch {} }
        else if (e.code === 'ENOENT') {
          cwebpMissing = true;
          console.warn('[img] 未找到 cwebp，图片按原格式保存（apt install webp 可恢复转码）。');
        } else {
          console.warn('[img] cwebp 转码失败，降级原格式：' + (e.message || e));
        }
        cleanup();
        resolve(out && out.length ? out : null);
      });
    });
  });
}

/* 解析上传的 data URL：非 WebP 一律转码，返回落盘用的 { buf, ext } */
async function decodeUpload(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || '').trim());
  if (!m) throw httpError(400, '图片仅支持 PNG / JPG / WebP 的 base64。');
  const raw = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!raw.length) throw httpError(400, '图片为空。');
  if (raw.length > 64 * 1024 * 1024) throw httpError(400, '图片过大（最多 64 MB）。');
  if (m[1] === 'webp') return { buf: raw, ext: 'webp' };
  const webp = await cwebpEncode(raw, m[1]);
  if (webp && webp.length < raw.length) return { buf: webp, ext: 'webp' };
  if (webp) console.warn('[img] WebP(' + webp.length + 'B) 不小于原图(' + raw.length + 'B)，保留原格式以免反而占更多空间');
  return { buf: raw, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };  // 降级：转码无收益或 cwebp 不可用
}

async function saveImage(dataUrl, kind, id) {
  if (!dataUrl) return null;
  const { buf, ext } = await decodeUpload(dataUrl);
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

/* ---------- 表情包（全站共用，不分账号） ----------
 * 每个表情固定 256×256 透明底 WebP，只存一份，所有分组下的成员共享。
 * 聊天消息与帖子正文里的占位符写作 [emoji:<数字id>]，渲染时替换成图片。
 */
const EMOJI_SIZE = 256;      // 固定画布尺寸（正方）
const EMOJI_DIR = 'emojis';
const EMOJI_MAX = 600;       // 全站上限，防止无限堆积

/* 读 WebP 头拿宽高（VP8X / VP8 / VP8L 三种容器） */
function webpSize(buf) {
  if (!buf || buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = buf.toString('ascii', 12, 16);
  if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (fmt === 'VP8 ') {
    const i = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (i < 0 || i + 7 > buf.length) return null;
    return { w: buf.readUInt16LE(i + 3) & 0x3fff, h: buf.readUInt16LE(i + 5) & 0x3fff };
  }
  if (fmt === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function emojiSnapshot() {
  const groups = (DB.emojiGroups || []).map(g => ({
    id: g.id, name: g.name,
    count: (DB.emojis || []).filter(e => e.groupId === g.id).length
  }));
  const emojis = (DB.emojis || []).map(e => ({ id: e.id, groupId: e.groupId, name: e.name, url: e.file }));
  return { size: EMOJI_SIZE, groups, emojis };
}

/* 写表情文件：一次上传一个文件，删表情时连文件一起删 */
async function saveEmojiFile(id, buf, ext) {
  const dir = path.join(FILES, EMOJI_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const name = id + '.' + ext;
  await fsp.writeFile(path.join(dir, name), buf);
  return '/files/' + EMOJI_DIR + '/' + name;
}

async function removeEmojiFile(rel) {
  if (!rel) return;
  const p = path.join(FILES, fileRel(rel));
  try { await fsp.unlink(p); } catch (err) { if (err.code !== 'ENOENT') console.warn('[emoji] 删文件失败:', rel, err.message); }
}

/* 管理权限：登入且已过审的账号都能管理（访客与待审账号不能） */
function emojiEditor(req) {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  if (u.status !== 'approved') throw httpError(403, '账号审核通过后才能管理表情包。');
  return u;
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
  if (countVisit && ext === '.html') {
    bumpVisit();
    if (rootMon) rootMon.recordVisit(req, filePath); /* root 监控页自身已在模块内排除 */
  }
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
  /* 累计登录天数（新增：成就「论坛是我家」）：按北京时间自然日去重，满 7 天解锁 */
  if (u && u.status === 'approved') recordLoginDay(u);
  sendJSON(res, 200, {
    user: u ? Object.assign(publicUser(u), { playerName: u.playerName }) : null,
    admin: isAdmin(req),
    adminByRole: isAdminRole(sessionUser(req)),
    config: { motd: DB.config.motd || '' },
    /* unknown 组无主页角色（匿名/档案馆/广告位）：前端据此让「根本无法点击」 */
    noProfileIds: DB.users.filter(isNoProfileUser).map(x => x.id),
    /* 关注：带上「我关注了谁」的 id 列表，供主页按钮显示状态（新增：关注功能） */
    following: u ? (u.following || []).slice() : [],
    unread: u ? (DB.notifications || []).filter(n => n.targetId === u.id && n.ts > (u.lastNoticeRead || 0)).length : 0
  });
});

/* 成就定义（公开，供个人主页渲染成就墙） */
route('GET', /^\/api\/achievements$/, async (req, res) => {
  sendJSON(res, 200, ACHIEVEMENTS);
});

/* 前端彩蛋类成就解锁：仅允许白名单内的 4 个纯彩蛋成就，内容类一律服务端判定 */
route('POST', /^\/api\/achievements\/unlock$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  const b = await readJSON(req).catch(() => ({}));
  const id = String(b.id || '');
  if (ACH_FRONT_UNLOCK.indexOf(id) < 0) throw httpError(400, '该成就无法通过此方式解锁。');
  const isNew = unlockAchievement(u, id);
  const def = ACHIEVEMENTS.find(a => a.id === id);
  sendJSON(res, 200, { ok: true, unlocked: isNew, id, achievement: isNew && def ? { id: def.id, name: def.name, icon: def.icon } : null });
});

/* 签到：北京时间自然日，连续天数断签归 1 */
route('POST', /^\/api\/checkin$/, async (req, res) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  const today = beijingDay();
  const c = u.checkin || {};
  if (c.last === today) throw httpError(400, '今天已经签过了。');
  const yesterday = beijingDay(Date.now() - 86400000);
  const streak = c.last === yesterday ? (c.streak || 0) + 1 : 1;
  u.checkin = { last: today, streak, total: (c.total || 0) + 1 };
  save();
  sendJSON(res, 200, { ok: true, checkin: { streak, total: u.checkin.total, todayDone: true } });
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
  /* 自动审核通过时，与管理员手动 approve 保持一致，在聊天室广播入坛系统消息 */
  if (approved) addMessage('system', { text: '「' + nickname + '」通过审核，加入怪啖论坛。' });
  sendJSON(res, 200, { ok: true, status: user.status, user: publicUser(user) });
});

/* 诡异入侵：unknown 组登入者创建同组角色卡。
   只需要网名与头像；不生成卡面，免审核，并在聊天室广播一条系统消息。 */
route('POST', /^\/api\/invade$/, async (req, res) => {
  const me = sessionUser(req);
  if (!me || String(me.playerName || '').toLowerCase() !== 'unknown')
    throw httpError(403, '只有 unknown 组的入侵者才能创建此类角色。');
  const b = await readJSON(req);
  const nickname = requireText(b.nickname, 24, '网名');
  if (!b.avatar) throw httpError(400, '请上传头像。');
  if (DB.users.some(u => u.nickname.toLowerCase() === nickname.toLowerCase()))
    throw httpError(409, '该网名已被占用。');
  const id = uid();
  const user = {
    id, nickname, playerName: 'unknown', faction: 'unknown', status: 'approved',
    createdAt: Date.now(),
    public: { gender: '保密', age: '', signature: '', intro: '' },
    archive: { realName: '', realGender: '', realAge: '', species: '', height: '', history: '' },
    avatar: await saveImage(b.avatar, 'avatars', id),
    portrait: null, card: null, masked: {}
  };
  DB.users.push(user);
  save();
  broadcast('user', publicUser(user));
  addMessage('system', { text: '似乎有什么东西进入了论坛……' });
  sendJSON(res, 200, { ok: true, user: publicUser(user) });
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
  /* 禁封账号禁止登入，弹指定文案（新增：禁封功能） */
  if (user.banned) throw httpError(403, '对不起，该账号已被封禁');
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
    .filter(x => (x.playerName || '') === playerName && x.status !== 'rejected' && !x.banned)
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
  if (target.banned) throw httpError(403, '对不起，该账号已被封禁');
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

/* 关注 / 取消关注（新增：关注功能）
 * 关系存在「我」的用户对象 following:[userId]；只可关注已过审且有主页的角色，不可关注自己。
 * 新关注时给被关注者推送「XXX 关注了你」；被关注的人发帖时在消息页推送（见 server-forum.js 发帖路由）。 */
route('POST', /^\/api\/users\/([a-z0-9]+)\/follow$/, async (req, res, m) => {
  const me = sessionUser(req);
  if (!me || me.status !== 'approved') throw httpError(403, '请先登入已过审账号。');
  const target = DB.users.find(x => x.id === m[1] && x.status === 'approved' && !isNoProfileUser(x));
  if (!target) throw httpError(404, '未找到该用户。');
  if (target.id === me.id) throw httpError(400, '不能关注自己。');
  const b = await readJSON(req).catch(() => ({}));
  const want = b.follow === undefined ? !(me.following || []).includes(target.id) : !!b.follow;
  const list = Array.isArray(me.following) ? me.following.slice() : [];
  const at = list.indexOf(target.id);
  const newlyFollowed = want && at < 0;
  if (want && at < 0) list.push(target.id);
  if (!want && at >= 0) list.splice(at, 1);
  me.following = list;
  /* 仅首次关注推送一次「XXX 关注了你」；重复关注/取消关注都不再推送。 */
  if (newlyFollowed) {
    forum.notify(target.id, 'followUser', { id: me.id, name: me.nickname, role: 'user', avatar: me.avatar }, { profileId: me.id });
    unlockAchievement(me, 'heart');   // 成就：因你心动
  }
  save();
  sendJSON(res, 200, { ok: true, following: want, id: target.id });
});

/* 举报（新增）：只给被举报者写一条站内消息，后台不审核、不改用户状态。
 * 理由限定为页面上的五选一，避免任意文本落库。 */
const REPORT_REASONS = [
  '该用户发布广告信息', '该用户可能不是人类', '该用户发布违法信息',
  '该用户发布不实信息', '没什么纯粹急了'
];
route('POST', /^\/api\/users\/([a-z0-9]+)\/report$/, async (req, res, m) => {
  const me = sessionUser(req);
  if (!me || me.status !== 'approved') throw httpError(403, '请先登入已过审账号。');
  const target = DB.users.find(x => x.id === m[1] && x.status === 'approved' && !isNoProfileUser(x));
  if (!target) throw httpError(404, '未找到该用户。');
  const b = await readJSON(req).catch(() => ({}));
  const reason = String(b.reason || '');
  if (!REPORT_REASONS.includes(reason)) throw httpError(400, '举报理由无效。');
  forum.notify(target.id, 'reportUser', { id: me.id, name: me.nickname, role: 'user', avatar: me.avatar }, { profileId: me.id, reason });
  unlockAchievement(me, 'cleaner');   // 成就：净坛使者
  save();
  sendJSON(res, 200, { ok: true, reason });
});

route('GET', /^\/api\/posts$/, async (req, res, m, url) => {
  const all = url.searchParams.get('all') === '1' && isAdmin(req);
  const list = DB.posts.filter(p => all || p.status === 'approved');
  sendJSON(res, 200, list.slice().reverse().map(p => {
    const pub = publicPost(p);
    pub.canEdit = canEditPost(req, p);   // 前端据此显示「编辑档案」（新增：投稿人编辑）
    return pub;
  }));
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
  /* 投稿人：以页面填写的文本为准（前端已去掉开头的 @），留空即匿名 */
  const authorText = text(b.author, 24, '投稿人').replace(/^@+/, '').trim();
  /* 这个名字能对上哪张角色卡，就挂哪张的 id 供点击跳转；无主页角色（匿名 / 档案）不挂 */
  const authorRec = authorText && DB.users.find(x => x.nickname === authorText);
  const authorId = (authorRec && !isNoProfileUser(authorRec)) ? authorRec.id : null;
  /* 投稿统一归入「怪谈故事」，固定标记为不公开存档 */
  const pub = 'no';
  const owner = text(b.owner, 24, '设主') || u.playerName || '';
  const id = uid();
  /* 免审核：投稿点击即提交，直接归档；不再受后台 autoApprovePosts 开关影响 */
  const approved = true;
  const post = {
    id, type, name, area,
    author: authorText || '匿名', authorId, submitterId: u.id, owner,
    public: pub,
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
  /* 投稿即刻同步一条频道帖子到「怪谈故事」 */
  const thread = syncPostToForum(post);
  save();
  if (approved) addMessage('system', { text: '「' + post.author + '」投稿的新怪谈《' + name + '》通过审核，已放入怪谈档案。' });
  broadcast('post', publicPost(post));
  sendJSON(res, 200, { ok: true, status: post.status, post: publicPost(post), threadId: thread ? thread.id : null });
});

/* 投稿人编辑自己的怪谈档案（新增：投稿人编辑档案）
 * 实际投稿账号 submitterId 或档案署名账号 authorId 本人可改；需过审、未禁言。
 * 可改：名称/影响范围/机制/对策/类型/共享方式。设主、署名、卡面图与打码图一律不动。 */
route('POST', /^\/api\/posts\/([a-z0-9]+)\/edit$/, async (req, res, m) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  if (u.status !== 'approved') throw httpError(403, '账号审核中，通过审核后即可编辑档案。');
  if (u.banned) throw httpError(403, '账号已被禁封，无法编辑。');
  const p = DB.posts.find(x => x.id === m[1]);
  if (!p) throw httpError(404, '未找到该怪谈档案。');
  if (!canEditPost(req, p)) throw httpError(403, '只有该档案的投稿人本人可以编辑。');
  const b = await readJSON(req);
  p.name = requireText(b.name, 60, '怪谈名称');
  p.area = requireText(b.area, 160, '怪谈影响范围');
  p.mechanism = text(b.mechanism, 300, '怪谈机制');
  p.countermeasures = text(b.countermeasures, 300, '怪谈对策');
  if (b.type === 'puzzle' || b.type === 'combat') p.type = b.type;
  if (b.sharing === 'yes' || b.sharing === 'no') { p.sharing = b.sharing; p.closed = b.sharing === 'no'; }
  p.editedAt = Date.now();
  save();
  const pub = publicPost(p);
  broadcast('post', pub);
  sendJSON(res, 200, { ok: true, post: pub });
});

/* 投稿人保存自己怪谈档案的黑方块打码坐标（新增：黑方块打码） */
route('POST', /^\/api\/posts\/([a-z0-9]+)\/masks$/, async (req, res, m) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  if (u.status !== 'approved') throw httpError(403, '账号审核中，通过审核后才能编辑档案。');
  if (u.banned) throw httpError(403, '账号已被禁封，无法编辑。');
  const p = DB.posts.find(x => x.id === m[1]);
  if (!p) throw httpError(404, '未找到该怪谈档案。');
  if (!canEditPost(req, p)) throw httpError(403, '只有该档案的投稿人本人可以编辑。');
  const b = await readJSON(req);
  p.masks = normMasks(b.masks);
  p.editedAt = Date.now();
  save();
  const pub = publicPost(p);
  broadcast('post', pub);
  sendJSON(res, 200, { ok: true, masks: pub.masks });
});

/* ---------- 聊天存档（新增：聊天存档功能） ----------
   config.chatArchives = [{ id, title, cutoffId, count, createdAt }]
   主聊天室只显示最新存档点之后的新消息，不设条数上限；
   存档点之前的历史通过 /api/chat/archives 随时查看。 */
function chatArchives() { return DB.config.chatArchives || []; }
function latestChatCutoff() { return chatArchives().reduce((mx, a) => Math.max(mx, a.cutoffId || 0), 0); }
function decorateChatMsg(x, lvCache) {
  /* 发言人名字按 userId 实时解析网名，改名后旧消息也统一显示；并附带禁言状态 */
  if (x.kind !== 'chat' || !x.userId) return x;
  const u = DB.users.find(y => y.id === x.userId);
  if (!u) return x;
  const out = Object.assign({}, x);
  if (u.nickname && u.nickname !== x.nickname) out.nickname = u.nickname;
  out.muted = isMutedUser(u);
  out.noProfile = isNoProfileUser(u);
  /* 等级随消息实时计算（按批次缓存，避免每条消息重算一遍全站帖子） */
  if (!u.banned) {
    if (lvCache) {
      if (!lvCache.has(u.id)) lvCache.set(u.id, userGrowth(u).lv);
      out.level = lvCache.get(u.id);
    } else {
      out.level = userGrowth(u).lv;
    }
  }
  /* 被禁封账号的历史消息统一显示【已清除】+封号头像（新增：禁封功能） */
  if (u.banned || x.bannedCleared) {
    out.banned = true;
    out.bannedCleared = true;
    out.text = '【已清除】';
    out.avatar = BANNED_AVATAR;
    delete out.level;
  }
  return out;
}
function archiveSummary(a) {
  /* 每卷只统计「上一卷存档点之后」到本卷存档点之间的消息 */
  const prev = chatArchives()
    .filter(x => x.cutoffId < a.cutoffId)
    .reduce((mx, x) => Math.max(mx, x.cutoffId), 0);
  const msgs = DB.messages.filter(x => x.id > prev && x.id <= a.cutoffId);
  const first = msgs[0], last = msgs[msgs.length - 1];
  return {
    id: a.id, title: a.title, cutoffId: a.cutoffId, fromId: prev + 1,
    count: msgs.length,
    firstId: first ? first.id : prev + 1, lastId: last ? last.id : prev,
    firstTs: first ? first.ts : a.createdAt, lastTs: last ? last.ts : a.createdAt,
    createdAt: a.createdAt
  };
}

route('GET', /^\/api\/messages$/, async (req, res, m, url) => {
  const after = Number(url.searchParams.get('after') || 0);
  const cutoff = latestChatCutoff();
  /* 存档点之前的历史请走 /api/chat/archives；存档之后的新消息不再做 200 条截断 */
  const lvCache = new Map();
  const list = (after ? DB.messages.filter(x => x.id > after) : DB.messages.filter(x => x.id > cutoff))
    .map(x => decorateChatMsg(x, lvCache));
  sendJSON(res, 200, list);
});

/* 存档列表（公开，未登入也可查看） */
route('GET', /^\/api\/chat\/archives$/, async (req, res) => {
  sendJSON(res, 200, chatArchives().map(archiveSummary));
});

/* 存档内容：倒序分页（before 之前往前取 limit 条），返回升序排列 */
route('GET', /^\/api\/chat\/archives\/(\d+)\/messages$/, async (req, res, m, url) => {
  const a = chatArchives().find(x => x.id === Number(m[1]));
  if (!a) throw httpError(404, '未找到该存档。');
  const before = Number(url.searchParams.get('before') || 0);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 200);
  const fromId = archiveSummary(a).fromId;
  const src = DB.messages.filter(x => x.id >= fromId && x.id <= a.cutoffId && (!before || x.id < before));
  const lvCache = new Map();
  const list = src.slice(-limit).map(x => decorateChatMsg(x, lvCache));
  sendJSON(res, 200, { archive: archiveSummary(a), messages: list, hasMore: src.length > list.length });
});

/* 管理员：把当前全部新消息封存为一个存档 */
route('POST', /^\/api\/admin\/chat\/archive$/, async (req, res) => {
  needAdmin(req);
  const b = await readJSON(req);
  const rest = DB.messages.filter(x => x.id > latestChatCutoff());
  if (!rest.length) throw httpError(400, '存档点之后没有新消息，无需新建存档。');
  const lastId = rest[rest.length - 1].id;
  const title = b.title ? requireText(b.title, 60, '存档名称')
    : '聊天室存档 · 第' + (chatArchives().length + 1) + '卷';
  const a = {
    id: chatArchives().reduce((mx, x) => Math.max(mx, x.id), 0) + 1,
    title, cutoffId: lastId, count: rest.length, createdAt: Date.now()
  };
  DB.config.chatArchives = chatArchives().concat([a]);
  save();
  sendJSON(res, 200, { ok: true, archive: archiveSummary(a) });
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
  const mentions = forum.mentionMeta(body);
  const msg = addMessage('chat', { userId: u.id, nickname: u.nickname, avatar: u.avatar, text: body, mentions });
  forum.notifyChatMentions(msg, { id: u.id, name: u.nickname, role: 'user' });
  /* 成就（新增）：你好世界 = 首次聊天；刷屏机器 = 自己连续 4 条、中间无他人（系统消息不算） */
  unlockAchievement(u, 'hello_world');
  {
    let run = 0;
    for (let i = DB.messages.length - 1; i >= 0; i--) {
      const m = DB.messages[i];
      if (m.kind !== 'chat') continue;           // 系统消息不打断连续
      if (m.userId === u.id) { run++; if (run >= 4) break; }
      else break;                                 // 他人插话，连击中断
    }
    if (run >= 4) unlockAchievement(u, 'spam_machine');
  }
  sendJSON(res, 200, msg);
});

/* 当前在线人数（聊天室展示用） */
route('GET', /^\/api\/online$/, async (req, res) => {
  sendJSON(res, 200, onlineSnapshot());
});

/* ---------- 表情包接口（全服务器共用） ---------- */
route('GET', /^\/api\/emojis$/, async (req, res) => {
  sendJSON(res, 200, emojiSnapshot());
});

route('POST', /^\/api\/emoji-groups$/, async (req, res) => {
  const u = emojiEditor(req);
  const b = await readJSON(req);
  const name = requireText(b.name, 12, '分组名称');
  if ((DB.emojiGroups || []).length >= 20) throw httpError(400, '分组最多 20 个。');
  if (DB.emojiGroups.some(g => g.name === name)) throw httpError(409, '已有同名分组。');
  const group = { id: ++DB.emojiGroupSeq, name, createdAt: Date.now(), createdBy: { id: u.id, nickname: u.nickname } };
  DB.emojiGroups.push(group);
  await save();
  broadcast('emojis', emojiSnapshot());
  sendJSON(res, 200, { ok: true, snapshot: emojiSnapshot() });
});

route('DELETE', /^\/api\/emoji-groups\/(\d+)$/, async (req, res, m) => {
  emojiEditor(req);
  const id = Number(m[1]);
  const gi = DB.emojiGroups.findIndex(g => g.id === id);
  if (gi < 0) throw httpError(404, '分组不存在。');
  if (DB.emojiGroups.length <= 1) throw httpError(400, '至少保留一个分组。');
  /* 删分组连带删掉组内表情（文件一并清掉），前端会先二次确认 */
  const doomed = DB.emojis.filter(e => e.groupId === id);
  DB.emojis = DB.emojis.filter(e => e.groupId !== id);
  DB.emojiGroups.splice(gi, 1);
  await save();
  for (const e of doomed) await removeEmojiFile(e.file);
  broadcast('emojis', emojiSnapshot());
  sendJSON(res, 200, { ok: true, removed: doomed.length, snapshot: emojiSnapshot() });
});

route('POST', /^\/api\/emojis$/, async (req, res) => {
  const u = emojiEditor(req);
  const b = await readJSON(req);
  const gid = Number(b.groupId);
  if (!DB.emojiGroups.some(g => g.id === gid)) throw httpError(400, '分组不存在。');
  if ((DB.emojis || []).length >= EMOJI_MAX) throw httpError(400, '表情包总数已达上限（' + EMOJI_MAX + ' 个）。');
  if (String(b.dataUrl || '').length > 8 * 1024 * 1024) throw httpError(400, '表情包文件过大，请换一张小一点的图。');
  const { buf, ext } = await decodeUpload(b.dataUrl);
  /* 尺寸守卫：前端会先画成 256×256 透明画布；绕过前端的请求在这里被挡下 */
  const size = ext === 'webp' ? webpSize(buf) : null;
  if (size && (size.w !== EMOJI_SIZE || size.h !== EMOJI_SIZE)) {
    throw httpError(400, '表情包必须是 ' + EMOJI_SIZE + '×' + EMOJI_SIZE + ' 的正方形，当前是 ' + size.w + '×' + size.h + '。');
  }
  const id = ++DB.emojiSeq;
  const file = await saveEmojiFile(id, buf, ext);
  const emoji = {
    id, groupId: gid,
    name: requireText(b.name || '表情', 16, '表情名称'),
    file, createdAt: Date.now(), createdBy: { id: u.id, nickname: u.nickname }
  };
  DB.emojis.push(emoji);
  /* 成就：表情包大师 = 上传满 5 条表情包 */
  if ((DB.emojis || []).filter(e => e.createdBy && e.createdBy.id === u.id).length >= 5) unlockAchievement(u, 'emoji_master');
  await save();
  broadcast('emojis', emojiSnapshot());
  sendJSON(res, 200, { ok: true, emoji: { id, groupId: gid, name: emoji.name, url: file }, snapshot: emojiSnapshot() });
});

route('DELETE', /^\/api\/emojis\/(\d+)$/, async (req, res, m) => {
  emojiEditor(req);
  const id = Number(m[1]);
  const idx = DB.emojis.findIndex(e => e.id === id);
  if (idx < 0) throw httpError(404, '表情不存在。');
  const [gone] = DB.emojis.splice(idx, 1);
  await save();
  await removeEmojiFile(gone.file);
  broadcast('emojis', emojiSnapshot());
  sendJSON(res, 200, { ok: true, snapshot: emojiSnapshot() });
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
  const { buf, ext } = await decodeUpload(b.dataUrl);
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
    chatArchives: chatArchives().map(archiveSummary),
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
  const { buf, ext } = await decodeUpload(b.dataUrl);
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

/* 投稿人上传自己档案的卡面 / 形象图（新增：投稿人编辑档案）
 * 权限同 canEditPost；只认 posts 的 card / portrait，不动署名/设主/打码。
 * 沿用后台图片逻辑：保留 .orig 原始备份、换扩展名清旧文件、verUrl 破缓存。 */
route('POST', /^\/api\/posts\/([a-z0-9]+)\/image$/, async (req, res, m) => {
  const u = sessionUser(req);
  if (!u) throw httpError(401, '请先登入怪啖论坛。');
  if (u.status !== 'approved') throw httpError(403, '账号审核中，通过审核后即可编辑档案。');
  const p = DB.posts.find(x => x.id === m[1]);
  if (!p) throw httpError(404, '未找到该怪谈档案。');
  if (!canEditPost(req, p)) throw httpError(403, '只有该档案的投稿人本人可以编辑。');
  const b = await readJSON(req);
  const slot = (b.slot === 'card' || b.slot === 'portrait') ? b.slot : null;
  if (!slot) throw httpError(400, '不支持的图片位置，仅可上传卡面或形象。');
  const dir = SLOT_DIR.posts[slot];
  const { buf, ext } = await decodeUpload(b.dataUrl);
  await fsp.mkdir(path.join(FILES, dir), { recursive: true });
  const oldUrl = p[slot];
  if (oldUrl && oldUrl.startsWith('/files/')) {
    const oldPath = path.join(FILES, fileRel(oldUrl));
    if (fs.existsSync(oldPath)) {
      const orig = origPathOf(oldPath);
      if (!fs.existsSync(orig)) await fsp.copyFile(oldPath, orig);
    }
  }
  for (const e of ['png', 'jpg', 'webp']) {
    if (e === ext) continue;
    const old = path.join(FILES, dir, p.id + '.' + e);
    if (fs.existsSync(old)) { try { await fsp.unlink(old); } catch {} }
  }
  const name = p.id + '.' + ext;
  await fsp.writeFile(path.join(FILES, dir, name), buf);
  p[slot] = verUrl('/files/' + dir + '/' + name);
  p.editedAt = Date.now();
  save();
  broadcast('post', publicPost(p));
  sendJSON(res, 200, { ok: true, url: p[slot] });
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

/* 管理员保存用户 / 怪谈的黑方块打码坐标（新增：黑方块打码） */
route('POST', /^\/api\/admin\/masks$/, async (req, res) => {
  needAdmin(req);
  const b = await readJSON(req);
  const kind = b.kind === 'posts' ? 'posts' : 'users';
  const rec = recordOf(kind, requireText(b.id, 40, '档案'));
  if (!rec) throw httpError(404, '未找到该档案。');
  rec.masks = normMasks(b.masks);
  save();
  broadcast(kind === 'users' ? 'user' : 'post', kind === 'users' ? publicUser(rec) : publicPost(rec));
  sendJSON(res, 200, { ok: true, masks: rec.masks || {} });
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
  /* 禁封开关：未提交的旧页面不会误解除禁封（新增：禁封功能） */
  if ('banned' in b) applyUserBan(u, b.banned === true);
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
  FILES, path, fs, fsp, getVisits: todayVisits, unlockAchievement
});

/* ---------- root 服务器监控（独立于 admin，页面 site/root.html） ---------- */
const rootMon = installRoot({
  DB, save, route, cookies, setCookie, clearCookie,
  httpError, sendJSON, readJSON, hashPass,
  DATA, SITE, path, fs, fsp, os, crypto, execFile, sseClients
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

loadDb().then(async () => {
  const migrated = forum.migrate();
  if (migrated.channels || migrated.threads) console.log('[forum] 频道 ' + migrated.channels + ' 个，帖子 ' + migrated.threads + ' 条');
  /* unknown 组统一归入独立的「Unknown」阵营（？？？也算该组），新旧账号启动时对齐一次 */
  let unknownFixed = 0;
  for (const u of DB.users || []) {
    if (String(u.playerName || '').toLowerCase() === 'unknown' && u.faction !== 'unknown') {
      u.faction = 'unknown'; unknownFixed++;
    }
  }
  if (unknownFixed) { await save(); console.log('[migrate] unknown 阵营对齐 ' + unknownFixed + ' 个账号'); }
  await rootMon.init();
  server.listen(PORT, HOST, () => {
    console.log('怪啖论坛已启动：http://' + HOST + ':' + PORT + '/');
    console.log('数据目录：' + DATA);
    console.log('管理员：' + DB.config.adminUser + '（初始密码见启动说明）');
    console.log('root 监控页：/root.html（root 初始密码 rootpassword，登入后请立即修改）');
  });
});
