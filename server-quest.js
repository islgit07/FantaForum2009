#!/usr/bin/env node
/* 怪啖论坛 · 调查委托模块
 * 由 server.js 通过 installQuests(ctx) 注入依赖后注册路由。
 *
 * 数据模型（落在同一个 db.json 的 DB.quests）：
 *   { id, seq, title, kind:'main'|'side', cover, desc,
 *     place, when, requirements, status:'open'|'closed',
 *     authorId, author, anon, threadId, votes:[{id,label,voters:[]}],
 *     createdAt, updatedAt, deleted }
 *
 * 重要委托（main）= 主线，红色标记，带「异轨投票」，投票结果决定委托走向；
 * 普通委托（side）= 支线，白色标记，由用户自行发布。
 */
'use strict';

const DEFAULT_COVER = '/assets/quest-default.webp';

module.exports = function installQuests(ctx) {
  const {
    DB, save, route, broadcast, sessionUser, isAdmin,
    httpError, sendJSON, readJSON, text, requireText, uid, saveImage
  } = ctx;

  /* ---------- 数据初始化 ---------- */
  function ensureShape() {
    if (!Array.isArray(DB.quests)) DB.quests = [];
    if (!('questSeq' in DB)) DB.questSeq = 0;
    if (!Array.isArray(DB.questComments)) DB.questComments = [];
    if (!('questCommentSeq' in DB)) DB.questCommentSeq = 0;
    for (const q of DB.quests) {
      if (!Array.isArray(q.votes)) q.votes = [];
      q.votes.forEach(v => { if (!Array.isArray(v.voters)) v.voters = []; });
      if (!q.status) q.status = 'open';
      if (typeof q.deleted !== 'boolean') q.deleted = false;
    }
  }
  ensureShape();

  /* ---------- 工具 ---------- */
  function findQuest(id) {
    return DB.quests.find(q => q.id === id && !q.deleted) || null;
  }
  /* 只认 https 图片地址，避免 data:/javascript: 混进封面 */
  function safeImageUrl(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s.length < 12 || s.length > 1200) return null;
    if (!/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return null;
    if (!/\.(png|jpe?g|gif|webp|avif)(\?[^\s"'<>]*)?$/i.test(s)) return null;
    return s;
  }
  function excerptOf(s, n) {
    return String(s == null ? '' : s)
      .replace(/<img\b[^>]*>/gi, '〔图片〕')
      .replace(/\[emoji:\d+\]/g, '〔表情〕')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, n || 96);
  }
  /* 委托评论：网名与头像实时取用户档案，改名/换头像后旧评论同步更新 */
  function commentsOf(qid, meId) {
    return DB.questComments
      .filter(c => c.questId === qid && !c.deleted)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(c => {
        const u = c.authorId && DB.users.find(x => x.id === c.authorId);
        return {
          id: c.id,
          author: u ? u.nickname : c.author,
          authorId: c.authorId || null,
          avatar: (u && u.avatar) || c.avatar || null,
          noProfile: !!u && c.noProfile,
          text: c.text,
          createdAt: c.createdAt,
          canDelete: !!meId && c.authorId === meId
        };
      });
  }
  function commentCountOf(qid) {
    return DB.questComments.filter(c => c.questId === qid && !c.deleted).length;
  }

  function voteTotal(q) {
    return (q.votes || []).reduce((a, v) => a + (v.voters || []).length, 0);
  }
  function publicQuest(q, meId, full, adminView) {
    const author = DB.users.find(u => u.id === q.authorId);
    const out = {
      id: q.id,
      title: q.title,
      kind: q.kind,
      status: q.status,
      cover: q.cover || DEFAULT_COVER,
      place: q.place || '',
      when: q.when || '',
      author: q.anon ? '匿名' : (author ? author.nickname : (q.author || '')),
      authorId: q.anon ? null : q.authorId,
      avatar: q.anon ? null : (author && author.avatar) || null,
      anon: !!q.anon,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      threadId: q.threadId || null,
      voteTotal: voteTotal(q),
      commentCount: commentCountOf(q.id),
      excerpt: excerptOf(q.desc, 96)
    };
    if (full) {
      out.desc = q.desc || '';
      out.requirements = q.requirements || '';
      out.votes = (q.votes || []).map(v => ({
        id: v.id,
        label: v.label,
        count: (v.voters || []).length,
        mine: !!(meId && (v.voters || []).includes(meId))
      }));
      out.myVote = meId ? ((q.votes.find(v => (v.voters || []).includes(meId)) || {}).id || null) : null;
      out.editable = !!meId && q.authorId === meId && !q.anon;
      out.canManage = out.editable || !!adminView;
      out.comments = commentsOf(q.id, meId);
      out.commentTotal = commentCountOf(q.id);
    }
    return out;
  }
  function requireUser(req, msg) {
    const u = sessionUser(req);
    if (!u) throw httpError(401, msg || '请先登入怪啖论坛。');
    if (u.mutedUntil && Date.now() < u.mutedUntil) throw httpError(403, '你当前处于禁言状态，暂时不能发布委托。');
    return u;
  }
  /* 重要委托的选项：2~6 项，空项丢掉 */
  function parseOptions(raw) {
    const list = (Array.isArray(raw) ? raw : [])
      .map(x => text(x, 40, '选项'))
      .filter(Boolean);
    if (list.length < 2) throw httpError(400, '重要委托至少要有两个异轨选项。');
    if (list.length > 6) throw httpError(400, '异轨选项最多 6 个。');
    return list.map((label, i) => ({ id: 'opt' + (i + 1), label, voters: [] }));
  }

  /* ---------- 列表 ---------- */
  route('GET', /^\/api\/quests$/, async (req, res, m, url) => {
    const me = sessionUser(req);
    const kind = url.searchParams.get('kind') || '';
    const status = url.searchParams.get('status') || '';
    const list = DB.quests
      .filter(q => !q.deleted)
      .filter(q => !kind || q.kind === kind)
      .filter(q => !status || status === 'all' || q.status === status)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'main' ? -1 : 1;   // 重要委托置顶
        return b.createdAt - a.createdAt;
      });
    sendJSON(res, 200, {
      quests: list.map(q => publicQuest(q, me && me.id)),
      mainCount: DB.quests.filter(q => !q.deleted && q.kind === 'main' && q.status === 'open').length,
      sideCount: DB.quests.filter(q => !q.deleted && q.kind === 'side' && q.status === 'open').length
    });
  });

  /* ---------- 详情 ---------- */
  route('GET', /^\/api\/quests\/([a-z0-9]+)$/, async (req, res, m) => {
    const q = findQuest(m[1]);
    if (!q) throw httpError(404, '未找到该委托。');
    const me = sessionUser(req);
    sendJSON(res, 200, { quest: publicQuest(q, me && me.id, true, isAdmin(req)) });
  });

  /* ---------- 发布委托 ---------- */
  route('POST', /^\/api\/quests$/, async (req, res) => {
    const admin = isAdmin(req);
    const u = admin ? null : requireUser(req);
    const b = await readJSON(req);
    const kind = b.kind === 'main' ? 'main' : 'side';
    if (kind === 'main' && !admin) throw httpError(403, '重要委托（主线）只能由管理员发布。');
    /* 管理员会话不是玩家会话（u 为 null），后台也能直接发布普通委托 */

    const title = requireText(b.title, 80, '委托标题');
    const desc = requireText(b.desc, 4000, '委托描述');
    const place = text(b.place, 120, '委托地点');
    const when = text(b.when == null ? b.time : b.when, 120, '委托时间');
    const requirements = text(b.requirements, 600, '委托要求');
    const anon = (!u || kind === 'main') ? true : (!!b.anon);
    const threadId = b.threadId ? String(b.threadId) : null;
    if (threadId && !DB.threads.some(t => t.id === threadId)) throw httpError(400, '关联的帖子不存在。');

    const id = uid();
    let cover = null;
    if (b.image) {
      const ext = safeImageUrl(b.image);
      if (ext) cover = ext;
      else if (/^data:image\/(png|jpeg|webp);base64,/i.test(String(b.image))) {
        cover = await saveImage(b.image, 'quest-covers', id);
      } else throw httpError(400, '委托图片只支持上传 PNG / JPG / WebP，或 https 图片直链。');
    }

    const quest = {
      id,
      seq: ++DB.questSeq,
      title, kind, cover,
      desc, place, when, requirements,
      status: 'open',
      authorId: u ? u.id : null,
      author: !u ? '委托发布处' : (anon ? (kind === 'main' ? '委托发布处' : '匿名') : (u.nickname || '')),
      anon,
      threadId,
      /* 异轨投票暂缓：不传选项也能发重要委托，传了才建投票 */
      votes: kind === 'main' && Array.isArray(b.options) && b.options.length ? parseOptions(b.options) : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deleted: false
    };
    DB.quests.push(quest);
    await save();
    broadcast('quest', { questId: id, action: 'new' });
    sendJSON(res, 200, { quest: publicQuest(quest, u && u.id, true, admin) });
  });

  /* ---------- 编辑委托（委托人本人或管理员） ---------- */
  route('POST', /^\/api\/quests\/([a-z0-9]+)\/edit$/, async (req, res, m) => {
    const admin = isAdmin(req);
    const u = admin ? null : requireUser(req);
    const q = findQuest(m[1]);
    if (!q) throw httpError(404, '未找到该委托。');
    if (!admin && (!u || q.authorId !== u.id)) throw httpError(403, '只有委托人或管理员可以编辑这条委托。');
    const b = await readJSON(req);

    if ('title' in b) q.title = requireText(b.title, 80, '委托标题');
    if ('desc' in b) q.desc = requireText(b.desc, 4000, '委托描述');
    if ('place' in b) q.place = text(b.place, 120, '委托地点');
    if ('when' in b) q.when = text(b.when, 120, '委托时间');
    if ('requirements' in b) q.requirements = text(b.requirements, 600, '委托要求');
    if ('kind' in b) q.kind = b.kind === 'main' ? 'main' : 'side';
    if ('status' in b) q.status = b.status === 'closed' ? 'closed' : 'open';
    if ('anon' in b) q.anon = !!b.anon && q.kind === 'side';
    if (q.kind !== 'main') q.votes = [];

    /* 封面：不传=保持；空串=清空回默认图标；https=外链；data:=上传 */
    if ('cover' in b) {
      if (!b.cover) q.cover = null;
      else {
        const url = safeImageUrl(b.cover);
        if (url) q.cover = url;
        else if (/^data:image\/(png|jpeg|webp);base64,/i.test(String(b.cover))) q.cover = await saveImage(b.cover, 'quest-covers', q.id);
        else throw httpError(400, '封面只支持上传 PNG / JPG / WebP，或 https 图片直链。');
      }
    }

    /* 异轨选项：已有投票记录时只能改文字，不能增删 */
    if (q.kind === 'main' && Array.isArray(b.options)) {
      const labels = b.options
        .map(x => (typeof x === 'string' ? x : x && x.label))
        .map(x => text(x, 40, '选项'))
        .filter(Boolean);
      if (labels.length === 1) throw httpError(400, '异轨选项要么留空，要么至少两项。');
      if (labels.length > 6) throw httpError(400, '异轨选项最多 6 个。');
      const old = q.votes || [];
      const voted = old.some(v => (v.voters || []).length);
      if (voted && labels.length !== old.length) {
        throw httpError(400, '该委托已有投票记录，只能修改选项文字，不能增删选项。');
      }
      q.votes = labels.map((label, i) => {
        const prev = old[i];
        return { id: (prev && prev.id) || ('opt' + (i + 1)), label, voters: (prev && prev.voters) || [] };
      });
    }

    q.updatedAt = Date.now();
    await save();
    broadcast('quest', { questId: q.id, action: 'edit' });
    sendJSON(res, 200, { quest: publicQuest(q, u && u.id, true, admin) });
  });

  /* ---------- 委托评论 ---------- */
  route('POST', /^\/api\/quests\/([a-z0-9]+)\/comments$/, async (req, res, m) => {
    const u = requireUser(req, '请先登入后再发表评论。');
    const q = findQuest(m[1]);
    if (!q) throw httpError(404, '未找到该委托。');
    const b = await readJSON(req);
    const txt = requireText(b.text, 500, '评论');
    const c = {
      id: (++DB.questCommentSeq).toString(36) + Date.now().toString(36),
      questId: q.id,
      authorId: u.id,
      author: u.nickname || '',
      avatar: u.avatar || null,
      noProfile: false,
      text: txt,
      createdAt: Date.now(),
      deleted: false
    };
    DB.questComments.push(c);
    q.updatedAt = Date.now();
    await save();
    broadcast('quest', { questId: q.id, action: 'comment', commentTotal: commentCountOf(q.id) });
    sendJSON(res, 200, { comments: commentsOf(q.id, u.id), commentTotal: commentCountOf(q.id) });
  });

  route('POST', /^\/api\/quests\/comments\/([a-z0-9]+)\/delete$/, async (req, res, m) => {
    const admin = isAdmin(req);
    const u = admin ? null : requireUser(req);
    const c = DB.questComments.find(x => x.id === m[1] && !x.deleted);
    if (!c) throw httpError(404, '未找到该评论。');
    if (!admin && (!u || c.authorId !== u.id)) throw httpError(403, '只能删除自己的评论。');
    c.deleted = true;
    c.deletedBy = admin ? 'admin' : (u && u.id) || null;
    await save();
    broadcast('quest', { questId: c.questId, action: 'comment-delete', commentTotal: commentCountOf(c.questId) });
    const meId = admin ? null : (u && u.id);
    sendJSON(res, 200, { comments: commentsOf(c.questId, meId), commentTotal: commentCountOf(c.questId) });
  });

  /* ---------- 异轨投票（只对重要委托） ---------- */
  route('POST', /^\/api\/quests\/([a-z0-9]+)\/vote$/, async (req, res, m) => {
    const u = requireUser(req, '请先登入后再参与异轨投票。');
    const q = findQuest(m[1]);
    if (!q) throw httpError(404, '未找到该委托。');
    if (q.kind !== 'main') throw httpError(400, '只有重要委托才有异轨投票。');
    if (q.status !== 'open') throw httpError(400, '该委托已结案，投票已关闭。');
    const b = await readJSON(req);
    const opt = q.votes.find(v => v.id === b.optionId);
    if (!opt) throw httpError(400, '请选择一个有效的选项。');
    /* 一人一票，改票即换边 */
    for (const v of q.votes) v.voters = (v.voters || []).filter(x => x !== u.id);
    opt.voters.push(u.id);
    q.updatedAt = Date.now();
    await save();
    broadcast('quest', { questId: q.id, action: 'vote', voteTotal: voteTotal(q) });
    sendJSON(res, 200, { quest: publicQuest(q, u.id, true) });
  });

  /* ---------- 结案 / 重开（作者本人或管理员） ---------- */
  route('POST', /^\/api\/quests\/([a-z0-9]+)\/status$/, async (req, res, m) => {
    const admin = isAdmin(req);
    const u = admin ? null : requireUser(req);
    const q = findQuest(m[1]);
    if (!q) throw httpError(404, '未找到该委托。');
    if (!admin && (!u || q.authorId !== u.id)) throw httpError(403, '只有委托人或管理员可以改变委托状态。');
    const b = await readJSON(req);
    const status = b.status === 'closed' ? 'closed' : 'open';
    q.status = status;
    q.updatedAt = Date.now();
    await save();
    broadcast('quest', { questId: q.id, action: 'status', status });
    sendJSON(res, 200, { quest: publicQuest(q, u && u.id, true, admin) });
  });

  /* ---------- 删除（本人或管理员，软删） ---------- */
  route('POST', /^\/api\/quests\/([a-z0-9]+)\/delete$/, async (req, res, m) => {
    const admin = isAdmin(req);
    const u = admin ? null : requireUser(req);
    const q = findQuest(m[1]);
    if (!q) throw httpError(404, '未找到该委托。');
    if (!admin && (!u || q.authorId !== u.id)) throw httpError(403, '只有委托人或管理员可以删除。');
    q.deleted = true;
    q.updatedAt = Date.now();
    await save();
    broadcast('quest', { questId: q.id, action: 'delete' });
    sendJSON(res, 200, { ok: true });
  });

  return { ensureShape, DEFAULT_COVER };
};