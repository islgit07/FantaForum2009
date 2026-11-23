#!/usr/bin/env node
/* 怪啖论坛 · 频道 / 帖子 / 公告 / 搜索 / 站内消息 扩展模块
 * 由 server.js 通过 installForum(ctx) 注入依赖后注册路由。
 * 数据一律落在 ctx.DB（同一个 db.json），无新增依赖。
 */
'use strict';

/* 禁封账号统一使用封号头像（新增：禁封功能） */
const BANNED_AVATAR = '/assets/banned.svg';

const INITIAL_CHANNELS = [
  { name: '怪谈故事', desc: '已归档的怪谈与故事档案', order: 1 },
  { name: '公开情报', desc: '公开的情报与线索', order: 2 },
  { name: '调查委托', desc: '调查委托与任务', order: 3 },
  { name: '自由创作', desc: '自由创作与二创', order: 4 }
];

module.exports = function installForum(ctx) {
  const {
    DB, save, route, broadcast, saveImage, addMessage,
    sessionUser, isAdmin, isAdminRole, isNoProfileUser, needAdmin,
    httpError, sendJSON, readJSON, text, requireText, uid,
    FILES, path, fs, fsp, getVisits, unlockAchievement
  } = ctx;

  /* ---------- 数据初始化与迁移 ---------- */
  function ensureShape() {
    if (!Array.isArray(DB.channels)) DB.channels = [];
    if (!Array.isArray(DB.threads)) DB.threads = [];
    if (!Array.isArray(DB.notifications)) DB.notifications = [];
    if (!Array.isArray(DB.guestbook)) DB.guestbook = [];
    if (!('guestbookSeq' in DB)) DB.guestbookSeq = 0;
    if (!('announcement' in DB)) DB.announcement = null;
    if ('postSeq' in DB && !('threadSeq' in DB)) DB.threadSeq = DB.postSeq;
    if (!('threadSeq' in DB)) DB.threadSeq = 0;
    if (!('notificationSeq' in DB)) DB.notificationSeq = 0;
    // 评论字段规范化：楼层号 / 点赞 / 置顶 / 回复目标。老数据平滑升级。
    for (const t of DB.threads) {
      if (!Array.isArray(t.replies)) t.replies = [];
      t.replies.forEach((r, i) => {
        if (!Number.isInteger(r.floor) || r.floor < 1) r.floor = i + 1;
        if (!Array.isArray(r.likes)) r.likes = [];
        if (typeof r.pinned !== 'boolean') r.pinned = false;
        if (!('pinnedBy' in r)) r.pinnedBy = null;
        if (!('replyTo' in r)) r.replyTo = null;
      });
    }
  }
  function migrate() {
    ensureShape();
    let changed = false;
    if (!DB.channels.length) {
      INITIAL_CHANNELS.forEach(c => DB.channels.push({
        id: uid(), name: c.name, desc: c.desc, order: c.order,
        createdAt: Date.now(), createdBy: 'system'
      }));
      changed = true;
    }
    // 把现有已过审的怪谈档案迁移成「怪谈故事」频道里的帖子（只做一次）
    if (!DB.forumMigrated) {
      const story = DB.channels.find(c => c.name === '怪谈故事') || DB.channels[0];
      for (const p of (DB.posts || []).filter(x => x.status === 'approved')) {
        const images = [p.card, p.portrait].filter(Boolean);
        const body = [
          '【怪谈档案迁移】',
          '影响范围：' + (p.area || '（未填写）'),
          '机制：' + (p.mechanism || '（未填写）'),
          (p.type === 'puzzle' ? '谜底：' : '对策：') + (p.countermeasures || '（未填写）')
        ].join('\n');
        DB.threads.push({
          id: uid(), channelId: story.id, title: p.name, body,
          images, authorId: p.authorId || null, author: p.author || '匿名',
          avatar: null, createdAt: p.createdAt || Date.now(), updatedAt: Date.now(),
          likes: [], replies: [], pinned: false, pinnedBy: null,
          deleted: false, deletedBy: null, status: 'approved',
          source: { kind: 'archive', postId: p.id }
        });
      }
      DB.forumMigrated = true;
      changed = true;
    }
    if (changed) save();
    return { channels: DB.channels.length, threads: DB.threads.length };
  }

  /* ---------- 小工具 ---------- */
  function channel(id) { return DB.channels.find(c => c.id === id); }
  /* 被禁言的用户不能发帖/回复（聊天在 server.js 单独拦） */
  function muteGuard(req) {
    const u = sessionUser(req);
    if (u && u.mutedUntil && Date.now() < u.mutedUntil) {
      const d = new Date(u.mutedUntil);
      throw httpError(403, '您已被禁言（至 ' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '）。');
    }
  }
  function thread(id) { return DB.threads.find(t => t.id === id); }
  function aliveThreads() { return DB.threads.filter(t => !t.deleted); }
  function actorOf(req) {
    // 普通用户会话优先：只要用户以账号身份登入，就以该账号发言，
    // 即使浏览器残留了管理后台的 ff_admin cookie，也不会被误判成「管理员」。
    const u = sessionUser(req);
    if (u) {
      if (u.status !== 'approved') throw httpError(403, '账号审核中，通过审核后才能操作。');
      return { id: u.id, name: u.nickname, role: 'user', avatar: u.avatar };
    }
    if (isAdmin(req)) return { id: 'admin', name: '管理员', role: 'admin' };
    throw httpError(401, '请先登入怪啖论坛。');
  }
  function canManage(req, t) {
    const a = actorOf(req);
    if (a.role === 'admin') return { ...a, as: 'admin' };
    if (uId(req) === t.authorId) return { ...a, as: 'owner' };
    throw httpError(403, '只有帖主或管理员可以操作。');
  }
  function uId(req) { const u = sessionUser(req); return u && u.id; }
  function publicChannel(c) { return { id: c.id, name: c.name, desc: c.desc, order: c.order || 0, createdAt: c.createdAt }; }
  function heat(t) { return (t.likes || []).length * 2 + (t.replies || []).filter(r => !r.deleted).length; }
  const DELETED_LABEL = '【管理员已删除】';
  /* 实时从档案取「网名」与头像：昵称/头像以用户档案为准，管理员改档案后帖子与评论同步更新。 */
  function resolveIdentity(authorId, fallbackName, fallbackAvatar) {
    if (authorId === 'admin') return { author: '管理员', avatar: null, muted: false, noProfile: false, banned: false };
    const u = authorId && DB.users.find(x => x.id === authorId);
    /* 禁封账号：头像换成封号头像，并带 banned 标记让前端显示灰色「已禁封」（新增：禁封功能） */
    if (u && u.banned) return { author: u.nickname, avatar: BANNED_AVATAR, muted: false, noProfile: isNoProfileUser(u), banned: true };
    if (u) return { author: u.nickname, avatar: u.avatar || fallbackAvatar || null, muted: !!u.mutedUntil && Date.now() < u.mutedUntil, noProfile: isNoProfileUser(u), banned: false };
    return { author: fallbackName || '匿名', avatar: fallbackAvatar || null, muted: false, noProfile: false, banned: false };
  }
  function publicThread(t, me) {
    const tomb = !!t.deleted;
    /* 匿名帖：显示层固定「匿名」、无头像，不随用户档案变化暴露真实网名 */
    const ident = tomb ? { author: t.author, avatar: null, muted: false, noProfile: false, banned: false }
      : (t.anon ? { author: '匿名', avatar: null, muted: false, noProfile: true, banned: false }
        : resolveIdentity(t.authorId, t.author, t.avatar));
    /* 禁封账号的帖子有痕清除：标题/正文变【已清除】，头像换封号头像（新增：禁封功能） */
    const cleared = !tomb && !!(t.bannedCleared || ident.banned);
    return {
      id: t.id, channelId: t.channelId,
      title: tomb ? DELETED_LABEL : (cleared ? '【已清除】' : t.title),
      body: tomb ? DELETED_LABEL : (cleared ? '【已清除】' : t.body),
      mentions: tomb || cleared ? [] : (t.mentions || []),
      images: tomb || cleared ? [] : (t.images || []),
      author: ident.author, authorId: t.authorId, authorMuted: !!ident.muted,
      anon: !tomb && !!t.anon, authorNoProfile: !!ident.noProfile,
      authorBanned: cleared,
      avatar: cleared ? BANNED_AVATAR : ident.avatar,
      createdAt: t.createdAt, updatedAt: t.updatedAt, editedAt: t.editedAt || null,
      likes: tomb ? 0 : (t.likes || []).length, likedByMe: false,
      replies: tomb ? [] : (t.replies || []).slice().sort((a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.floor - b.floor
      ).map(publicReply),
      replyCount: tomb ? 0 : (t.replies || []).filter(r => !r.deleted).length,
      pinned: tomb ? false : !!t.pinned, pinnedBy: tomb ? null : (t.pinnedBy || null),
      locked: !t.deleted && !!t.locked, lockedBy: t.lockedBy || null, lockedAt: t.lockedAt || null,
      deleted: tomb, deletedMode: tomb ? (t.deletedMode || 'trace') : null, deletedBy: t.deletedBy || null,
      status: t.status, heat: tomb ? 0 : heat(t), source: tomb ? null : (t.source || null)
    };
  }
  function publicReply(r) {
    const ident = resolveIdentity(r.authorId, r.author, r.avatar);
    const gone = !!r.deleted;
    /* 封禁优先于删除：被封禁账号的评论统一按「封禁清除」显示，不再显示"已删除评论"。
       封禁时账号已被撤销会话、内容已被有痕清除，故 deleted 仅作为历史痕迹不再对外呈现。 */
    const cleared = !!(r.bannedCleared || ident.banned);
    /* 回复对象的名字按 authorId 实时解析网名，避免改名后引用行显示旧名 */
    const rtIdent = (r.replyTo && !gone) ? resolveIdentity(r.replyTo.authorId, r.replyTo.author, null) : null;
    return {
      id: r.id, authorId: r.authorId, author: ident.author, authorMuted: gone ? false : !!ident.muted,
      avatar: cleared ? BANNED_AVATAR : (gone ? null : ident.avatar),
      authorNoProfile: !!ident.noProfile,
      authorBanned: cleared,
      floor: r.floor,
      body: cleared ? '【已清除】' : (gone ? ('【' + ((r.deletedBy && r.deletedBy.name) || '某人') + '已删除评论】') : r.body),
      mentions: gone || cleared ? [] : (r.mentions || []),
      createdAt: r.createdAt,
      likes: gone ? 0 : (r.likes || []).length, likedByMe: false,
      pinned: gone ? false : !!r.pinned, pinnedBy: gone ? null : (r.pinnedBy || null),
      replyTo: gone ? null : (r.replyTo ? {
        id: r.replyTo.id, authorId: r.replyTo.authorId,
        author: rtIdent ? rtIdent.author : r.replyTo.author,
        floor: r.replyTo.floor
      } : null),
      deleted: gone && !cleared, deletedBy: (gone && !cleared) ? (r.deletedBy || null) : null
    };
  }
  function withLikedMe(t, req) {
    const p = publicThread(t);
    const u = sessionUser(req);
    if (u) {
      p.likedByMe = (t.likes || []).includes(u.id);
      for (const rp of p.replies) {
        const src = (t.replies || []).find(x => x.id === rp.id);
        rp.likedByMe = src ? (src.likes || []).includes(u.id) : false;
      }
    }
    return p;
  }
  function notify(targetId, type, actor, payload) {
    if (!targetId || targetId === actor.id) return;
    const n = {
      id: ++DB.notificationSeq, ts: Date.now(), type,
      targetId, actorId: actor.id, actorName: actor.name, ...payload
    };
    DB.notifications.push(n);
    if (DB.notifications.length > 1000) DB.notifications.splice(0, DB.notifications.length - 1000);
    broadcast('notification', n);
  }
  /* ---------- @ 提及 ---------- */
  /* 按当前已过审账号的「网名」匹配 @；名字越长越优先，避免 @小A 抢先吃掉 @小AB。
     返回的 name 是匹配到的网名，noProfile 用于前端决定是否给主页链接。 */
  function mentionMeta(text) {
    const body = String(text == null ? '' : text);
    if (!body || body.indexOf('@') < 0) return [];
    const pool = (DB.users || [])
      .filter(u => u && u.status === 'approved' && !u.banned && String(u.nickname || '').trim())
      .map(u => ({ u, name: String(u.nickname).trim() }))
      .sort((a, b) => b.name.length - a.name.length);
    const seen = new Set(), out = [];
    let pos = -1;
    while ((pos = body.indexOf('@', pos + 1)) >= 0) {
      /* 不把邮箱等 foo@bar 当成提及 */
      if (pos > 0 && /[A-Za-z0-9._%+-]/.test(body.charAt(pos - 1))) continue;
      const rest = body.slice(pos + 1);
      const hit = pool.find(x => rest.startsWith(x.name));
      if (!hit) continue;
      if (!seen.has(hit.u.id)) {
        seen.add(hit.u.id);
        out.push({ id: hit.u.id, name: hit.name, noProfile: isNoProfileUser(hit.u) });
      }
      pos += hit.name.length;
    }
    return out;
  }
  function notifyChatMentions(msg, actor) {
    const list = ((msg && msg.mentions) || []).filter(m => m && m.id && m.id !== actor.id);
    if (!list.length) return 0;
    for (const m of list) {
      notify(m.id, 'chatMention', actor, {
        chat: true,
        excerpt: String(msg.text || '').slice(0, 80)
      });
    }
    save();
    return list.length;
  }
  function imagesOf(b) {
    const out = [];
    for (const key of ['image', 'image2', 'image3']) {
      if (b[key]) out.push(b[key]);
    }
    return out;
  }

  /* ---------- 公共读取 ---------- */
  route('GET', /^\/api\/home$/, async (req, res) => {
    const list = aliveThreads();
    const channels = DB.channels.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(c => {
      const items = list.filter(t => t.channelId === c.id);
      const hot = items.slice().sort((a, b) => heat(b) - heat(a) || b.createdAt - a.createdAt)[0] || null;
      const latest = items.slice().sort((a, b) => b.createdAt - a.createdAt)[0] || null;
      return {
        ...publicChannel(c), count: items.length,
        hotThread: hot ? { id: hot.id, title: hot.title, heat: heat(hot) } : null,
        latestThread: latest ? { id: latest.id, title: latest.title } : null
      };
    });
    /* 主页只让全站最 HOT 的一个频道带 HOT；其余频道由前端显示 NEW 本频道最新帖。频道本身顺序不变。 */
    const hotIds = new Set(channels.filter(c => c.hotThread)
      .sort((a, b) => b.hotThread.heat - a.hotThread.heat || b.count - a.count || (a.order || 0) - (b.order || 0))
      .slice(0, 1).map(c => c.id));
    for (const c of channels) if (!hotIds.has(c.id)) c.hotThread = null;
    const ranking = list.slice().sort((a, b) =>
      (b.likes || []).length - (a.likes || []).length || b.createdAt - a.createdAt
    ).slice(0, 5).map(t => ({
      id: t.id, title: t.title, channelId: t.channelId,
      likes: (t.likes || []).length, createdAt: t.createdAt,
      isNew: Date.now() - t.createdAt < 24 * 60 * 60 * 1000
    }));
    sendJSON(res, 200, { announcement: DB.announcement, channels, ranking, todayVisits: getVisits() });
  });

  route('GET', /^\/api\/channels$/, async (req, res) => {
    const list = aliveThreads();
    sendJSON(res, 200, DB.channels.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(c => ({
      ...publicChannel(c), count: list.filter(t => t.channelId === c.id).length
    })));
  });

  route('GET', /^\/api\/channels\/([a-z0-9]+)\/threads$/, async (req, res, m) => {
    if (!channel(m[1])) throw httpError(404, '未找到该频道。');
    // 带痕删除的帖子（deleted=true 且 deletedMode='trace'）保留原位置，显示为墓碑占位
    const list = DB.threads.filter(t => t.channelId === m[1] && (!t.deleted || t.deletedMode === 'trace'))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.createdAt - a.createdAt)
      .map(t => withLikedMe(t, req));
    sendJSON(res, 200, { channel: publicChannel(channel(m[1])), threads: list });
  });

  route('GET', /^\/api\/threads\/([a-z0-9]+)$/, async (req, res, m) => {
    const t = thread(m[1]);
    if (!t) throw httpError(404, '未找到该帖子。');
    const c = channel(t.channelId);
    sendJSON(res, 200, { thread: withLikedMe(t, req), channel: c ? publicChannel(c) : null });
  });

  route('GET', /^\/api\/search$/, async (req, res, m, url) => {
    const raw = (url.searchParams.get('q') || '').trim().slice(0, 80);
    const q = raw.toLowerCase();
    if (!q) { sendJSON(res, 200, { q: raw, threads: [], users: [] }); return; }
    const hit = s => String(s || '').toLowerCase().includes(q);
    const threads = aliveThreads().filter(t =>
      hit(t.title) || hit(t.body) || (t.replies || []).some(r => !r.deleted && hit(r.body))
    ).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(t => ({
      id: t.id, title: t.title, body: t.body.slice(0, 200), channelId: t.channelId,
      author: resolveIdentity(t.authorId, t.author, t.avatar).author, authorId: t.authorId, createdAt: t.createdAt, likes: (t.likes || []).length,
      replyCount: (t.replies || []).filter(r => !r.deleted).length
    }));
    // 用户搜索：网名 / 玩家名 / 个性签名，仅已过审账号；unknown 组（？？？除外）没有主页，不列出
    const users = (DB.users || []).filter(u => u.status === 'approved' && !isNoProfileUser(u) && (
      hit(u.nickname) || hit(u.playerName) || hit((u.public || {}).signature)
    )).slice(0, 100).map(u => ({
      id: u.id, nickname: u.nickname, playerName: u.playerName || '',
      avatar: u.avatar || null, signature: (u.public || {}).signature || ''
    }));
    sendJSON(res, 200, { q: raw, threads, users });
  });

  /* 搜索页「你可能认识的人」：同玩家 → 同阵营 → 其他，按优先级凑满 5 人。
     只推可点进主页的已过审角色；排除自己与 unknown 组（匿名/档案馆没有主页）。
     三档各自随机洗牌：优先级不变，但每次刷新人选与顺序都不同。 */
  route('GET', /^\/api\/suggest-users$/, async (req, res) => {
    const me = sessionUser(req);
    const myPlayer = me ? String(me.playerName || '').trim() : '';
    const myFaction = me ? (me.faction === 'office' ? 'office' : 'forum') : '';
    const pool = (DB.users || []).filter(u =>
      u.status === 'approved' && (!me || u.id !== me.id) && !isNoProfileUser(u)
    );
    const shuffle = list => {
      const a = list.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    };
    const samePlayer = myPlayer ? shuffle(pool.filter(u => String(u.playerName || '').trim() === myPlayer)) : [];
    const sameFaction = myFaction ? shuffle(pool.filter(u =>
      (u.faction === 'office' ? 'office' : 'forum') === myFaction && String(u.playerName || '').trim() !== myPlayer
    )) : [];
    const chosen = new Set(samePlayer.concat(sameFaction).map(u => u.id));
    const rest = shuffle(pool.filter(u => !chosen.has(u.id)));
    const pick = (u, why) => ({
      id: u.id, nickname: u.nickname, playerName: u.playerName || '',
      avatar: u.avatar || null, faction: u.faction === 'office' ? 'office' : 'forum', why
    });
    const users = samePlayer.slice(0, 5).map(u => pick(u, 'samePlayer'));
    for (const u of sameFaction) { if (users.length >= 5) break; users.push(pick(u, 'sameFaction')); }
    for (const u of rest) { if (users.length >= 5) break; users.push(pick(u, 'other')); }
    sendJSON(res, 200, { users });
  });

  /* 搜索页彩蛋：随机给一个 unknown 组角色，仅用于一次性视觉恶作剧，不进正常推荐 */
  route('GET', /^\/api\/easter-user$/, async (req, res) => {
    const pool = (DB.users || []).filter(u => isNoProfileUser(u));
    const u = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    sendJSON(res, 200, { user: u ? { nickname: u.nickname, avatar: u.avatar || null } : null });
  });

  /* ---------- 站内消息（数据层已埋点，页面后续可接） ---------- */
  route('GET', /^\/api\/notifications$/, async (req, res) => {
    const a = actorOf(req);
    const mine = DB.notifications.filter(n => n.targetId === a.id).slice().reverse().slice(0, 200);
    /* @网名按 authorId 实时解析，改名后通知里也显示当前网名 */
    const fresh = mine.map(n => {
      if (n.mentionOf && n.mentionOf.authorId) {
        const ident = resolveIdentity(n.mentionOf.authorId, n.mentionOf.author, null);
        return Object.assign({}, n, { mentionOf: Object.assign({}, n.mentionOf, { author: ident.author }) });
      }
      return n;
    });
    /* 打开消息页即视为已读：记在持久用户对象上（sessionUser 返回 DB.users 引用） */
    const u = sessionUser(req);
    if (u) { u.lastNoticeRead = Date.now(); save(); }
    sendJSON(res, 200, fresh);
  });

  /* ---------- 个人空间留言（guestbook） ----------
   * 规则：任何已登录角色可在他人空间留言；被留言者收到通知；
   * 删除仅「留言作者本人」或「管理员权限」可执行——空间主人无权删除别人给自己的留言。 */
  const TANZHU_OWNER_ID = 'mwowhihsc56eb23a';
  function guestbookCanDelete(req, g) {
    const u = sessionUser(req);
    /* 坛主的空间：只有坛主本人可以删评论（系统自动评论也归他管） */
    if (g.ownerId === TANZHU_OWNER_ID) return !!(u && u.id === TANZHU_OWNER_ID);
    if (isAdmin(req)) return true;               // 后台 admin + admin 角色卡
    return !!(u && u.id === g.authorId);         // 仅作者本人
  }
  function publicReply(req, r) {
    const gone = !!r.deleted;
    const u = sessionUser(req);
    /* 回复删除权限与留言一致：管理员 或 回复作者本人（坛主空间规则不适用于回复） */
    const canDel = isAdmin(req) || !!(u && u.id === r.authorId);
    return {
      id: r.id, authorId: r.authorId,
      author: resolveIdentity(r.authorId, r.author, r.avatar).author, avatar: gone ? null : (r.avatar || null),
      body: gone ? ('【' + ((r.deletedBy && r.deletedBy.name) || '某人') + '已删除回复】') : r.body,
      createdAt: r.createdAt, deleted: gone, deletedBy: r.deletedBy || null,
      canDelete: !gone && canDel
    };
  }
  function publicGuestbook(req, g) {
    const gone = !!g.deleted;
    const canDel = guestbookCanDelete(req, g);
    return {
      id: g.id, ownerId: g.ownerId, authorId: g.authorId,
      author: resolveIdentity(g.authorId, g.author, g.avatar).author, avatar: gone ? null : (g.avatar || null),
      body: gone ? ('【' + ((g.deletedBy && g.deletedBy.name) || '某人') + '已删除留言】') : g.body,
      createdAt: g.createdAt,
      deleted: gone, deletedBy: g.deletedBy || null,
      auto: !!g.auto,
      /* 回复列表（新增：留言回复），按时间正序显示 */
      replies: (Array.isArray(g.replies) ? g.replies : []).map(r => publicReply(req, r)),
      canDelete: !gone && canDel
    };
  }
  route('GET', /^\/api\/guestbook\/([a-z0-9]+)$/, async (req, res, m) => {
    const list = DB.guestbook
      .filter(g => g.ownerId === m[1])
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(g => publicGuestbook(req, g));
    sendJSON(res, 200, list);
  });
  route('POST', /^\/api\/guestbook\/([a-z0-9]+)$/, async (req, res, m) => {
    const a = actorOf(req);
    const owner = DB.users.find(u => u.id === m[1]);
    if (!owner) throw httpError(404, '未找到该用户。');
    const b = await readJSON(req);
    const body = text(b.body, 1000, '留言');
    if (!body) throw httpError(400, '留言内容不能为空。');
    const g = {
      id: uid(), ownerId: owner.id, authorId: a.id,
      author: a.name, avatar: a.avatar || null,
      body, createdAt: Date.now(),
      deleted: false, deletedBy: null
    };
    DB.guestbook.push(g);
    save();
    broadcast('guestbook', publicGuestbook(req, g));
    // 通知空间主人（notify 内部会跳过「留言给自己」的情况）
    const excerptLen = 40;
    notify(owner.id, 'guestbook', a, {
      ownerName: owner.nickname,
      excerpt: body.length > excerptLen ? body.slice(0, excerptLen) + '…' : body,
      profileId: owner.id
    });
    sendJSON(res, 200, { ok: true, guestbook: publicGuestbook(req, g) });
  });
  /* 回复留言（新增：留言回复）
   * 规则：任何已登录角色可回复未删除的留言（坛主空间的系统自动评论也可回复）；
   * 单条留言最多 50 条回复；回复对象收到「XXX 回复了你的留言」通知（回复自己不通知）。 */
  route('POST', /^\/api\/guestbook\/([a-z0-9]+)\/reply$/, async (req, res, m) => {
    const a = actorOf(req);
    const g = DB.guestbook.find(x => x.id === m[1]);
    if (!g) throw httpError(404, '未找到该留言。');
    if (g.deleted) throw httpError(400, '该留言已删除，无法回复。');
    const b = await readJSON(req);
    const body = text(b.body, 500, '回复');
    if (!body) throw httpError(400, '回复内容不能为空。');
    if (!Array.isArray(g.replies)) g.replies = [];
    if (g.replies.length >= 50) throw httpError(400, '这条留言的回复已达上限（50 条）。');
    const r = {
      id: uid(), authorId: a.id, author: a.name, avatar: a.avatar || null,
      body, createdAt: Date.now(), deleted: false, deletedBy: null
    };
    g.replies.push(r);
    save();
    broadcast('guestbook', publicGuestbook(req, g));
    /* 通知被回复人（留言作者）；回复人与作者是同一人时不通知（notify 内部处理） */
    const replyOwner = DB.users.find(u => u.id === g.ownerId);
    notify(g.authorId, 'guestbookReply', a, {
      ownerName: replyOwner ? replyOwner.nickname : '',
      excerpt: body.length > 40 ? body.slice(0, 40) + '…' : body,
      profileId: g.ownerId
    });
    sendJSON(res, 200, { ok: true, reply: publicReply(req, r) });
  });
  /* 删除回复（新增）：软删除，权限与留言一致——回复作者本人或管理员 */
  route('POST', /^\/api\/guestbook\/([a-z0-9]+)\/reply-delete$/, async (req, res, m) => {
    const a = actorOf(req);
    const g = DB.guestbook.find(x => x.id === m[1]);
    if (!g) throw httpError(404, '未找到该留言。');
    const b = await readJSON(req);
    const r = (g.replies || []).find(x => x.id === b.replyId);
    if (!r) throw httpError(404, '未找到该回复。');
    if (r.deleted) throw httpError(400, '该回复已删除。');
    if (!(isAdmin(req) || (a && a.id === r.authorId))) throw httpError(403, '只有回复者本人或管理员可以删除该回复。');
    r.deleted = true;
    r.deletedBy = { role: a.role === 'admin' ? 'admin' : 'self', name: a.name, id: a.id };
    save();
    broadcast('guestbook', publicGuestbook(req, g));
    sendJSON(res, 200, { ok: true });
  });
  route('POST', /^\/api\/guestbook\/([a-z0-9]+)\/auto$/, async (req, res, m) => {
    const a = actorOf(req);
    if (a.role === 'admin') throw httpError(403, '管理后台会话不需要自动留言。');
    if (a.id === m[1]) throw httpError(400, '坛主本人访问不需要自动留言。');
    const owner = DB.users.find(u => u.id === m[1]);
    if (!owner) throw httpError(404, '未找到该用户。');
    /* 每人每天对同一个人的主页只自动留言一次（按服务器本地日期判断，跨天可再发） */
    const todayKey = new Date().toDateString();
    if (DB.guestbook.some(g => g.ownerId === m[1] && g.authorId === a.id && g.auto
        && g.createdAt && new Date(g.createdAt).toDateString() === todayKey)) {
      sendJSON(res, 200, { ok: true, skipped: true });
      return;
    }
    const AUTO_TEXT = '坛主很帅人也很谦虚～【系统自动评论】';
    const g = {
      id: uid(), ownerId: m[1], authorId: a.id,
      author: a.name, avatar: a.avatar || null,
      body: AUTO_TEXT, createdAt: Date.now(),
      deleted: false, deletedBy: null, auto: true, locked: true
    };
    DB.guestbook.push(g);
    save();
    broadcast('guestbook', publicGuestbook(req, g));
    notify(m[1], 'guestbook', a, {
      ownerName: owner.nickname,
      excerpt: AUTO_TEXT.slice(0, 40),
      profileId: m[1]
    });
    sendJSON(res, 200, { ok: true, guestbook: publicGuestbook(req, g) });
  });
  route('POST', /^\/api\/guestbook\/([a-z0-9]+)\/delete$/, async (req, res, m) => {
    const a = actorOf(req);
    const g = DB.guestbook.find(x => x.id === m[1]);
    if (!g) throw httpError(404, '未找到该留言。');
    if (g.deleted) throw httpError(400, '该留言已删除。');
    const canDel = guestbookCanDelete(req, g);
    /* 系统自动评论：只有坛主本人可以删（其他人 403） */
    if (g.locked && !canDel) throw httpError(403, '系统自动评论只有坛主本人可以删除。');
    // 空间主人无权删除；仅作者本人或管理员可删（坛主的空间例外：只有坛主）
    if (!canDel) throw httpError(403, '只有留言者本人或管理员可以删除该留言。');
    g.deleted = true;
    g.deletedBy = { role: a.role === 'admin' ? 'admin' : (a.id === g.authorId ? 'self' : 'admin'), name: a.name, id: a.id };
    save();
    broadcast('guestbookDelete', { id: g.id, ownerId: g.ownerId });
    // 通知留言作者：其留言被谁删除
    notify(g.authorId, 'guestbookDelete', a, {
      ownerName: (DB.users.find(u => u.id === g.ownerId) || {}).nickname || '',
      profileId: g.ownerId
    });
    sendJSON(res, 200, { ok: true });
  });

  /* 禁言路由：管理员组设置/解除用户禁言（1-3 天） */
  route('POST', /^\/api\/users\/([a-z0-9]+)\/mute$/, async (req, res, m) => {
    needAdmin(req);
    const u = DB.users.find(x => x.id === m[1]);
    if (!u) throw httpError(404, '未找到该用户。');
    if (u.id === TANZHU_OWNER_ID && false) { /* 坛主卡也可被禁言，如需豁免在此调整 */ }
    const b = await readJSON(req);
    const days = [1, 2, 3].includes(Number(b.days)) ? Number(b.days) : 0;
    if (!days) throw httpError(400, '禁言时长只能为 1、2 或 3 天。');
    u.mutedUntil = Date.now() + days * 86400000;
    /* 聊天室全体公告：谁禁言了谁多少天 */
    const actor = sessionUser(req);
    addMessage('system', { text: '「' + (actor && actor.nickname ? actor.nickname : '管理员') + '」禁言了「' + u.nickname + '」' + days + ' 天。' });
    save();
    broadcast('user', { id: u.id, nickname: u.nickname, playerName: u.playerName || '', muted: true, mutedUntil: u.mutedUntil });
    sendJSON(res, 200, { ok: true, mutedUntil: u.mutedUntil });
  });
  route('POST', /^\/api\/users\/([a-z0-9]+)\/unmute$/, async (req, res, m) => {
    needAdmin(req);
    const u = DB.users.find(x => x.id === m[1]);
    if (!u) throw httpError(404, '未找到该用户。');
    u.mutedUntil = null;
    save();
    broadcast('user', { id: u.id, nickname: u.nickname, playerName: u.playerName || '', muted: false });
    sendJSON(res, 200, { ok: true });
  });

  /* ---------- 发帖 / 回复 / 点赞 / 管理 ---------- */
  route('POST', /^\/api\/channels\/([a-z0-9]+)\/threads$/, async (req, res, m) => {
    const a = actorOf(req);
    muteGuard(req);
    const c = channel(m[1]);
    if (!c) throw httpError(404, '未找到该频道。');
    const b = await readJSON(req);
    const title = requireText(b.title, 120, '标题');
    const body = requireText(b.body, 5000, '正文');
    const mentions = mentionMeta(body);
    const anon = !!b.anon;
    const id = uid();
    const images = [];
    const dataUrls = imagesOf(b);
    if (dataUrls.length > 3) throw httpError(400, '最多上传 3 张图片。');
    for (let i = 0; i < dataUrls.length; i++) {
      const url = await saveImage(dataUrls[i], 'thread-images', id + '-' + (i + 1));
      if (url) images.push(url);
    }
    const t = {
      id, channelId: c.id, title, body, images, mentions,
      /* 匿名发布：显示层固定为「匿名」、头像留空；保留真实 authorId，帖主仍可删改/通知正常 */
      authorId: a.id, author: anon ? '匿名' : a.name, avatar: anon ? null : (a.avatar || null),
      anon,
      createdAt: Date.now(), updatedAt: Date.now(),
      likes: [], replies: [], pinned: false, pinnedBy: null,
      deleted: false, deletedBy: null, status: 'approved'
    };
    DB.threads.push(t);
    save();
    /* 发帖正文 @ 到的人 → 站内消息；匿名发帖不暴露真实网名 */
    if (mentions.length) {
      const noticeActor = anon ? { id: a.id, name: '匿名', role: 'user' } : a;
      for (const m of mentions) {
        if (m.id === a.id) continue;
        notify(m.id, 'threadMention', noticeActor, {
          threadId: t.id, threadTitle: t.title, excerpt: body.slice(0, 80)
        });
      }
      save();
    }
    /* 关注的人发帖 → 给所有关注者推送站内消息（新增：关注功能）
       匿名发帖沿用匿名身份，不向关注者暴露真实网名；关注者仍能从「你关注的人」文案知道来源。 */
    let followNotified = 0;
    for (const u of DB.users || []) {
      if (u.status !== 'approved' || !(u.following || []).includes(a.id)) continue;
      notify(u.id, 'followPost', anon ? { id: a.id, name: '匿名', role: 'user' } : a, {
        threadId: t.id, threadTitle: t.title, excerpt: body.slice(0, 80), follow: true
      });
      followNotified++;
    }
    if (followNotified) save();
    /* 成就：社区贡献值 = 发布 5 条帖子（按当前有效帖数判定） */
    if (a.role === 'user') {
      const poster = (DB.users || []).find(x => x.id === a.id);
      if (poster && (DB.threads || []).filter(x => !x.deleted && x.authorId === a.id).length >= 5) {
        unlockAchievement(poster, 'contributor');
      }
    }
    broadcast('thread', publicThread(t));
    sendJSON(res, 200, { ok: true, thread: withLikedMe(t, req) });
  });

  route('POST', /^\/api\/threads\/([a-z0-9]+)\/replies$/, async (req, res, m) => {
    const a = actorOf(req);
    muteGuard(req);
    const t = thread(m[1]);
    if (!t || t.deleted) throw httpError(404, '未找到该帖子。');
    /* 封锁的帖子：所有人不可回复（含管理员/帖主） */
    if (t.locked) throw httpError(403, '此帖已被封锁，禁止回复。');
    const b = await readJSON(req);
    const body = requireText(b.body, 2000, '回复');
    const mentions = mentionMeta(body);
    t.replies = t.replies || [];
    // 回复某条评论：新建一楼，正文前加 @网名(楼层)：前缀
    let replyTo = null;
    if (b.replyToId) {
      const target = t.replies.find(x => x.id === b.replyToId && !x.deleted);
      if (target) {
        const ti = resolveIdentity(target.authorId, target.author, target.avatar);
        replyTo = { id: target.id, authorId: target.authorId, author: ti.author, floor: target.floor };
      }
    }
    const r = {
      id: uid(), authorId: a.id, author: a.name, avatar: a.avatar || null,
      floor: t.replies.length + 1, body, mentions, createdAt: Date.now(),
      likes: [], pinned: false, pinnedBy: null, replyTo,
      deleted: false, deletedBy: null
    };
    t.replies.push(r);
    t.updatedAt = Date.now();
    save();
    /* 同一个人只收一条本次回复的消息：帖主回复 > 被回复者 > 正文 @ 提及 */
    const noticed = new Set([a.id]);
    const notifyOnce = (targetId, type, payload) => {
      if (!targetId || noticed.has(targetId)) return;
      noticed.add(targetId);
      notify(targetId, type, a, payload);
    };
    notifyOnce(t.authorId, 'reply', { threadId: t.id, threadTitle: t.title, excerpt: body.slice(0, 80), floor: r.floor });
    if (replyTo && replyTo.authorId) {
      notifyOnce(replyTo.authorId, 'mention', {
        threadId: t.id, threadTitle: t.title,
        excerpt: body.slice(0, 80), floor: r.floor,
        mentionOf: { author: replyTo.author, floor: replyTo.floor }
      });
    }
    for (const m of mentions) {
      notifyOnce(m.id, 'replyMention', {
        threadId: t.id, threadTitle: t.title, excerpt: body.slice(0, 80), floor: r.floor
      });
    }
    save();
    broadcast('reply', { threadId: t.id, reply: publicReply(r) });
    sendJSON(res, 200, { ok: true, reply: publicReply(r) });
  });

  route('POST', /^\/api\/threads\/([a-z0-9]+)\/like$/, async (req, res, m) => {
    const a = actorOf(req);
    const t = thread(m[1]);
    if (!t || t.deleted) throw httpError(404, '未找到该帖子。');
    t.likes = t.likes || [];
    const i = t.likes.indexOf(a.id);
    const liked = i < 0;
    if (liked) t.likes.push(a.id); else t.likes.splice(i, 1);
    save();
    if (liked) notify(t.authorId, 'like', a, { threadId: t.id, threadTitle: t.title });
    broadcast('like', { threadId: t.id, likes: t.likes.length });
    sendJSON(res, 200, { ok: true, liked, likes: t.likes.length });
  });

  // 评论点赞：任一登录用户
  route('POST', /^\/api\/replies\/([a-z0-9]+)\/like$/, async (req, res, m) => {
    const a = actorOf(req);
    const owner = DB.threads.find(t => (t.replies || []).some(r => r.id === m[1] && !r.deleted));
    if (!owner || owner.deleted) throw httpError(404, '未找到该评论。');
    const r = owner.replies.find(x => x.id === m[1]);
    r.likes = r.likes || [];
    const i = r.likes.indexOf(a.id);
    const liked = i < 0;
    if (liked) r.likes.push(a.id); else r.likes.splice(i, 1);
    save();
    if (liked) notify(r.authorId, 'likeReply', a, { threadId: owner.id, threadTitle: owner.title, floor: r.floor });
    broadcast('reply', { threadId: owner.id, reply: publicReply(r) });
    sendJSON(res, 200, { ok: true, liked, likes: r.likes.length });
  });

  // 评论置顶：管理员或帖主
  route('POST', /^\/api\/replies\/([a-z0-9]+)\/pin$/, async (req, res, m) => {
    const owner = DB.threads.find(t => (t.replies || []).some(r => r.id === m[1] && !r.deleted));
    if (!owner || owner.deleted) throw httpError(404, '未找到该评论。');
    const a = canManage(req, owner);
    const r = owner.replies.find(x => x.id === m[1]);
    r.pinned = !r.pinned;
    r.pinnedBy = r.pinned ? { role: a.as, name: a.name, id: a.id } : null;
    save();
    notify(r.authorId, 'pinReply', a, { threadId: owner.id, threadTitle: owner.title, floor: r.floor, by: a.as });
    broadcast('reply', { threadId: owner.id, reply: publicReply(r) });
    sendJSON(res, 200, { ok: true, reply: publicReply(r) });
  });

  // 帖子置顶：仅管理员
  route('POST', /^\/api\/threads\/([a-z0-9]+)\/pin$/, async (req, res, m) => {
    needAdmin(req);
    const t = thread(m[1]);
    if (!t || t.deleted) throw httpError(404, '未找到该帖子。');
    const a = { id: 'admin', name: '管理员', role: 'admin', as: 'admin' };
    t.pinned = !t.pinned;
    t.pinnedBy = t.pinned ? { role: 'admin', name: '管理员', id: 'admin' } : null;
    t.updatedAt = Date.now();
    save();
    notify(t.authorId, 'pin', a, { threadId: t.id, threadTitle: t.title, by: 'admin' });
    broadcast('thread', publicThread(t));
    sendJSON(res, 200, { ok: true, thread: publicThread(t) });
  });
  /* 帖子封锁：管理员组（管理面板会话或管理员角色卡）或帖主可切换；封锁后所有人不可回复，仅管理员可编辑（管理后台不受影响） */
  route('POST', /^\/api\/threads\/([a-z0-9]+)\/lock$/, async (req, res, m) => {
    const a = actorOf(req);
    const t = thread(m[1]);
    if (!t || t.deleted) throw httpError(404, '未找到该帖子。');
    if (!(isAdmin(req) || a.id === t.authorId)) throw httpError(403, '只有管理员或帖主可以封锁帖子。');
    t.locked = !t.locked;
    t.lockedBy = t.locked ? { role: a.role, name: a.name, id: a.id } : null;
    t.lockedAt = t.locked ? Date.now() : null;
    t.updatedAt = Date.now();
    save();
    broadcast('thread', publicThread(t));
    sendJSON(res, 200, { ok: true, locked: t.locked, thread: publicThread(t) });
  });

  /* 帖主在帖子页编辑自己的帖子/怪谈（新增：发帖人编辑）
   * 仅帖主本人可改：标题、正文、配图（最多 3 张）、匿名状态。
   * 频道 / 发帖人 / 置顶 / 封锁一律不动（管理员改这些仍走后台接口）。
   * 编辑留痕：写 editedAt，前端在时间旁显示「已编辑」。 */
  route('POST', /^\/api\/threads\/([a-z0-9]+)\/edit$/, async (req, res, m) => {
    const t = thread(m[1]);
    if (!t || t.deleted) throw httpError(404, '未找到该帖子。');
    const a = actorOf(req);
    muteGuard(req);
    if (a.role !== 'user' || a.id !== t.authorId) throw httpError(403, '只有发帖人本人可以编辑。');
    const b = await readJSON(req);
    t.title = requireText(b.title, 120, '标题');
    t.body = requireText(b.body, 5000, '正文');
    t.mentions = mentionMeta(t.body);

    /* 配图：前端回传的 image/image2/image3 可能是已有 /files 链接（保留原样）
     * 或新上传的 data URL（落盘新文件）；未再引用的旧图顺手清理。 */
    const was = (t.images || []).slice();
    const wanted = [b.image, b.image2, b.image3].filter(x => !!x).slice(0, 3);
    const next = [];
    for (let i = 0; i < wanted.length; i++) {
      const val = String(wanted[i]);
      if (val.indexOf('data:') === 0) {
        const url = await saveImage(val, 'thread-images', t.id + '-' + (i + 1));
        if (url) next.push(url);
      } else if (/^\/files\/thread-images\/[a-z0-9-]+\.(png|jpg|webp)(\?v=\d+)?$/.test(val)) {
        next.push(val);
      }
    }
    t.images = next;
    for (const u of was) {
      if (next.indexOf(u) === -1 && /^\/files\/thread-images\/[a-z0-9-]+\.(png|jpg|webp)(\?v=\d+)?$/.test(u)) {
        try { await fsp.unlink(path.join(FILES, 'thread-images', u.split('?')[0].split('/').pop())); } catch {}
      }
    }

    t.anon = !!b.anon;
    t.editedAt = Date.now();
    t.updatedAt = Date.now();
    save();
    broadcast('thread', publicThread(t));
    sendJSON(res, 200, { ok: true, thread: publicThread(t) });
  });

  // 帖主/管理员在帖子页删除：一律带痕（墓碑占位）
  route('POST', /^\/api\/threads\/([a-z0-9]+)\/delete$/, async (req, res, m) => {
    const t = thread(m[1]);
    if (!t) throw httpError(404, '未找到该帖子。');
    const a = canManage(req, t);
    t.deleted = true;
    t.deletedMode = 'trace';
    t.deletedBy = { role: a.as, name: a.name, id: a.id };
    t.pinned = false;
    save();
    notify(t.authorId, 'deleteThread', a, { threadId: t.id, threadTitle: t.title, by: a.as });
    broadcast('thread', publicThread(t));
    sendJSON(res, 200, { ok: true, mode: 'trace' });
  });

  route('POST', /^\/api\/replies\/([a-z0-9]+)\/delete$/, async (req, res, m) => {
    const owner = DB.threads.find(t => (t.replies || []).some(r => r.id === m[1]));
    if (!owner) throw httpError(404, '未找到该回复。');
    const r = owner.replies.find(x => x.id === m[1]);
    if (r.deleted) throw httpError(400, '该评论已删除。');
    const a = actorOf(req);
    /* 管理员角色卡也算管理员：与前端 me.admin / isAdmin(req) 的判定保持一致。
     * 这里只认管理员角色卡或后台会话，不把残留 ff_admin cookie 的普通账号算进去。 */
    const isAdminUser = a.role === 'admin' || isAdminRole(sessionUser(req));
    if (!isAdminUser && a.id !== r.authorId && a.id !== owner.authorId) {
      throw httpError(403, '只有回复者、帖主或管理员可以删除。');
    }
    r.deleted = true;
    r.deletedBy = { role: isAdminUser ? 'admin' : (a.id === r.authorId ? 'self' : 'owner'), name: a.name, id: a.id };
    save();
    notify(r.authorId, 'deleteReply', a, { threadId: owner.id, threadTitle: owner.title, by: r.deletedBy.role });
    broadcast('reply', { threadId: owner.id, reply: publicReply(r) });
    sendJSON(res, 200, { ok: true });
  });

  /* ---------- 管理员：频道 / 公告 / 编辑所有帖子 ---------- */
  route('POST', /^\/api\/admin\/channels$/, async (req, res) => {
    needAdmin(req);
    const b = await readJSON(req);
    const name = requireText(b.name, 24, '频道名称');
    if (DB.channels.some(c => c.name === name)) throw httpError(409, '该频道已存在。');
    const c = {
      id: uid(), name, desc: text(b.desc, 120, '频道简介'),
      order: (DB.channels.reduce((mx, x) => Math.max(mx, x.order || 0), 0) || 0) + 1,
      createdAt: Date.now(), createdBy: 'admin'
    };
    DB.channels.push(c);
    save();
    broadcast('channel', publicChannel(c));
    sendJSON(res, 200, { ok: true, channel: publicChannel(c) });
  });

  route('POST', /^\/api\/admin\/announcement$/, async (req, res) => {
    needAdmin(req);
    const b = await readJSON(req);
    const body = requireText(b.text, 1000, '公告内容');
    const id = uid();
    const image = await saveImage(b.image, 'announcements', id);
    DB.announcement = { text: body, image, author: '管理员', updatedAt: Date.now() };
    save();
    broadcast('announcement', DB.announcement);
    sendJSON(res, 200, { ok: true, announcement: DB.announcement });
  });

  route('GET', /^\/api\/admin\/threads$/, async (req, res) => {
    needAdmin(req);
    sendJSON(res, 200, DB.threads.slice().reverse().map(t => ({
      ...publicThread(t), channelName: (channel(t.channelId) || {}).name || ''
    })));
  });

  route('POST', /^\/api\/admin\/threads\/([a-z0-9]+)\/edit$/, async (req, res, m) => {
    needAdmin(req);
    const t = thread(m[1]);
    if (!t) throw httpError(404, '未找到该帖子。');
    const b = await readJSON(req);
    t.title = requireText(b.title, 120, '标题');
    t.body = requireText(b.body, 5000, '正文');
    t.mentions = mentionMeta(t.body);
    if (channel(b.channelId)) t.channelId = b.channelId;
    // 管理员可改发帖人：选一个已注册账号（按 id）或填自定义网名（author）
    if (b.authorMode === 'user') {
      const u = b.authorId && DB.users.find(x => x.id === b.authorId);
      if (!u) throw httpError(400, '所选发帖账号不存在。');
      t.authorId = u.id; t.author = u.nickname; t.avatar = u.avatar || null;
    } else if (b.authorMode === 'custom') {
      const custom = requireText(b.author, 24, '发帖人网名');
      t.authorId = null; t.author = custom; t.avatar = null;
    } else if (b.authorMode === 'admin') {
      t.authorId = 'admin'; t.author = '管理员'; t.avatar = null;
    }
    t.updatedAt = Date.now();
    save();
    broadcast('thread', publicThread(t));
    sendJSON(res, 200, { ok: true, thread: publicThread(t) });
  });

  // 管理员删除帖子：带痕（墓碑占位）/ 无痕（彻底移除并清理配图）
  route('POST', /^\/api\/admin\/threads\/([a-z0-9]+)\/delete$/, async (req, res, m) => {
    needAdmin(req);
    const t = thread(m[1]);
    if (!t) throw httpError(404, '未找到该帖子。');
    let b = {};
    try { b = await readJSON(req); } catch {}
    const mode = b.mode === 'purge' ? 'purge' : 'trace';
    if (mode === 'purge') {
      const a = { id: 'admin', name: '管理员', role: 'admin', as: 'admin' };
      const imgs = t.images || [];
      DB.threads = DB.threads.filter(x => x.id !== t.id);
      save();
      for (const u of imgs) {
        try { if (u && /^\/files\/thread-images\/[a-z0-9-]+\.(png|jpg|webp)(\?v=\d+)?$/.test(u)) await fsp.unlink(path.join(FILES, 'thread-images', u.split('?')[0].split('/').pop())); } catch {}
      }
      notify(t.authorId, 'deleteThread', a, { threadId: t.id, threadTitle: t.title, by: 'admin-purge' });
      broadcast('threadDelete', { id: t.id });
      sendJSON(res, 200, { ok: true, mode });
      return;
    }
    t.deleted = true;
    t.deletedMode = 'trace';
    t.deletedBy = { role: 'admin', name: '管理员', id: 'admin' };
    t.pinned = false;
    save();
    notify(t.authorId, 'deleteThread', { id: 'admin', name: '管理员', role: 'admin', as: 'admin' }, { threadId: t.id, threadTitle: t.title, by: 'admin-trace' });
    broadcast('thread', publicThread(t));
    sendJSON(res, 200, { ok: true, mode });
  });

  return { migrate, ensureShape, mentionMeta, notifyChatMentions, notify };
};
