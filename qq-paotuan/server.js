#!/usr/bin/env node
'use strict';

/**
 * 单房间 · 怪啖跑团平台（1d6 规则） —— 自包含服务端
 * ---------------------------------------------------------
 * 仅使用 Node 内置模块（http / fs / path / crypto + 全局 fetch）。
 * 数据层可插拔：配置了 SUPABASE_URL + SUPABASE_ANON_KEY 走 PostgREST，
 * 否则走内存。两种模式共用同一套业务处理逻辑。
 *
 * 启动：node server.js      （可配 PORT / HOST）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '').trim();
const USE_DB = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const T_CHAR = 'characters';
const T_MSG = 'messages';
const T_ROOM = 'room_state';

/* 怪啖论坛（本地项目）角色卡同步源 */
const FORUM_DB_PATH = String(process.env.GUAI_DAN_DB || 'E:\\绘画\\2026\\企划\\怪啖论坛\\Web\\data\\db.json');
const FORUM_AVATAR_DIR = path.join(path.dirname(FORUM_DB_PATH), 'files', 'avatars');
/* 论坛表情包文件目录（和论坛共用同一份，不复制不冗余） */
const FORUM_EMOJI_DIR = path.join(path.dirname(FORUM_DB_PATH), 'files', 'emojis');
const AVATAR_DIR = path.join(ROOT, 'avatars');

/* =========================================================================
 * 一、规则数据
 * ========================================================================= */

const ABILITIES = [
  { id: 'str', name: '力量', en: 'STR' },
  { id: 'dex', name: '敏捷', en: 'DEX' },
  { id: 'con', name: '体质', en: 'CON' },
  { id: 'inte', name: '智力', en: 'INT' },
  { id: 'wis', name: '感知', en: 'WIS' },
  { id: 'cha', name: '魅力', en: 'CHA' },
];

const SKILLS = [
  { id: 'athletics', name: '运动', en: 'Athletics', ability: 'str' },

  { id: 'acrobatics', name: '体操', en: 'Acrobatics', ability: 'dex' },
  { id: 'sleight', name: '巧手', en: 'Sleight of Hand', ability: 'dex' },
  { id: 'stealth', name: '隐匿', en: 'Stealth', ability: 'dex' },

  { id: 'arcana', name: '奥秘', en: 'Arcana', ability: 'inte' },
  { id: 'history', name: '历史', en: 'History', ability: 'inte' },
  { id: 'investigation', name: '调查', en: 'Investigation', ability: 'inte' },
  { id: 'nature', name: '自然', en: 'Nature', ability: 'inte' },
  { id: 'religion', name: '宗教', en: 'Religion', ability: 'inte' },

  { id: 'animal', name: '驯兽', en: 'Animal Handling', ability: 'wis' },
  { id: 'insight', name: '洞悉', en: 'Insight', ability: 'wis' },
  { id: 'medicine', name: '医药', en: 'Medicine', ability: 'wis' },
  { id: 'perception', name: '察觉', en: 'Perception', ability: 'wis' },
  { id: 'survival', name: '求生', en: 'Survival', ability: 'wis' },

  { id: 'deception', name: '欺瞒', en: 'Deception', ability: 'cha' },
  { id: 'intimidation', name: '威吓', en: 'Intimidation', ability: 'cha' },
  { id: 'performance', name: '表演', en: 'Performance', ability: 'cha' },
  { id: 'persuasion', name: '说服', en: 'Persuasion', ability: 'cha' },
];

const CLASSES = [
  '野蛮人', '吟游诗人', '牧师', '德鲁伊', '战士', '武僧',
  '圣武士', '游侠', '游荡者', '术士', '邪术师', '法师',
];

// 15 种官方状态
const CONDITIONS = [
  { id: 'blinded', name: '目盲', desc: '无法视物，攻击检定劣势，受攻击时为优势' },
  { id: 'charmed', name: '魅惑', desc: '不能攻击魅惑来源，来源对其社交检定有优势' },
  { id: 'deafened', name: '耳聋', desc: '无法听见声音，依赖听觉的检定自动失败' },
  { id: 'exhausted', name: '力竭', desc: '累计等级，逐级叠加减值（1~6 级）' },
  { id: 'frightened', name: '恐慌', desc: '看见来源时攻击与检定劣势，且不能主动靠近' },
  { id: 'grappled', name: '被擒', desc: '速度归零，可挣脱' },
  { id: 'incapacitated', name: '失能', desc: '不能动作或反应' },
  { id: 'invisible', name: '隐形', desc: '无法被看见，攻击为优势' },
  { id: 'paralyzed', name: '麻痹', desc: '失能且无法移动，受攻击为优势' },
  { id: 'petrified', name: '石化', desc: '化为石头，失能且失去知觉' },
  { id: 'poisoned', name: '中毒', desc: '攻击检定与属性检定劣势' },
  { id: 'prone', name: '倒地', desc: '移动力受限，近战攻击对其优势' },
  { id: 'restrained', name: '束缚', desc: '速度归零，攻击与敏捷豁免劣势' },
  { id: 'stunned', name: '震慑', desc: '失能、无法移动，力量与敏捷豁免自动失败' },
  { id: 'unconscious', name: '昏迷', desc: '失能、倒地、无法行动' },
];

const ABILITY_IDS = ABILITIES.map((a) => a.id);

/* ------------------------- 怪啖自创规则 · 1d6 版 -------------------------
 * 一切默认掷 1d6（优势/劣势 2d6 取高低），不加任何属性/熟练修正。
 * 角色数值只有 HP + SAN；没有检定 / DC 判定，只剩下自由掷骰和战斗。
 * 序章 BUFF 提供 HP 加成。
 */
const BUFFS = [
  {
    id: 'combat', name: '战斗专精', desc: '战斗相关判定 DC-2',
    hpBonus: 0, dcMod: { combat: -2, investigate: 0 },
  },
  {
    id: 'investigate', name: '专心调查', desc: '线索调查相关判定 DC-2，HP+1',
    hpBonus: 1, dcMod: { combat: 0, investigate: -2 },
  },
  {
    id: 'balanced', name: '均衡主义', desc: '战斗和调查判定 DC 均-1，HP+1',
    hpBonus: 1, dcMod: { combat: -1, investigate: -1 },
  },
  {
    id: 'gambler', name: '赌徒', desc: '不加点数、纯靠运气，可强制逆转一次判定失败，HP+2',
    hpBonus: 2, dcMod: { combat: 0, investigate: 0 }, reverse: true,
  },
];
const BUFF_MAP = new Map(BUFFS.map((b) => [b.id, b]));

/** 取角色 BUFF（未选返回 null） */
function getBuff(c) {
  return c && BUFF_MAP.has(String(c.buff || '')) ? BUFF_MAP.get(String(c.buff)) : null;
}

/** BUFF 的 HP 加成 */
function buffHpBonus(buffId) {
  const b = BUFF_MAP.has(String(buffId || '')) ? BUFF_MAP.get(String(buffId)) : null;
  return b ? Number(b.hpBonus) || 0 : 0;
}

/* =========================================================================
 * 二、基础工具
 * ========================================================================= */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 怪啖规则：一切默认掷 1d6 */
function d6() {
  return crypto.randomInt(1, 7);
}

/** 生命骰之类的小骰子 */
function rollDie(sides) {
  const n = Math.max(2, Math.min(100, Number(sides) || 6));
  return crypto.randomInt(1, n + 1);
}

function dN(sides) {
  return crypto.randomInt(1, sides + 1);
}

function nowISO() {
  return new Date().toISOString();
}

function uid(prefix) {
  return (prefix || '') + crypto.randomBytes(6).toString('hex');
}

/** 号#xxxx —— 展示用身份标签（现在账号即玩家名，原样返回） */
function displayId(clientId) {
  const s = String(clientId || '').trim();
  return s || '匿名';
}

function json(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(httpError(400, 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/* =========================================================================
 * 三、骰子引擎（全部在服务端结算）
 * ========================================================================= */

/**
 * 解析 NdM±K。允许省略 N（视为 1），允许纯数字常量。
 * 返回 { n, sides, flat, text }
 */
function parseDice(expr) {
  const raw = String(expr == null ? '' : expr).replace(/\s+/g, '').toLowerCase();
  if (!raw) throw httpError(400, '骰子表达式为空');

  if (/^[+-]?\d+$/.test(raw)) {
    const flat = parseInt(raw, 10);
    return { n: 0, sides: 0, flat, text: String(flat) };
  }

  const m = raw.match(/^(\d{0,2})d(\d{1,4})([+-]\d{1,4})?$/);
  if (!m) throw httpError(400, '无法解析骰子表达式，示例：1d20 / 2d6+3 / d8-1');

  const n = clampInt(m[1] === '' ? 1 : m[1], 1, 40, 1);
  const sides = clampInt(m[2], 2, 1000, 6);
  const flat = m[3] ? parseInt(m[3], 10) : 0;
  return {
    n,
    sides,
    flat,
    text: `${n}d${sides}${flat ? (flat > 0 ? '+' + flat : flat) : ''}`,
  };
}

/** 投一次（不含 adv/dis） */
function rollOnce(parsed) {
  const rolls = [];
  let sum = 0;
  for (let i = 0; i < parsed.n; i += 1) {
    const v = parsed.sides ? dN(parsed.sides) : 0;
    rolls.push(v);
    sum += v;
  }
  return { rolls, total: sum + parsed.flat };
}

function formatRolls(rolls) {
  if (!rolls.length) return '';
  return `[${rolls.join(',')}]`;
}

/** 自由掷骰：NdM±K，支持 adv/dis（整条表达式掷两次取高/低） */
function rollExpression(expr, mode) {
  const parsed = parseDice(expr);
  const m = mode === 'adv' || mode === 'dis' ? mode : 'normal';

  if (m === 'normal') {
    const r = rollOnce(parsed);
    return {
      parsed, mode: m, rolls: [r.rolls], totals: [r.total], total: r.total, kept: 0,
      detail: `${parsed.text} ${formatRolls(r.rolls)}${parsed.n ? (parsed.flat ? ` ${parsed.flat > 0 ? '+' : '-'} ${Math.abs(parsed.flat)}` : '') : ''} = ${r.total}`,
    };
  }

  const a = rollOnce(parsed);
  const b = rollOnce(parsed);
  const useA = m === 'adv' ? a.total >= b.total : a.total <= b.total;
  const kept = useA ? a : b;
  return {
    parsed, mode: m, rolls: [a.rolls, b.rolls], totals: [a.total, b.total], total: kept.total, kept: useA ? 0 : 1,
    detail: `${parsed.text} ${m === 'adv' ? '优势' : '劣势'} → ${formatRolls(a.rolls)}=${a.total} / ${formatRolls(b.rolls)}=${b.total} → 取 ${kept.total}`,
  };
}

/* =========================================================================
 * 四、房间状态默认值
 * ========================================================================= */

function defaultCombat() {
  return { active: false, round: 0, turn: 0, order: [], plotKill: false };
}

function defaultRoom() {
  return { dm: null, announcement: null, gmNotes: '', combat: defaultCombat(), channels: [{ id: 'main', name: '主频道' }] };
}

function normalizeRoom(input) {
  const out = defaultRoom();
  if (!input || typeof input !== 'object') return out;

  if (input.dm && input.dm.clientId) {
    out.dm = { clientId: String(input.dm.clientId), name: String(input.dm.name || '') };
  }

  if (typeof input.gmNotes === 'string') out.gmNotes = input.gmNotes.slice(0, 6000);

  if (input.announcement && typeof input.announcement === 'object' && input.announcement.text) {
    out.announcement = {
      text: String(input.announcement.text).slice(0, 600),
      by: String(input.announcement.by || '').slice(0, 40),
      at: String(input.announcement.at || ''),
    };
  }

  if (Array.isArray(input.channels) && input.channels.length) {
    const seen = new Set();
    const list = [];
    for (const c of input.channels) {
      if (!c || !c.id) continue;
      const id = String(c.id);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({ id, name: String(c.name || '频道').slice(0, 24) });
    }
    if (list.length) out.channels = list;
  }

  if (input.combat && typeof input.combat === 'object') {
    const cb = input.combat;
    out.combat = {
      active: Boolean(cb.active),
      round: clampInt(cb.round, 0, 999, 0),
      turn: clampInt(cb.turn, 0, 999, 0),
      plotKill: Boolean(cb.plotKill),
      order: Array.isArray(cb.order)
        ? cb.order
            .filter((o) => o && o.name)
            .map((o) => ({
              id: String(o.id || uid('e-')),
              refId: o.refId ? String(o.refId) : null,
              name: String(o.name).slice(0, 40),
              kind: o.kind === 'monster' ? 'monster' : 'pc',
              init: clampInt(o.init, -99, 99, 0),
              hp: clampInt(o.hp, -99, 9999, 0),
              maxHp: clampInt(o.maxHp, 0, 9999, 10),
              ac: clampInt(o.ac, 0, 99, 10),
              ownerClientId: o.ownerClientId ? String(o.ownerClientId) : '',
              san: o.san === undefined || o.san === null ? undefined : clampInt(o.san, 0, 99, 0),
              hypnotized: Boolean(o.hypnotized),
            }))
        : [],
    };
    if (!out.combat.order.length) {
      /* 空战斗重置时保留剧情杀预设，避免开战前开启的开关被清掉 */
      const keepPlotKill = out.combat.plotKill;
      out.combat = defaultCombat();
      out.combat.plotKill = keepPlotKill;
    }
    if (out.combat.turn >= out.combat.order.length) out.combat.turn = 0;
  }

  return out;
}

/* =========================================================================
 * 五、数据层
 * ========================================================================= */

const CHARACTER_DEFAULTS = {
  name: '未命名',
  isNpc: false,
  deathSaves: { s: 0, f: 0, dead: false, stable: false },
  owner: '',
  ownerClientId: '',
  avatar: '',
  maxHp: 8,
  hp: 8,
  san: 3,
  notes: '',
  buff: '',
  reverseUsed: false,
};

/**
 * 角色卡归一化。
 * 关键：先合并「已有记录 + 请求字段」，再归一化。
 * 这样 PATCH 只带 id+hp 时，不会把没带的字段重置成默认值。
 */
function normalizeCharacter(input, existing) {
  const base = existing ? Object.assign({}, CHARACTER_DEFAULTS, existing) : Object.assign({}, CHARACTER_DEFAULTS);
  const out = Object.assign({}, base);

  for (const key of Object.keys(CHARACTER_DEFAULTS)) {
    if (input && Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
      out[key] = input[key];
    }
  }

  out.name = String(out.name || '未命名').trim().slice(0, 24) || '未命名';
  out.owner = String(out.owner || '').slice(0, 40);
  out.ownerClientId = String(out.ownerClientId || '').slice(0, 64);
  out.avatar = String(out.avatar || '').slice(0, 300);

  out.isNpc = Boolean(out.isNpc);
  const ds = out.deathSaves && typeof out.deathSaves === 'object' ? out.deathSaves : {};
  out.deathSaves = {
    s: clampInt(ds.s, 0, 3, 0),
    f: clampInt(ds.f, 0, 3, 0),
    dead: Boolean(ds.dead),
    stable: Boolean(ds.stable),
  };

  out.maxHp = clampInt(out.maxHp, 1, 9999, 8);
  out.hp = clampInt(out.hp, -99, out.maxHp, out.maxHp);
  out.san = clampInt(out.san, 0, 99, 3);
  out.notes = String(out.notes || '').slice(0, 4000);

  /* 怪啖规则：序章 BUFF 四选一；赌徒逆转次数 */
  out.buff = BUFF_MAP.has(String(out.buff || '')) ? String(out.buff) : '';
  out.reverseUsed = Boolean(out.reverseUsed);

  /* 清掉旧 DND 字段，避免残留数据污染前端 */
  for (const key of ['weapons', 'slots', 'cls', 'level', 'str', 'dex', 'con', 'inte', 'wis', 'cha', 'ac', 'proficient', 'conditions']) {
    delete out[key];
  }

  return out;
}

function characterView(c) {
  const view = Object.assign({}, c);
  view.playerName = c.owner || '';
  view.buffInfo = getBuff(c);
  view.reverseReady = Boolean(getBuff(c) && getBuff(c).reverse && !c.reverseUsed);
  if (view.san === undefined || view.san === null) view.san = 3;
  /* 极简规则：对外只暴露血量相关字段，旧存档的 DND 字段一律不返回 */
  for (const key of ['weapons', 'slots', 'cls', 'level', 'str', 'dex', 'con', 'inte', 'wis', 'cha', 'ac', 'proficient', 'conditions']) {
    delete view[key];
  }
  return view;
}

class MemoryStore {
  constructor() {
    this.characters = [];
    this.messages = [];
    this.room = defaultRoom();
    this.seq = 0;
  }

  async loadState() {
    return JSON.parse(JSON.stringify(this.room));
  }

  async saveState(data) {
    this.room = normalizeRoom(data);
    return this.room;
  }

  async listCharacters() {
    return this.characters.map((c) => JSON.parse(JSON.stringify(c)));
  }

  async insertCharacter(c) {
    this.characters.push(JSON.parse(JSON.stringify(c)));
    return JSON.parse(JSON.stringify(c));
  }

  async patchCharacter(id, fields) {
    const idx = this.characters.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    this.characters[idx] = Object.assign({}, this.characters[idx], fields);
    return JSON.parse(JSON.stringify(this.characters[idx]));
  }

  async deleteCharacter(id) {
    const before = this.characters.length;
    this.characters = this.characters.filter((c) => c.id !== id);
    return this.characters.length < before;
  }

  async listMessages(since) {
    const from = Number(since) || 0;
    return this.messages.filter((m) => m.seq > from).map((m) => JSON.parse(JSON.stringify(m)));
  }

  async insertMessage(m) {
    this.seq += 1;
    const row = Object.assign({}, m, { seq: this.seq });
    this.messages.push(JSON.parse(JSON.stringify(row)));
    return JSON.parse(JSON.stringify(row));
  }

  async patchMessage(seq, fields) {
    const idx = this.messages.findIndex((m) => m.seq === Number(seq));
    if (idx < 0) return null;
    this.messages[idx] = Object.assign({}, this.messages[idx], fields);
    return JSON.parse(JSON.stringify(this.messages[idx]));
  }

  async deleteMessage(seq) {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.seq !== Number(seq));
    return this.messages.length < before;
  }
}

/* ---------- 文件持久化：没配 Supabase 时把状态落到 data/store.json ----------
 * 纯内存模式重启即丢数据，跑团日志不能这么处理。继承 MemoryStore 的所有语义，
 * 每次写操作后节流落盘（临时文件 + rename 原子写），进程退出前强制 flush。
 */
const STORE_DIR = String(process.env.QQ_PAOTUAN_DATA || path.join(ROOT, 'data')).trim();
const STORE_FILE = path.join(STORE_DIR, 'store.json');

class FileStore extends MemoryStore {
  constructor(file) {
    super();
    this.file = file;
    this._dirty = false;
    this._timer = null;
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[store] 读取 ' + this.file + ' 失败：' + err.message);
      return;
    }
    try {
      const d = JSON.parse(raw);
      this.characters = Array.isArray(d.characters) ? d.characters : [];
      this.messages = Array.isArray(d.messages) ? d.messages : [];
      this.room = normalizeRoom(d.room || defaultRoom());
      const maxSeq = this.messages.reduce((n, m) => Math.max(n, Number(m.seq) || 0), 0);
      this.seq = Math.max(Number(d.seq) || 0, maxSeq);
      console.log('[store] 已载入 ' + this.characters.length + ' 张角色卡 / ' + this.messages.length + ' 条消息');
    } catch (err) {
      console.warn('[store] ' + this.file + ' 解析失败，按空数据启动：' + err.message);
    }
  }

  _flushNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty) return;
    this._dirty = false;
    const payload = JSON.stringify({
      seq: this.seq,
      room: this.room,
      characters: this.characters,
      messages: this.messages,
    });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this._dirty = true;
      console.error('[store] 写入 ' + this.file + ' 失败：' + err.message);
    }
  }

  _touch() {
    this._dirty = true;
    if (!this._timer) this._timer = setTimeout(() => this._flushNow(), 60);
  }

  /** 进程退出前同步落盘，避免重启丢失最后几十毫秒的写入。 */
  flushNow() {
    this._flushNow();
  }

  async saveState(data) { const r = await super.saveState(data); this._touch(); return r; }
  async insertCharacter(c) { const r = await super.insertCharacter(c); this._touch(); return r; }
  async patchCharacter(id, f) { const r = await super.patchCharacter(id, f); if (r) this._touch(); return r; }
  async deleteCharacter(id) { const r = await super.deleteCharacter(id); if (r) this._touch(); return r; }
  async insertMessage(m) { const r = await super.insertMessage(m); this._touch(); return r; }
  async patchMessage(seq, f) { const r = await super.patchMessage(seq, f); if (r) this._touch(); return r; }
  async deleteMessage(seq) { const r = await super.deleteMessage(seq); if (r) this._touch(); return r; }
}

class PgStore {
  async req(pathAndQuery, opts) {
    const o = opts || {};
    const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: 'application/json',
    };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.prefer) headers.Prefer = o.prefer;
    Object.assign(headers, o.headers || {});

    const res = await fetch(url, {
      method: o.method || 'GET',
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PostgREST ${res.status} ${o.method || 'GET'} ${pathAndQuery} :: ${text.slice(0, 260)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async loadState() {
    const rows = await this.req(`${T_ROOM}?id=eq.1&select=*`);
    const data = Array.isArray(rows) && rows[0] ? rows[0].data : null;
    const room = normalizeRoom(data || defaultRoom());
    if (!data) await this.saveState(room);
    return room;
  }

  async saveState(data) {
    const room = normalizeRoom(data);
    try {
      await this.req(T_ROOM, {
        method: 'POST',
        body: { id: 1, data: room },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    } catch (err) {
      // 兜底：先 PATCH，若行不存在再 POST
      const patched = await this.req(`${T_ROOM}?id=eq.1`, {
        method: 'PATCH',
        body: { data: room },
        prefer: 'return=representation',
      });
      if (!Array.isArray(patched) || !patched.length) {
        await this.req(T_ROOM, { method: 'POST', body: { id: 1, data: room }, prefer: 'return=minimal' });
      }
    }
    return room;
  }

  async listCharacters() {
    const rows = await this.req(`${T_CHAR}?select=*&order=created_at.asc`);
    return Array.isArray(rows) ? rows : [];
  }

  async insertCharacter(c) {
    const rows = await this.req(T_CHAR, {
      method: 'POST',
      body: c,
      prefer: 'return=representation',
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : c;
  }

  async patchCharacter(id, fields) {
    const rows = await this.req(`${T_CHAR}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: fields,
      prefer: 'return=representation',
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async deleteCharacter(id) {
    const rows = await this.req(`${T_CHAR}?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      prefer: 'return=representation',
    });
    return Array.isArray(rows) && rows.length > 0;
  }

  async listMessages(since) {
    const from = Number(since) || 0;
    const filter = from > 0 ? `&seq=gt.${from}` : '';
    const PAGE = 1000;
    const out = [];
    let offset = 0;

    // 分页拉取：PostgREST 默认可能限制单次返回行数，长团日志不能截断
    for (;;) {
      const rows = await this.req(`${T_MSG}?select=*&order=seq.asc&limit=${PAGE}&offset=${offset}${filter}`);
      if (!Array.isArray(rows) || !rows.length) break;
      out.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return out;
  }

  async insertMessage(m) {
    const rows = await this.req(T_MSG, {
      method: 'POST',
      body: m,
      prefer: 'return=representation',
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : m;
  }

  async patchMessage(seq, fields) {
    const rows = await this.req(`${T_MSG}?seq=eq.${Number(seq)}`, {
      method: 'PATCH',
      body: fields,
      prefer: 'return=representation',
    });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  }

  async deleteMessage(seq) {
    const rows = await this.req(`${T_MSG}?seq=eq.${Number(seq)}`, {
      method: 'DELETE',
      prefer: 'return=representation',
    });
    return Array.isArray(rows) && rows.length > 0;
  }
}

const store = USE_DB ? new PgStore() : new FileStore(STORE_FILE);

/* =========================================================================
 * 六、业务处理
 * ========================================================================= */

function messageChannel(m) {
  return m && m.channel ? m.channel : 'main';
}

function messageOrder(a, b) {
  const pa = a.pos == null ? a.seq : a.pos;
  const pb = b.pos == null ? b.seq : b.pos;
  if (pa !== pb) return pa - pb;
  return (a.seq || 0) - (b.seq || 0);
}

/** 可见性裁剪（服务端强制） */
function canSee(msg, me, dmId) {
  const vis = msg.visibility || 'all';
  if (vis === 'all') return true;
  if (!me) return false;
  if (msg.sender === me) return true;
  if (dmId && me === dmId) return true;
  const aud = Array.isArray(msg.audience) ? msg.audience : [];
  return aud.includes(me);
}

/** 暗骰：非主持人只能看到「有人暗骰了」，点数一律剥掉，防止从接口里偷看 */
function maskDarkRoll(m) {
  const meta = m.meta && typeof m.meta === 'object' ? m.meta : null;
  if (!meta || !meta.dark) return m;
  const who = String(meta.characterName || m.author || '有人');
  return Object.assign({}, m, {
    text: `${who} 进行了一次暗骰`,
    meta: {
      type: meta.type || 'dice',
      dark: true,
      gm: meta.gm,
      characterName: who,
      characterId: meta.characterId || '',
      avatar: meta.avatar || '',
    },
  });
}

function canEditCharacter(char, me, dmId) {
  if (!me) return false;
  if (char.ownerClientId && char.ownerClientId === me) return true;
  if (dmId && me === dmId) return true;
  if (!char.ownerClientId && dmId && me === dmId) return true;
  return false;
}

/** 语法自动识别，服务端权威判定（优先于按钮） */
/* ---------------------------------------------------------------------
 * 行内语法解析（服务端权威）
 *   #动作 / *动作        → 动作（一个标记就够；成对写时去掉收尾的 *）
 *   （场外） / (场外)    → 皮下
 *   其余文字             → 按当前选中的类型（默认 角色说话）
 *
 * 一条输入里出现多个标记时，拆成多条消息依次发出：
 *   "测试 #123 （什么）" → [角色]测试 / [动作]123 / [皮下]什么
 *
 * 为避免误伤（2*3、C#），* 和 # 只有在「开头」或「前面是空格/标点/右括号」时才算标记；
 * 左右括号永远算标记。
 * ------------------------------------------------------------------- */
const MARKER_BOUNDARY = /[\s，。！？；：、,.!?;:）)」』】]/;

function isMarkerAt(text, i) {
  const ch = text[i];
  if (ch === '（' || ch === '(') return true;
  if (ch !== '*' && ch !== '#') return false;
  if (i === 0) return true;
  return MARKER_BOUNDARY.test(text[i - 1]);
}

function parseSegments(text, defaultKind) {
  const raw = String(text == null ? '' : text);
  const segs = [];
  let buf = '';
  let i = 0;

  const flush = () => {
    const t = buf.trim();
    if (t) segs.push({ kind: defaultKind, text: t });
    buf = '';
  };

  while (i < raw.length) {
    const ch = raw[i];

    // {1d20+3} 这类行内骰当作整体，内部不参与分段
    if (ch === '{') {
      const end = raw.indexOf('}', i + 1);
      if (end !== -1) {
        buf += raw.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    if ((ch === '*' || ch === '#') && isMarkerAt(raw, i)) {
      flush();
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] === '{') {
          const e = raw.indexOf('}', j + 1);
          if (e !== -1) { j = e + 1; continue; }
        }
        if (isMarkerAt(raw, j)) break;
        j += 1;
      }
      let body = raw.slice(i + 1, j).trim();
      if (ch === '*' && body.endsWith('*')) body = body.slice(0, -1).trim();
      if (body) segs.push({ kind: 'emote', text: body });
      i = j;
      continue;
    }

    if (ch === '（' || ch === '(') {
      flush();
      const close = ch === '（' ? '）' : ')';
      const end = raw.indexOf(close, i + 1);
      const stop = end === -1 ? raw.length : end;
      const body = raw.slice(i + 1, stop).trim();
      if (body) segs.push({ kind: 'ooc', text: body });
      i = stop + 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  flush();

  if (!segs.length) {
    const t = raw.trim();
    if (t) segs.push({ kind: defaultKind, text: t });
  }

  return segs.slice(0, 30);
}

/**
 * 消息类型：
 *   auto            —— 自动：按 `*动作` / `#动作` / `（皮下）` 标记拆分（默认）
 *   ic/emote/ooc    —— 显式指定：整条按这个类型发，标记原样保留、不拆分
 */
const MESSAGE_KINDS = ['auto', 'ic', 'emote', 'ooc'];

function normalizeKind(kind) {
  const k = String(kind || '').trim();
  return MESSAGE_KINDS.includes(k) ? k : 'auto';
}

function buildSegments(text, kind) {
  const raw = String(text == null ? '' : text);
  if (kind === 'auto') return parseSegments(raw, 'ic');

  // 显式类型：不识别标记，一个字符都不改
  const one = raw.trim();
  return one ? [{ kind, text: one }] : [];
}

/* ---- 行内骰 {1d20+3}（模仿 boluo 的行内表达式） ---- */

/** 只扫描不结算，用于输入预览 */
function scanInline(text) {
  const raw = String(text || '');
  const out = [];
  const re = /\{([^{}]{1,40})\}/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const expr = m[1].trim();
    let valid = true;
    try { parseDice(expr); } catch { valid = false; }
    out.push({ start: m.index, len: m[0].length, expr, valid });
  }
  return out;
}

/** 发送时结算，结果写进 meta.inline */
function rollInline(text) {
  return scanInline(text)
    .filter((x) => x.valid)
    .map((x) => {
      const rolled = rollExpression(x.expr, 'normal');
      return {
        start: x.start,
        len: x.len,
        expr: rolled.parsed.text,
        total: rolled.total,
        rolls: rolled.rolls[0],
        detail: rolled.detail,
      };
    });
}

const KIND_LABEL = {
  ic: '游戏内',
  emote: '动作',
  ooc: '场外',
  roll: '掷骰',
  system: '系统',
  combat: '战斗',
};

function exportLabel(msg) {
  const kind = msg.kind || 'ic';
  if (kind === 'ic') return msg.role === 'dm' ? '叙述' : '游戏内';
  return KIND_LABEL[kind] || '游戏内';
}

/**
 * 若请求带了 characterId，且该角色确实属于这个账号（或请求者是主持人），
 * 就以角色卡为准 —— 作者名与头像由服务端决定，客户端改不了。
 */
async function resolveSpeaker(body) {
  const cid = String(body.characterId || '').trim();
  if (!cid) return null;

  const sender = String(body.sender || '');
  const list = await store.listCharacters();
  const char = list.find((c) => c.id === cid);
  if (!char) return null;

  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  if (char.ownerClientId !== sender && sender !== dmId) return null;
  /* NPC 卡只有主持人能用 */
  if (char.isNpc && sender !== dmId) return null;

  return char;
}

async function appendMessage(payload) {
  const room = await store.loadState();
  const channel = payload.channel || 'main';

  const all = await store.listMessages(0);
  const inChannel = all.filter((m) => messageChannel(m) === channel);
  const maxPos = inChannel.reduce((acc, m) => Math.max(acc, m.pos == null ? m.seq : m.pos), 0);

  const dmId = room.dm ? room.dm.clientId : null;

  let visibility = payload.visibility || 'all';
  let audience = Array.isArray(payload.audience) ? payload.audience.map(String) : [];

  if (visibility === 'dm') {
    audience = dmId ? [dmId] : [];
  } else if (visibility === 'direct') {
    // 任何人都可以定向，只是被选中的人（和主持人）能看到
    audience = audience.filter((id) => id && id !== payload.sender);
    if (!audience.length) {
      visibility = 'dm';
      audience = dmId ? [dmId] : [];
    }
  } else {
    visibility = 'all';
    audience = [];
  }

  const row = {
    kind: payload.kind || 'ic',
    author: String(payload.author || '—').slice(0, 40),
    role: payload.role || 'player',
    text: String(payload.text || '').slice(0, 6000),
    meta: payload.meta || {},
    sender: String(payload.sender || ''),
    visibility,
    audience,
    channel,
    pos: maxPos + 1,
    created_at: nowISO(),
  };

  return store.insertMessage(row);
}

async function systemMessage(text, channel) {
  return appendMessage({
    kind: 'system',
    author: '系统',
    role: 'system',
    text,
    visibility: 'all',
    audience: [],
    sender: '',
    channel: channel || 'main',
  });
}

/* ------------------------------ 角色卡 ------------------------------ */

async function createCharacter(body) {
  const me = String(body.clientId || body.ownerClientId || '');
  /* 只有主持人可以把卡标记成 NPC */
  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  const char = normalizeCharacter(
    Object.assign({}, body, {
      owner: displayId(me),
      ownerClientId: me,
      isNpc: Boolean(body.isNpc && dmId && me === dmId),
    }),
  );
  /* 怪啖规则：建卡时把 BUFF 的 HP 加成计入上限（基础 8 + BUFF 加成） */
  if (char.buff) {
    const baseMax = clampInt(body.maxHp === undefined || body.maxHp === null || body.maxHp === '' ? 8 : Number(body.maxHp), 1, 9999, 8);
    char.maxHp = clampInt(baseMax + buffHpBonus(char.buff), 1, 9999, 8);
    char.hp = char.maxHp;
  }
  const row = Object.assign({}, char, {
    id: uid('c-'),
    created_at: nowISO(),
  });
  const saved = await store.insertCharacter(row);
  await systemMessage(`新建角色卡《${saved.name}》· ${displayId(me)}`);
  return saved;
}

async function updateCharacter(body) {
  const me = String(body.clientId || '');
  const id = String(body.id || '');
  if (!id) throw httpError(400, '缺少角色 id');

  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  const list = await store.listCharacters();
  const existing = list.find((c) => c.id === id);
  if (!existing) throw httpError(404, '角色卡不存在');
  if (!canEditCharacter(existing, me, dmId)) throw httpError(403, '无权修改这张角色卡');

  // 先合并再归一化，避免「只传 hp 把别的字段清零」
  const merged = normalizeCharacter(body, existing);
  /* BUFF 变化：先扣旧 HP 加成，再加新加成，避免反复切换叠加 */
  if (String(merged.buff || '') !== String(existing.buff || '')) {
    const oldBonus = buffHpBonus(existing.buff);
    const newBonus = buffHpBonus(merged.buff);
    const baseMax = Math.max(1, (Number(existing.maxHp) || 1) - oldBonus);
    merged.maxHp = clampInt(baseMax + newBonus, 1, 9999, 1);
    /* 当前 HP 同步保持「离上限的差值」，不因换 BUFF 变成满血或裸奔 */
    const gap = Math.max(0, (Number(existing.maxHp) || 1) - (Number(existing.hp) || 0));
    merged.hp = clampInt(merged.maxHp - gap, -99, merged.maxHp, merged.maxHp);
    /* 换 BUFF 时逆转机会重置：赌徒有 1 次，其他卡没有 */
    merged.reverseUsed = false;
  }
  /* NPC 标记只有主持人能改 */
  if (!(dmId && me === dmId)) merged.isNpc = Boolean(existing.isNpc);
  const updated = await store.patchCharacter(id, merged);
  return updated;
}

async function deleteCharacter(body) {
  const me = String(body.clientId || '');
  const id = String(body.id || '');
  if (!id) throw httpError(400, '缺少角色 id');

  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  const list = await store.listCharacters();
  const existing = list.find((c) => c.id === id);
  if (!existing) throw httpError(404, '角色卡不存在');
  if (!canEditCharacter(existing, me, dmId)) throw httpError(403, '无权删除这张角色卡');

  await store.deleteCharacter(id);
  await systemMessage(`删除角色卡《${existing.name}》· ${displayId(me)}`);
  return { ok: true };
}

/* ------------------------------ 怪啖论坛角色卡同步 ------------------------------ */

/**
 * 从论坛 db.json 读出角色卡。
 * 字段对应：playerName = 玩家名（账号）、archive.realName = 角色名、avatar = 头像。
 * 网名 nickname 明确不用。空角色名 / 玩家名为 unknown 的测试号跳过。
 */
function readForumCards() {
  if (!fs.existsSync(FORUM_DB_PATH)) {
    throw httpError(500, `找不到论坛数据文件：${FORUM_DB_PATH}`);
  }
  const db = JSON.parse(fs.readFileSync(FORUM_DB_PATH, 'utf8'));
  const users = Array.isArray(db.users) ? db.users : [];
  const cards = [];
  let skipped = 0;

  for (const u of users) {
    /* playerName 为空或为 unknown 的账号统一归到 unknown 分组，
       不再丢掉——这类多见于官方号 / 匿名号 / 档案号 */
    const rawName = String(u.playerName || '').trim();
    const playerName = (!rawName || rawName.toLowerCase() === 'unknown') ? 'unknown' : rawName;
    /* 角色名缺失时用论坛昵称兜底，保证 unknown 组也能显示 */
    const charName = String((u.archive && u.archive.realName) || '').trim()
      || String(u.nickname || '').trim();
    if (!u.id || !charName) {
      skipped += 1;
      continue;
    }
    cards.push({
      forumId: String(u.id),
      playerName,
      charName,
      avatar: String(u.avatar || ''),
      faction: String(u.faction || ''),
    });
  }

  return { cards, skipped, users: users.length };
}

/* 论坛表情：直接读论坛 db.json（按 mtime 缓存），图片由 /emoji/<id>.<ext> 转发 */
let emojiCache = { stamp: -1, data: null };

function readForumEmojis() {
  if (!fs.existsSync(FORUM_DB_PATH)) return { groups: [], emojis: [] };
  try {
    const st = fs.statSync(FORUM_DB_PATH);
    if (emojiCache.data && emojiCache.stamp === st.mtimeMs) return emojiCache.data;
    const db = JSON.parse(fs.readFileSync(FORUM_DB_PATH, 'utf8'));
    const groups = (Array.isArray(db.emojiGroups) ? db.emojiGroups : [])
      .map((g) => ({ id: g.id, name: String(g.name || '') }));
    const emojis = (Array.isArray(db.emojis) ? db.emojis : []).map((e) => ({
      id: e.id,
      name: String(e.name || ''),
      groupId: e.groupId,
      ext: path.extname(String(e.file || '')).toLowerCase() || '.webp',
    }));
    const data = { groups, emojis };
    emojiCache = { stamp: st.mtimeMs, data };
    return data;
  } catch {
    return emojiCache.data || { groups: [], emojis: [] };
  }
}

/** 把论坛头像复制进本项目，返回可直接访问的 /avatars/xxx 路径 */
function copyForumAvatar(forumId, avatarUrl) {
  const rel = String(avatarUrl || '').split('?')[0];
  const file = rel.split('/').pop();
  if (!file) return '';

  const src = path.join(FORUM_AVATAR_DIR, file);
  if (!fs.existsSync(src)) return '';

  try {
    if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const ext = path.extname(file).toLowerCase() || '.webp';
    /* 用固定文件名（forumId.ext）：历史消息的 meta.avatar 里存的就是这个路径，
       改名会让旧消息的头像全部 404。缓存由 HTTP 头控制。 */
    const destName = forumId + ext;
    const dest = path.join(AVATAR_DIR, destName);

    let needCopy = true;
    try {
      const s = fs.statSync(src);
      const d = fs.statSync(dest);
      if (d.size === s.size && d.mtimeMs >= s.mtimeMs) needCopy = false;
    } catch { /* 目标不存在 -> 复制 */ }

    if (needCopy) {
      fs.copyFileSync(src, dest);
      /* 清掉之前「版本化命名」试验留下的 forumId-xxx 文件 */
      try {
        for (const f of fs.readdirSync(AVATAR_DIR)) {
          if (f.startsWith(forumId + '-')) fs.unlinkSync(path.join(AVATAR_DIR, f));
        }
      } catch { /* 清理失败不影响使用 */ }
    }
    return '/avatars/' + destName;
  } catch {
    return '';
  }
}

/**
 * 幂等同步：id 固定为 gd-<论坛用户id>，重复执行不会产生重复卡。
 * 已存在的卡只刷新「角色名 / 玩家名 / 头像」，绝不覆盖本地填的 DND 数值、备注、状态。
 */
async function syncForumCharacters() {
  const { cards, skipped, users } = readForumCards();
  const existing = await store.listCharacters();
  const byId = new Map(existing.map((c) => [c.id, c]));

  let created = 0;
  let refreshed = 0;
  let unchanged = 0;

  for (const card of cards) {
    const id = 'gd-' + card.forumId;
    const avatar = copyForumAvatar(card.forumId, card.avatar);
    const prev = byId.get(id);

    if (!prev) {
      const char = normalizeCharacter({
        name: card.charName,
        owner: card.playerName,
        ownerClientId: card.playerName,
        avatar,
        maxHp: 8,
        hp: 8,
        notes: '',
      });
      await store.insertCharacter(Object.assign({}, char, { id, created_at: nowISO() }));
      created += 1;
      continue;
    }

    const merged = normalizeCharacter({
      name: card.charName,
      owner: card.playerName,
      ownerClientId: card.playerName,
      avatar: avatar || prev.avatar || '',
    }, prev);

    if (merged.name !== prev.name || merged.owner !== prev.owner || merged.avatar !== prev.avatar) {
      await store.patchCharacter(id, merged);
      refreshed += 1;
    } else {
      unchanged += 1;
    }
  }

  return { users, cards: cards.length, skipped, created, refreshed, unchanged };
}

/* ------------------------------ 折叠 / 正在输入 ------------------------------ */

const TYPING_TTL = 6000;
const typingMap = new Map(); // channel|sender -> { sender, channel, author, avatar, at }

function reapTyping() {
  const now = Date.now();
  for (const [k, v] of typingMap) if (now - v.at > TYPING_TTL) typingMap.delete(k);
}

function listTyping(me) {
  reapTyping();
  return [...typingMap.values()]
    .filter((t) => t.sender !== me)
    .map((t) => ({ sender: t.sender, channel: t.channel, author: t.author, avatar: t.avatar }));
}

async function foldMessage(body) {
  const seq = Number(body.seq);
  const sender = String(body.sender || '');
  if (!Number.isFinite(seq)) throw httpError(400, '缺少 seq');

  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  if (!dmId || sender !== dmId) throw httpError(403, '只有主持人可以折叠消息');

  const all = await store.listMessages(0);
  const msg = all.find((m) => Number(m.seq) === seq);
  if (!msg) throw httpError(404, '消息不存在');

  const meta = Object.assign({}, msg.meta || {});
  if (meta.folded) delete meta.folded;
  else meta.folded = true;

  await store.patchMessage(seq, { meta });
  return { ok: true, folded: Boolean(meta.folded) };
}

/* ------------------------------ GM 笔记（只主持人可读） ------------------------------ */

async function setGmNotes(body) {
  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  if (!dmId || String(body.clientId || '') !== dmId) throw httpError(403, '只有主持人能写 GM 笔记');
  room.gmNotes = String(body.text || '').slice(0, 6000);
  await store.saveState(room);
  return { gmNotes: room.gmNotes };
}

/* ------------------------------ 房间公告 ------------------------------ */

async function setAnnouncement(body) {
  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  const sender = String(body.clientId || '');
  if (!dmId || sender !== dmId) throw httpError(403, '只有主持人能改公告');

  const text = String(body.text || '').trim().slice(0, 600);
  room.announcement = text ? { text, by: displayId(sender), at: nowISO() } : null;
  await store.saveState(room);
  if (text) await systemMessage('主持人更新了房间公告');
  return { announcement: room.announcement };
}

/* ------------------------------ 自由掷骰 ------------------------------ */

async function doDamage(body) {
  const mode = body.mode === 'adv' || body.mode === 'dis' ? body.mode : 'normal';
  const rolled = rollExpression(body.expr, mode);

  /* 可选 DC：填了就顺便判个成功/失败 */
  const dc = (body.dc == null || body.dc === '') ? null : clampInt(body.dc, 1, 60, 15);
  const success = dc == null ? null : rolled.total >= dc;
  const speaker = await resolveSpeaker(body);
  /* 主持人掷的骰子也要带主持人标记，前端才会显示主持人样式 */
  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';
  const byDm = Boolean(dmId && String(body.sender || '') === dmId);

  const msg = await appendMessage({
    kind: 'roll',
    author: speaker ? speaker.name : String(body.author || '—'),
    role: speaker ? 'pc' : (body.role || 'player'),
    text: `${rolled.parsed.text} = ${rolled.total}${rolled.mode !== 'normal' ? `（${rolled.mode === 'adv' ? '优势' : '劣势'}）` : ''}${dc != null ? ` · DC ${dc} · ${success ? '成功' : '失败'}` : ''}`,
    sender: String(body.sender || ''),
    channel: body.channel || 'main',
    visibility: body.visibility || 'all',
    audience: body.audience || [],
    meta: {
      type: 'dice',
      gm: byDm,
      dark: Boolean(body.dark && byDm),
      characterId: speaker ? speaker.id : '',
      avatar: speaker ? (speaker.avatar || '') : '',
      expr: rolled.parsed.text,
      flat: rolled.parsed.flat || 0,
      mode: rolled.mode,
      rolls: rolled.rolls,
      totals: rolled.totals,
      total: rolled.total,
      detail: rolled.detail,
      dc,
      success,
    },
  });

  return { message: msg, result: rolled };
}

/* ------------------------------ 战斗 ------------------------------ */

/* ------------------------------ 剧情杀 · SAN ------------------------------ */

/** 给在场 PC 初始化 SAN（开战或开启剧情杀时调用） */
function initSan(room) {
  const cb = room && room.combat;
  if (!cb || !cb.plotKill || !Array.isArray(cb.order)) return;
  for (const o of cb.order) {
    if (o.kind !== 'pc') continue;
    if (o.san === undefined || o.san === null) o.san = 3;
    o.hypnotized = Number(o.san) <= 0;
  }
}

/** 一轮结束：所有在场 PC 各 -1 SAN；归零即被催眠。不写公开消息，玩家察觉不到机制本身 */
function sanRoundTick(room) {
  const cb = room && room.combat;
  if (!cb || !cb.plotKill || !Array.isArray(cb.order)) return;
  for (const o of cb.order) {
    if (o.kind !== 'pc' || o.hypnotized) continue;
    if (o.san === undefined || o.san === null) o.san = 3;
    o.san = Math.max(0, Number(o.san) - 1);
    if (o.san === 0) o.hypnotized = true;
  }
}

/** 受击一次：目标 PC -1 SAN；已催眠的不重复扣 */
function sanHitTick(room, entry) {
  const cb = room && room.combat;
  if (!cb || !cb.plotKill || !entry || entry.kind !== 'pc' || entry.hypnotized) return;
  if (entry.san === undefined || entry.san === null) entry.san = 3;
  entry.san = Math.max(0, Number(entry.san) - 1);
  if (entry.san === 0) entry.hypnotized = true;
}

/** 把战斗顺序里 PC 的 SAN 同步回角色卡（SAN 是常驻数值） */
async function syncSanToCharacters(room) {
  const cb = room && room.combat;
  if (!cb || !cb.plotKill || !Array.isArray(cb.order)) return;
  const list = await store.listCharacters();
  for (const o of cb.order) {
    if (o.kind !== 'pc' || !o.refId || o.san === undefined || o.san === null) continue;
    const c = list.find((x) => x.id === o.refId);
    if (c && Number(c.san) !== Number(o.san)) {
      await store.patchCharacter(c.id, normalizeCharacter({ san: o.san }, c));
    }
  }
}

/** 某张角色卡是否已被催眠（被催眠者不能进行战斗行动） */
function isHypnotized(room, refId) {
  const cb = room && room.combat;
  if (!cb || !cb.plotKill || !Array.isArray(cb.order) || !refId) return false;
  return cb.order.some((o) => o.kind === 'pc' && o.refId === String(refId) && o.hypnotized);
}

/** 主持人开关剧情杀：开启时初始化 SAN，关闭时清除催眠状态 */
async function combatPlotKill(body) {
  const room = await requireDmForCombat(body);
  const enabled = Boolean(body.enabled);
  room.combat.plotKill = enabled;
  if (enabled) {
    initSan(room);
  } else if (Array.isArray(room.combat.order)) {
    for (const o of room.combat.order) {
      if (o.kind !== 'pc') continue;
      o.hypnotized = false;
      o.san = undefined;
    }
  }
  await store.saveState(room);
  return { plotKill: enabled };
}

/* ------------------------- 检定已移除 -------------------------
 * 掷骰只有自由掷骰（/api/damage），默认 1d6。检定 / DC 判定 / 赌徒逆转一并下线。
 */

/** 技能救：其他玩家对濒死者做一次无加成 DC=5 判定（掷 1d6>=5 成功，救回 1 HP） */
async function rescueCharacter(body) {
  const targetId = String(body.targetId || '');
  const me = String(body.clientId || '');
  const rescuerName = String(body.rescuerName || me || '某人').slice(0, 24);
  const channel = body.channel || 'main';
  const room = await store.loadState();

  const list = await store.listCharacters();
  const target = list.find((c) => c.id === targetId);
  if (!target) throw httpError(404, '目标角色卡不存在');
  const ds = target.deathSaves || {};
  if (ds.dead) throw httpError(403, '这个角色已经死亡，救不回来');
  if (Number(target.hp) > 0) throw httpError(403, '这个角色还没有濒死');
  if (ds.stable) throw httpError(403, '这个角色已经稳定了，不需要再救');

  const roll = d6();
  const success = roll >= 5;
  if (success) {
    await store.patchCharacter(target.id, normalizeCharacter({
      hp: 1,
      deathSaves: { s: 0, f: 0, dead: false, stable: false },
    }, target));
    /* 战斗顺序里的 HP 也同步 */
    if (Array.isArray(room.combat.order)) {
      const entry = room.combat.order.find((o) => o.refId === target.id);
      if (entry) { entry.hp = 1; await store.saveState(room); }
    }
  }

  const text = `${rescuerName} 对 ${target.name} 施救 · 1d6 (${roll}) vs DC 5 · ${success ? '成功，救回 1 点 HP' : '失败'}`;
  await appendMessage({
    kind: 'roll',
    author: rescuerName,
    text,
    sender: me,
    channel,
    visibility: 'all',
    audience: [],
    meta: {
      type: 'rescue',
      targetId: target.id,
      targetName: target.name,
      rescuerName,
      roll,
      dc: 5,
      success,
    },
  });

  return { roll, success, targetName: target.name };
}

/** 战斗操作只有主持人能做（开战、推进、结束） */
async function requireDmForCombat(body) {
  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';
  if (!dmId) throw httpError(403, '还没有主持人，先认领主持人');
  if (String(body.clientId || '') !== dmId) throw httpError(403, '只有主持人可以操作战斗');
  return room;
}

/** 攻击点数→伤害：6 大成功 2 点，5 扣 1 点，1-4 不造成伤害 */
function attackDamage(roll) {
  if (roll === 6) return 2;
  if (roll > 4) return 1;
  return 0;
}

/** 攻击：掷 1d6 判定点数，6 点 2 伤、5 点 1 伤、4 及以下无伤（无武器 / 无 AC） */
async function rollAttack(body) {
  const cid = String(body.characterId || '');
  const me = String(body.clientId || '');

  const list = await store.listCharacters();
  const c = list.find((x) => x.id === cid);
  if (!c) throw httpError(404, '角色卡不存在');

  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';
  if (!canEditCharacter(c, me, dmId)) throw httpError(403, '无权用这张卡攻击');
  if (isHypnotized(room, cid)) throw httpError(403, '角色已被催眠，无法行动');

  const dmgRoll = d6();
  const dmg = attackDamage(dmgRoll);
  const targetId = String(body.targetId || '');
  let target = null;
  let hpAfter = null;

  if (targetId) {
    const idx = (room.combat.order || []).findIndex((o) => o.id === targetId);
    if (idx >= 0) {
      target = room.combat.order[idx];
      if (dmg > 0) {
        target.hp = Math.max(-99, (Number(target.hp) || 0) - dmg);
        sanHitTick(room, target);
        /* PC 掉血 / 掉 SAN 同步写回角色卡 */
        if (target.kind === 'pc' && target.refId) {
          const chars = await store.listCharacters();
          const tc = chars.find((x) => x.id === target.refId);
          if (tc) await store.patchCharacter(tc.id, normalizeCharacter({ hp: target.hp, san: target.san }, tc));
        }
        await store.saveState(room);
      }
      hpAfter = target.hp;
    }
  }

  const verdict = dmgRoll === 6 ? '大成功' : dmg > 0 ? '命中' : '未命中';
  const text = `${c.name} 攻击掷 1d6 (${dmgRoll}) · ${verdict} · 造成 ${dmg} 点伤害`
    + (target ? ` → ${target.name}（HP ${hpAfter}/${target.maxHp}）` : '');

  await appendMessage({
    kind: 'roll',
    author: c.name,
    text,
    sender: me,
    channel: body.channel || 'main',
    visibility: body.visibility || 'all',
    audience: Array.isArray(body.audience) ? body.audience : [],
    meta: {
      type: 'attack',
      characterId: c.id,
      avatar: c.avatar || '',
      roll: dmgRoll,
      dmg,
      verdict,
      targetName: target ? target.name : '',
      hpAfter,
      gm: Boolean(dmId && me === dmId),
    },
  });

  return { roll: dmgRoll, dmg, verdict, targetName: target ? target.name : '', hpAfter };
}

/** 死亡豁免：HP 归零后每回合掷 1d6，3 成功稳定、3 失败死亡、自然 6 回 1 血 */
async function deathSaveRoll(body) {
  const id = String(body.id || '');
  const me = String(body.clientId || '');
  const list = await store.listCharacters();
  const c = list.find((x) => x.id === id);
  if (!c) throw httpError(404, '角色卡不存在');

  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';
  if (!canEditCharacter(c, me, dmId)) throw httpError(403, '无权操作这张卡');

  if (Number(c.hp) > 0) throw httpError(400, 'HP 还没归零，不需要死亡豁免');
  const ds = Object.assign({ s: 0, f: 0, dead: false, stable: false }, c.deathSaves || {});
  if (ds.dead) throw httpError(400, '这张卡已经死亡');
  if (ds.stable) throw httpError(400, '已经稳定了，不需要再掷');

  /* 1d6：6 回 1 血醒来 / 4-5 成功 / 2-3 失败 / 1 记 2 失败；3 成功稳定、3 失败死亡 */
  const roll = d6();
  let s = ds.s;
  let f = ds.f;
  let note = '';
  let revived = false;

  if (roll === 6) {
    revived = true;
    s = 0;
    f = 0;
    note = '自然 6 · 恢复 1 点 HP，醒来';
    await store.patchCharacter(c.id, { hp: 1, deathSaves: { s: 0, f: 0, dead: false, stable: false } });
  } else if (roll === 1) {
    f += 2;
    note = '自然 1 · 记 2 次失败';
  } else if (roll >= 4) {
    s += 1;
    note = '成功';
  } else {
    f += 1;
    note = '失败';
  }

  let dead = false;
  let stable = false;
  if (!revived) {
    if (f >= 3) { f = 3; dead = true; note += ' · 死亡'; }
    else if (s >= 3) { s = 3; stable = true; note += ' · 稳定'; }
    await store.patchCharacter(c.id, { deathSaves: { s, f, dead, stable } });
  }

  await appendMessage({
    kind: 'roll',
    author: c.name,
    text: `${c.name} 死亡豁免 1d6 (${roll}) · ${note} · 成功 ${s}/3 失败 ${f}/3`,
    sender: me,
    channel: body.channel || 'main',
    visibility: 'all',
    meta: {
      type: 'death',
      characterId: c.id,
      avatar: c.avatar || '',
      roll,
      note,
      s,
      f,
      dead,
      stable,
      revived,
      gm: Boolean(dmId && me === dmId),
    },
  });

  return { roll, s, f, dead, stable, revived };
}

/** 长休 / 短休：主持人一键安排全队 */
async function partyRest(body) {
  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';
  if (!dmId) throw httpError(403, '还没有主持人，先认领主持人');
  if (String(body.clientId || '') !== dmId) throw httpError(403, '只有主持人可以安排休息');

  const type = body.type === 'short' ? 'short' : 'long';
  const list = await store.listCharacters();
  const pcs = list.filter((c) => !c.isNpc);

  const rows = [];
  for (const c of pcs) {
    const before = Number(c.hp) || 0;
    const maxHp = Math.max(1, Number(c.maxHp) || 1);
    let after = before;
    let detail = null;

    if (type === 'long') {
      after = maxHp;
    } else {
      /* 短休救不了濒死的人（HP 已经为 0 的跳过，留待长休或治疗） */
      if (before <= 0) {
        rows.push({ name: c.name, from: before, to: before, healed: 0, detail: null, skipped: true });
        continue;
      }
      /* 短休：纯 1d6，至少回 1 点 */
      const die = d6();
      const gain = Math.max(1, die);
      after = Math.min(maxHp, before + gain);
      detail = { die, gain };
    }

    const healed = after - before;
    const upd = {};
    if (healed !== 0) upd.hp = after;

    /* 恢复意识后死亡豁免计数清零 */
    const ds = c.deathSaves || {};
    if (after > 0 && (ds.s || ds.f || ds.stable)) {
      upd.deathSaves = { s: 0, f: 0, dead: false, stable: false };
    }
    if (Object.keys(upd).length) await store.patchCharacter(c.id, upd);
    rows.push({ name: c.name, from: before, to: after, healed, detail });
  }

  const woke = rows.filter((r) => r.from <= 0 && r.to > 0).map((r) => r.name);
  const text = type === 'long'
    ? `长休 · 全队 HP 已回满${woke.length ? ` · ${woke.join('、')} 恢复了意识` : ''}`
    : `短休 · ${rows.filter((r) => r.healed > 0).map((r) => `${r.name} +${r.healed}`).join('，') || '没有人需要恢复'}`;

  await appendMessage({
    kind: 'system',
    author: '主持人',
    text,
    sender: String(body.clientId || ''),
    channel: body.channel || 'main',
    visibility: 'all',
  });

  return { type, rows };
}

async function combatStart(body) {
  await requireDmForCombat(body);
  const room = await store.loadState();
  const characters = await store.listCharacters();
  const order = [];

  /* 只让勾选的参战者入场；不传则退回「全部角色卡」的老行为 */
  const pick = Array.isArray(body.participants) && body.participants.length
    ? new Set(body.participants.map(String))
    : null;

  for (const c of characters) {
    if (pick && !pick.has(c.id)) continue;
    order.push({
      id: uid('e-'),
      refId: c.id,
      name: c.name,
      kind: 'pc',
      init: d6(),
      hp: c.hp,
      maxHp: c.maxHp,
      san: c.san === undefined || c.san === null ? 3 : clampInt(c.san, 0, 99, 3),
      ownerClientId: c.ownerClientId || '',
    });
  }

  const monsters = Array.isArray(body.monsters) ? body.monsters : [];
  for (const m of monsters) {
    const name = String((m && m.name) || '').trim();
    if (!name) continue;
    const maxHp = clampInt(m.hp, 1, 9999, 2);
    /* 攻击骰：普通信徒 0（不攻击）、狂热信徒 1d6、伪梦神 4d6，允许主持人手填 */
    const attack = String((m && m.attack) || '').trim().slice(0, 20);
    order.push({
      id: uid('e-'),
      refId: null,
      name: name.slice(0, 40),
      kind: 'monster',
      init: m.init === undefined || m.init === null || m.init === '' ? d6() : clampInt(m.init, -99, 99, 0),
      hp: maxHp,
      maxHp,
      attack,
      ownerClientId: '',
    });
  }

  order.sort((a, b) => {
    if (b.init !== a.init) return b.init - a.init;
    if (a.kind !== b.kind) return a.kind === 'pc' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  room.combat = {
    active: true,
    round: 1,
    turn: 0,
    order,
    /* 没显式传就继承此前设置，避免「先开剧情杀再开战」时开关丢失 */
    plotKill: body.plotKill === undefined ? Boolean(room.combat.plotKill) : Boolean(body.plotKill),
  };
  initSan(room);
  await store.saveState(room);

  const seqText = room.combat.order.map((o) => `${o.name}(${o.init})`).join(' → ');
  await systemMessage(`战斗开始 · 先攻：${seqText || '无参战者'} · 轮到 ${room.combat.order[0] ? room.combat.order[0].name : '—'}`, body.channel);

  return room.combat;
}

async function combatNext(body) {
  const room = await requireDmForCombat(body);
  const combat = room.combat;
  if (!combat.active || !combat.order.length) throw httpError(400, '当前没有进行中的战斗');

  let turn = combat.turn + 1;
  let round = combat.round;
  if (turn >= combat.order.length) {
    turn = 0;
    round += 1;
    sanRoundTick(room);
    await syncSanToCharacters(room);
  }
  combat.turn = turn;
  combat.round = round;
  await store.saveState(room);

  const cur = combat.order[turn];
  await systemMessage(`第 ${round} 轮 · 轮到 ${cur ? cur.name : '—'}`, body.channel);
  return combat;
}

/** 本轮拼点：全体参战 PC 各掷一次对抗系统方，一次性出结果 */
async function combatContest(body) {
  const room = await requireDmForCombat(body);
  const combat = room.combat;
  if (!combat.active || !combat.order.length) throw httpError(400, '没有进行中的战斗');

  const sysMod = clampInt(body.sysMod, -5, 5, 0);
  const label = String(body.label || '').trim().slice(0, 24) || '拼点';

  /* 主持人勾了本轮行动者就只对这些人生效，不传则全体 PC */
  const turnIds = Array.isArray(body.orderIds) && body.orderIds.length
    ? new Set(body.orderIds.map(String))
    : null;
  const pcs = combat.order.filter((o) => o.kind === 'pc' && (!turnIds || turnIds.has(o.id)));
  if (!pcs.length) throw httpError(400, '本轮还没有可行动的角色');

  const rows = pcs.map((o) => {
    const mine = d6();
    const sys = d6();
    return {
      name: o.name,
      refId: o.refId || '',
      roll: mine,
      total: mine,
      sysRoll: sys,
      sysTotal: sys + sysMod,
      win: mine > sys + sysMod,
      tie: mine === sys + sysMod,
    };
  });

  const wins = rows.filter((r) => r.win).length;
  const loses = rows.filter((r) => !r.win && !r.tie).length;
  const ties = rows.filter((r) => r.tie).length;

  await appendMessage({
    kind: 'roll',
    author: '主持人',
    role: 'gm',
    text: `${label}对抗 · 玩家 ${wins} 胜 ${loses} 负${ties ? ` ${ties} 平` : ''}`,
    sender: String(body.clientId || ''),
    channel: body.channel || 'main',
    visibility: 'all',
    meta: {
      type: 'contest',
      label,
      sysMod,
      rows,
      gm: true,
    },
  });

  return { rows };
}

/** 拼点邀请：主持人发一张邀请卡，玩家自己点参与、自己掷 */
async function contestInvite(body) {
  const room = await requireDmForCombat(body);
  const combat = room.combat;
  if (!combat.active || !combat.order.length) throw httpError(400, '没有进行中的战斗');

  const sysMod = clampInt(body.sysMod, -5, 5, 0);
  const label = String(body.label || '').trim().slice(0, 24) || '拼点';

  const turnIds = Array.isArray(body.orderIds) && body.orderIds.length
    ? new Set(body.orderIds.map(String))
    : null;
  const pcs = combat.order.filter((o) => o.kind === 'pc' && (!turnIds || turnIds.has(o.id)));
  if (!pcs.length) throw httpError(400, '没有可邀请的角色');

  const characters = await store.listCharacters();
  const targets = pcs.map((o) => {
    const c = characters.find((x) => x.id === o.refId);
    return {
      orderId: o.id,
      refId: o.refId || '',
      name: o.name,
      owner: c ? String(c.ownerClientId || '') : '',
    };
  });

  await appendMessage({
    kind: 'roll',
    author: '主持人',
    text: `${label}拼点 · 等待 ${targets.length} 人参加`,
    sender: String(body.clientId || ''),
    channel: body.channel || 'main',
    visibility: 'all',
    meta: {
      type: 'contest_invite',
      label,
      sysMod,
      targets,
      gm: true,
    },
  });

  return { targets };
}

/** 玩家点「参加拼点」：自己掷一次，独立出一条结果 */
async function contestJoin(body) {
  const seq = Number(body.seq);
  const me = String(body.clientId || '');
  if (!seq || !me) throw httpError(400, '参数不全');

  const all = await store.listMessages(0);
  const inv = all.find((m) => Number(m.seq) === seq);
  if (!inv || !inv.meta || inv.meta.type !== 'contest_invite') throw httpError(404, '这个拼点邀请不存在');
  const meta = inv.meta;

  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';

  const entries = all.filter((m) => m.meta
    && m.meta.type === 'contest_entry'
    && Number(m.meta.inviteSeq) === seq);
  const doneRefs = new Set(entries.map((m) => String(m.meta.characterId || '')));

  /* 按角色卡判重：一个人有两张卡就可以各掷一次，主持人可以代掷 */
  const isDmActing = Boolean(dmId && me === dmId);

  const targets = Array.isArray(meta.targets) ? meta.targets : [];
  let target = targets.find((t) => t.owner === me && !doneRefs.has(t.refId));
  /* 主持人可以代替还没掷的人投 */
  if (!target && dmId && me === dmId) target = targets.find((t) => !doneRefs.has(t.refId));
  if (!target) throw httpError(403, '你不在这次邀请名单里，或者已经掷过了');
  if (isHypnotized(room, target.refId)) throw httpError(403, '角色已被催眠，无法行动');

  /* 1d6 vs 系统 1d6 + 修正 */
  const mine = d6();
  const sysRoll = d6();
  const sysTotal = sysRoll + (Number(meta.sysMod) || 0);
  const win = mine > sysTotal;
  const tie = mine === sysTotal;
  const verdict = win ? '胜' : tie ? '平' : '负';

  await appendMessage({
    kind: 'roll',
    author: target.name,
    text: `${target.name} 拼点 ${mine} vs ${sysTotal} · ${verdict}`,
    sender: me,
    channel: messageChannel(inv),
    visibility: 'all',
    meta: {
      type: 'contest_entry',
      inviteSeq: seq,
      characterId: target.refId || '',
      name: target.name,
      roll: mine,
      total: mine,
      sysRoll,
      sysMod: Number(meta.sysMod) || 0,
      sysTotal,
      win,
      tie,
      label: meta.label || '拼点',
    },
  });

  return {
    name: target.name, roll: mine, total: mine,
    sysRoll, sysTotal, win, tie,
  };
}

/* 石头剪刀布 */
const RPS_HANDS = ['rock', 'paper', 'scissors'];
const RPS_CN = { rock: '石头', paper: '布', scissors: '剪刀' };
const RPS_BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

/** 主持人发起猜拳 */
async function rpsInvite(body) {
  const room = await requireDmForCombat(body);
  const combat = room.combat;
  if (!combat.active || !combat.order.length) throw httpError(400, '没有进行中的战斗');

  const turnIds = Array.isArray(body.orderIds) && body.orderIds.length
    ? new Set(body.orderIds.map(String))
    : null;
  const pcs = combat.order.filter((o) => o.kind === 'pc' && (!turnIds || turnIds.has(o.id)));
  if (!pcs.length) throw httpError(400, '没有可邀请的角色');

  const characters = await store.listCharacters();
  const targets = pcs.map((o) => {
    const c = characters.find((x) => x.id === o.refId);
    return {
      orderId: o.id,
      refId: o.refId || '',
      name: o.name,
      owner: c ? String(c.ownerClientId || '') : '',
    };
  });

  await appendMessage({
    kind: 'roll',
    author: '主持人',
    text: `猜拳 · 等 ${targets.length} 人出拳`,
    sender: String(body.clientId || ''),
    channel: body.channel || 'main',
    visibility: 'all',
    meta: { type: 'rps_invite', targets, gm: true },
  });

  return { targets };
}

/** 玩家出拳：系统随机出，一次定胜负 */
async function rpsJoin(body) {
  const seq = Number(body.seq);
  const me = String(body.clientId || '');
  const hand = RPS_HANDS.includes(body.hand) ? body.hand : 'rock';
  if (!seq || !me) throw httpError(400, '参数不全');

  const all = await store.listMessages(0);
  const inv = all.find((m) => Number(m.seq) === seq);
  if (!inv || !inv.meta || inv.meta.type !== 'rps_invite') throw httpError(404, '这次猜拳邀请不存在');

  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';
  const isDmActing = Boolean(dmId && me === dmId);

  const entries = all.filter((m) => m.meta
    && m.meta.type === 'rps_result'
    && Number(m.meta.inviteSeq) === seq);
  const doneRefs = new Set(entries.map((m) => String(m.meta.characterId || '')));

  /* 按角色卡判重：每张卡各出一次拳 */

  const targets = Array.isArray(inv.meta.targets) ? inv.meta.targets : [];
  let target = targets.find((t) => t.owner === me && !doneRefs.has(t.refId));
  if (!target && isDmActing) target = targets.find((t) => !doneRefs.has(t.refId));
  if (!target) throw httpError(403, '你不在这次邀请名单里，或者已经出过拳了');
  if (isHypnotized(room, target.refId)) throw httpError(403, '角色已被催眠，无法行动');

  const sysHand = RPS_HANDS[crypto.randomInt(0, 3)];
  const win = RPS_BEATS[hand] === sysHand;
  const tie = hand === sysHand;

  await appendMessage({
    kind: 'roll',
    author: target.name,
    text: `${target.name} 出${RPS_CN[hand]} vs 系统出${RPS_CN[sysHand]} · ${win ? '胜' : tie ? '平' : '负'}`,
    sender: me,
    channel: messageChannel(inv),
    visibility: 'all',
    meta: {
      type: 'rps_result',
      inviteSeq: seq,
      characterId: target.refId || '',
      name: target.name,
      hand,
      sysHand,
      win,
      tie,
    },
  });

  return { hand, sysHand, win, tie };
}

/* ------------------------- 随机抽选报名 ------------------------- */

/** 主持人发起一次随机抽选报名；limit=0 表示主持人手动截止 */
async function lotteryOpen(body) {
  const room = await requireDmForCombat(body);
  const title = String(body.title || '随机抽选').slice(0, 40) || '随机抽选';
  const limit = clampInt(body.limit, 0, 99, 0);

  const characters = await store.listCharacters();
  const combat = room.combat;
  const turnIds = Array.isArray(body.orderIds) && body.orderIds.length
    ? new Set(body.orderIds.map(String))
    : null;

  /* 报名池：默认全部玩家角色卡；战斗中主持人可勾选本轮行动者来限定 */
  let pool;
  if (combat && combat.active && combat.order.length) {
    pool = combat.order
      .filter((o) => o.kind === 'pc' && (!turnIds || turnIds.has(o.id)))
      .map((o) => {
        const c = characters.find((x) => x.id === o.refId);
        return {
          refId: o.refId || '',
          name: o.name,
          owner: c ? String(c.ownerClientId || '') : '',
        };
      });
  } else {
    pool = characters
      .filter((c) => !c.isNpc)
      .map((c) => ({
        refId: String(c.id),
        name: String(c.name || ''),
        owner: String(c.ownerClientId || ''),
      }));
  }
  pool = pool.filter((t) => t.refId);
  if (!pool.length) throw httpError(400, '没有可报名的角色卡');

  await appendMessage({
    kind: 'roll',
    author: '主持人',
    text: `${title} · 开始报名（${limit > 0 ? `满 ${limit} 人自动开奖` : '主持人手动截止'}）`,
    sender: String(body.clientId || ''),
    channel: body.channel || 'main',
    visibility: 'all',
    meta: { type: 'lottery_open', title, limit, pool, gm: true },
  });

  return { title, limit, pool };
}

/** 玩家用自己的角色卡报名；满员自动截止并抽取 */
async function lotteryJoin(body) {
  const seq = Number(body.seq);
  const me = String(body.clientId || '');
  const cardId = String(body.cardId || body.characterId || '');
  if (!seq || !me || !cardId) throw httpError(400, '参数不全');

  const all = await store.listMessages(0);
  const inv = all.find((m) => Number(m.seq) === seq);
  if (!inv || !inv.meta || inv.meta.type !== 'lottery_open') throw httpError(404, '这次报名不存在');
  const meta = inv.meta;

  if (all.some((m) => m.meta && m.meta.type === 'lottery_result' && Number(m.meta.inviteSeq) === seq)) {
    throw httpError(403, '已经开奖了');
  }

  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';
  const isDmActing = Boolean(dmId && me === dmId);

  const pool = Array.isArray(meta.pool) ? meta.pool : [];
  const target = pool.find((t) => String(t.refId) === cardId);
  if (!target) throw httpError(403, '这张卡不在报名名单里');
  if (!isDmActing && target.owner !== me) throw httpError(403, '这不是你的角色卡');

  const entries = all.filter((m) => m.meta
    && m.meta.type === 'lottery_entry'
    && Number(m.meta.inviteSeq) === seq);
  const doneRefs = new Set(entries.map((m) => String(m.meta.characterId || '')));
  if (doneRefs.has(cardId)) throw httpError(403, '已经报名过了');
  if (isHypnotized(room, cardId)) throw httpError(403, '角色已被催眠，无法行动');

  const limit = Number(meta.limit) || 0;
  if (limit > 0 && doneRefs.size >= limit) throw httpError(403, '报名人数已满');

  await appendMessage({
    kind: 'roll',
    author: target.name,
    text: `${target.name} 报名了「${meta.title || '随机抽选'}」`,
    sender: me,
    channel: messageChannel(inv),
    visibility: 'all',
    meta: {
      type: 'lottery_entry',
      inviteSeq: seq,
      characterId: cardId,
      name: target.name,
      title: meta.title || '',
    },
  });

  const count = doneRefs.size + 1;
  let result = null;
  if (limit > 0 && count >= limit) result = await lotteryDraw(seq, messageChannel(inv));
  return { name: target.name, count, limit, result };
}

/** 主持人手动截止并随机抽一人 */
async function lotteryClose(body) {
  const seq = Number(body.seq);
  if (!seq) throw httpError(400, '参数不全');
  await requireDmForCombat(body);
  const all = await store.listMessages(0);
  const inv = all.find((m) => Number(m.seq) === seq);
  if (!inv || !inv.meta || inv.meta.type !== 'lottery_open') throw httpError(404, '这次报名不存在');
  if (all.some((m) => m.meta && m.meta.type === 'lottery_result' && Number(m.meta.inviteSeq) === seq)) {
    throw httpError(403, '已经开奖了');
  }
  return lotteryDraw(seq, messageChannel(inv));
}

/** 核心：从报名者里公平随机抽一个 */
async function lotteryDraw(seq, channel) {
  const all = await store.listMessages(0);
  const entries = all.filter((m) => m.meta
    && m.meta.type === 'lottery_entry'
    && Number(m.meta.inviteSeq) === seq);
  const seen = new Set();
  const uniq = [];
  for (const m of entries) {
    const id = String(m.meta.characterId || '');
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push({ characterId: id, name: String(m.meta.name || '') });
  }
  if (!uniq.length) throw httpError(400, '还没有人报名');

  const inv = all.find((m) => Number(m.seq) === seq);
  const title = inv && inv.meta ? String(inv.meta.title || '随机抽选') : '随机抽选';
  const winner = uniq[crypto.randomInt(0, uniq.length)];

  await appendMessage({
    kind: 'roll',
    author: '主持人',
    text: `「${title}」开奖 · ${uniq.length} 人报名，抽中 ${winner.name}！`,
    sender: '',
    channel,
    visibility: 'all',
    meta: {
      type: 'lottery_result',
      inviteSeq: seq,
      title,
      winner,
      total: uniq.length,
      gm: true,
    },
  });

  return { winner, total: uniq.length };
}

/** 进入下一轮：轮次 +1，清掉逐个推进的位置 */
async function combatNextRound(body) {
  const room = await requireDmForCombat(body);
  const combat = room.combat;
  if (!combat.active || !combat.order.length) throw httpError(400, '当前没有进行中的战斗');

  combat.round += 1;
  combat.turn = 0;
  sanRoundTick(room);
  await syncSanToCharacters(room);
  await store.saveState(room);
  await systemMessage(`第 ${combat.round} 轮开始`, body.channel);
  return combat;
}

async function combatEnd(body) {
  const room = await requireDmForCombat(body);
  if (!room.combat.active) throw httpError(400, '当前没有进行中的战斗');
  room.combat = defaultCombat();
  await store.saveState(room);
  await systemMessage('战斗结束', body.channel);
  return room.combat;
}

async function combatPatch(body) {
  const room = await store.loadState();
  const combat = room.combat;
  if (!combat.active) throw httpError(400, '当前没有进行中的战斗');

  let note = null;

  if (body.addMonster && body.addMonster.name) {
    const m = body.addMonster;
    const maxHp = clampInt(m.hp, 1, 9999, 10);
    combat.order.push({
      id: uid('e-'),
      refId: null,
      name: String(m.name).slice(0, 40),
      kind: 'monster',
      init: m.init === undefined || m.init === null || m.init === '' ? d6() : clampInt(m.init, -99, 99, 0),
      hp: maxHp,
      maxHp,
      ownerClientId: '',
    });
    combat.order.sort((a, b) => b.init - a.init);
    if (combat.turn >= combat.order.length) combat.turn = 0;
    note = `加入战斗：${m.name}（HP ${maxHp}，先攻 ${combat.order.find((o) => o.name === m.name)?.init ?? '?'}）`;
  } else {
    const targetId = String(body.targetId || '');
    const idx = combat.order.findIndex((o) => o.id === targetId || o.refId === targetId);
    if (idx < 0) throw httpError(404, '战斗中的目标不存在');
    const entry = combat.order[idx];

    if (body.remove) {
      combat.order.splice(idx, 1);
      if (!combat.order.length) {
        room.combat = defaultCombat();
      } else if (combat.turn > idx) {
        combat.turn -= 1;
      } else if (combat.turn >= combat.order.length) {
        combat.turn = 0;
        combat.round += 1;
      }
      note = `${entry.name} 退出战斗`;
    } else {
      let delta = 0;
      if (body.delta !== undefined && body.delta !== null && body.delta !== '') {
        delta = clampInt(body.delta, -999, 999, 0);
        entry.hp = Math.max(-99, Math.min(entry.maxHp, entry.hp + delta));
      } else if (body.hp !== undefined && body.hp !== null && body.hp !== '') {
        const next = clampInt(body.hp, -99, entry.maxHp, entry.hp);
        delta = next - entry.hp;
        entry.hp = next;
      }
      if (delta < 0) sanHitTick(room, entry);
      const sign = delta > 0 ? '+' : '';
      note = `${entry.name} ${delta >= 0 ? '回复' : '受到'} ${Math.abs(delta)} 点${delta >= 0 ? '' : '伤害'}（HP ${entry.hp}/${entry.maxHp}）${sign}`;

      // 同步到角色卡
      if (entry.kind === 'pc' && entry.refId) {
        const chars = await store.listCharacters();
        const c = chars.find((x) => x.id === entry.refId);
        if (c) {
          const merged = normalizeCharacter({ hp: entry.hp, san: entry.san }, c);
          await store.patchCharacter(c.id, merged);
        }
      }
    }
  }

  await store.saveState(room);
  if (note) await systemMessage(note, body.channel);
  return room.combat;
}

/* ------------------------------ 频道 ------------------------------ */

async function channelCreate(body) {
  const room = await store.loadState();
  if (room.channels.length >= 12) throw httpError(400, '频道数量已达上限（12）');
  const name = String(body.name || '').trim().slice(0, 20) || '新频道';
  const ch = { id: uid('ch-'), name };
  room.channels.push(ch);
  await store.saveState(room);
  await systemMessage(`新建频道〔${name}〕`, ch.id);
  return { channel: ch, channels: room.channels };
}

async function channelRename(body) {
  const room = await store.loadState();
  const id = String(body.id || '');
  const name = String(body.name || '').trim().slice(0, 20);
  if (!name) throw httpError(400, '频道名不能为空');
  const ch = room.channels.find((c) => c.id === id);
  if (!ch) throw httpError(404, '频道不存在');
  const old = ch.name;
  ch.name = name;
  await store.saveState(room);
  await systemMessage(`频道〔${old}〕改名为〔${name}〕`, id);
  return { channels: room.channels };
}

async function channelDelete(body) {
  const room = await store.loadState();
  const id = String(body.id || '');
  if (room.channels.length <= 1) throw httpError(400, '至少要保留一个频道');
  const idx = room.channels.findIndex((c) => c.id === id);
  if (idx < 0) throw httpError(404, '频道不存在');

  const [removed] = room.channels.splice(idx, 1);
  const fallback = room.channels[0].id;

  // 消息不销毁，迁移到第一个剩余频道，并重排 pos，避免合并后 pos 撞号
  const all = await store.listMessages(0);
  const moved = all.filter((m) => messageChannel(m) === id).sort(messageOrder);
  const target = all.filter((m) => messageChannel(m) === fallback).sort(messageOrder);
  const merged = target.concat(moved);

  await Promise.all(merged.map((m, i) => {
    const fields = { pos: i + 1 };
    if (messageChannel(m) === id) fields.channel = fallback;
    return store.patchMessage(m.seq, fields);
  }));

  await store.saveState(room);
  await systemMessage(`频道〔${removed.name}〕已删除，其中 ${moved.length} 条消息并入〔${room.channels[0].name}〕`, fallback);

  return { channels: room.channels, fallback };
}

/* ------------------------------ 消息重排 ------------------------------ */

async function messageMove(body) {
  const seq = Number(body.seq);
  const targetSeq = body.targetSeq === undefined || body.targetSeq === null || body.targetSeq === ''
    ? null
    : Number(body.targetSeq);
  const position = body.position === 'after' ? 'after' : 'before';

  if (!Number.isFinite(seq)) throw httpError(400, '缺少 seq');

  /* 只有主持人可以重排消息；作者本人也不行。前端还要求先开「调整模式」 */
  const room = await store.loadState();
  const dmId = room.dm ? String(room.dm.clientId || '') : '';
  const who = String(body.clientId || body.sender || '');
  if (!dmId) throw httpError(403, '当前没有主持人，无法调整消息顺序。');
  if (who !== dmId) throw httpError(403, '只有主持人可以调整消息顺序。');

  const all = await store.listMessages(0);
  const moving = all.find((m) => Number(m.seq) === seq);
  if (!moving) throw httpError(404, '消息不存在');

  const channel = messageChannel(moving);
  const inChannel = all.filter((m) => messageChannel(m) === channel).sort(messageOrder);
  const rest = inChannel.filter((m) => Number(m.seq) !== seq);

  let insertAt = rest.length;
  if (targetSeq !== null) {
    const t = rest.findIndex((m) => Number(m.seq) === targetSeq);
    if (t >= 0) insertAt = position === 'after' ? t + 1 : t;
  }

  rest.splice(insertAt, 0, moving);

  await Promise.all(rest.map((m, i) => store.patchMessage(m.seq, { pos: i + 1 })));

  return {
    channel,
    order: rest.map((m) => m.seq),
  };
}

/* ------------------------------ 编辑 / 删除消息 ------------------------------ */

async function editMessage(body) {
  const seq = Number(body.seq);
  const sender = String(body.sender || '');
  const text = String(body.text == null ? '' : body.text).trim();
  if (!Number.isFinite(seq)) throw httpError(400, '缺少 seq');
  if (!text) throw httpError(400, '内容不能为空');

  const all = await store.listMessages(0);
  const msg = all.find((m) => Number(m.seq) === seq);
  if (!msg) throw httpError(404, '消息不存在');

  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  if (msg.sender !== sender && sender !== dmId) throw httpError(403, '只能编辑自己发的消息');

  // 编辑只改正文，不再重新分段（否则一条会裂成多条）
  const meta = Object.assign({}, msg.meta || {}, { edited: true });
  const inline = rollInline(text);
  if (inline.length) meta.inline = inline;
  else delete meta.inline;

  await store.patchMessage(seq, { text: text.slice(0, 6000), meta });
  return { ok: true };
}

async function removeMessage(body) {
  const seq = Number(body.seq);
  const sender = String(body.sender || '');
  if (!Number.isFinite(seq)) throw httpError(400, '缺少 seq');

  const all = await store.listMessages(0);
  const msg = all.find((m) => Number(m.seq) === seq);
  if (!msg) throw httpError(404, '消息不存在');

  const room = await store.loadState();
  const dmId = room.dm ? room.dm.clientId : null;
  if (msg.sender !== sender && sender !== dmId) throw httpError(403, '只能删除自己发的消息');

  await store.deleteMessage(seq);
  return { ok: true };
}

/* ------------------------------ 导出 ------------------------------ */

function buildExport(room, characters, messages, me) {
  const dmId = room.dm ? room.dm.clientId : null;
  const visible = messages.filter((m) => canSee(m, me, dmId));

  const byChannel = new Map();
  for (const m of visible) {
    const ch = messageChannel(m);
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(m);
  }

  const lines = [];
  lines.push('# 跑团记录');
  lines.push('');
  lines.push(`- 导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(`- 导出身份：${displayId(me)}${me && me === dmId ? '（主持人）' : ''}`);
  lines.push(`- 主持人：${room.dm ? (room.dm.name || displayId(room.dm.clientId)) : '无'}`);
  lines.push(`- 角色卡：${characters.length} 张 · 消息：${visible.length} 条`);
  lines.push('');
  lines.push('> 本文件已按导出身份的可见性裁剪；悄悄话与定向消息仅出现在有权查看的导出中。');
  lines.push('');

  const channels = room.channels.slice();
  for (const m of visible) {
    const ch = messageChannel(m);
    if (!channels.find((c) => c.id === ch)) channels.push({ id: ch, name: ch });
  }

  for (const ch of channels) {
    const list = (byChannel.get(ch.id) || []).slice().sort(messageOrder);
    if (!list.length) continue;

    lines.push(`## 〔${ch.name}〕`);
    lines.push('');

    for (const m of list) {
      const time = m.created_at
        ? new Date(m.created_at).toLocaleString('zh-CN', { hour12: false })
        : '';
      const label = exportLabel(m);
      const who = m.kind === 'system' ? '系统' : (m.author || '—');
      const flags = [];
      if (m.visibility === 'dm') flags.push('悄悄话·仅主持人');
      if (m.visibility === 'direct') {
        const names = (m.audience || []).map((id) => displayId(id)).join('、');
        flags.push(`定向·${names || '—'}`);
      }

      lines.push(`### ${who} · ${time} · [${label}]${flags.length ? ' · ' + flags.join(' · ') : ''}`);
      lines.push('');

      const text = String(m.text || '');
      for (const line of text.split('\n')) lines.push(`> ${line}`);
      lines.push('');

      if (m.meta && m.meta.type === 'check') {
        const meta = m.meta;
        lines.push(`- 检定：${meta.label} · ${meta.mode === 'adv' ? '优势' : meta.mode === 'dis' ? '劣势' : '普通'} · 掷骰 [${(meta.rolls || []).join(',')}] → ${meta.total}${meta.dc != null ? ` vs DC ${meta.dc} · ${meta.success ? '成功' : '失败'}` : ''}${meta.nat6 ? ' · 大成功' : ''}${meta.nat1 ? ' · 大失败' : ''}`);
        lines.push('');
      } else if (m.meta && m.meta.type === 'dice') {
        const meta = m.meta;
        lines.push(`- 掷骰：${meta.expr} · ${(meta.rolls || []).map((r) => `[${r.join(',')}]`).join(' / ')} → ${meta.total}`);
        lines.push('');
      }
    }
  }

  if (!visible.length) lines.push('_（暂无可见记录）_');

  return lines.join('\n');
}

/* =========================================================================
 * 七、HTTP 路由
 * ========================================================================= */

/** nginx 会把论坛登录者的玩家名塞进 X-Forum-Player（URL 编码）。 */
function decodeForumHeader(raw) {
  const s = String(raw || '');
  if (!s) return '';
  try { return decodeURIComponent(s); } catch (err) { return s; }
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method || 'GET';
  const forumPlayer = decodeForumHeader(req.headers['x-forum-player']);

  /* ---------- GET /api/emojis ---------- */
  if (p === '/api/emojis' && method === 'GET') {
    return json(res, 200, readForumEmojis());
  }

  /* ---------- GET /api/state ---------- */
  if (p === '/api/state' && method === 'GET') {
    const me = String(q.get('me') || '');
    const since = Number(q.get('since') || 0);

    const [room, characters, allMessages] = await Promise.all([
      store.loadState(),
      store.listCharacters(),
      store.listMessages(0),
    ]);

    const dmId = room.dm ? room.dm.clientId : null;
    const messages = since > 0 ? allMessages.filter((m) => Number(m.seq) > since) : allMessages;
    // 增量游标用「全局最大 seq」，避免别人发悄悄话（你看不到）时游标卡死
    const maxSeq = allMessages.reduce((mx, m) => Math.max(mx, Number(m.seq) || 0), 0);

    // GM 笔记只给主持人，别人拿到的 state 里没有这个字段
    const stateForYou = Object.assign({}, room);
    if (!me || me !== dmId) {
      delete stateForYou.gmNotes;
      /* 剧情杀对玩家完全隐藏：不给 SAN 数值和开关，只保留催眠状态用于显示「无法行动」 */
      if (stateForYou.combat) {
        stateForYou.combat = Object.assign({}, stateForYou.combat);
        delete stateForYou.combat.plotKill;
        if (Array.isArray(stateForYou.combat.order)) {
          stateForYou.combat.order = stateForYou.combat.order.map((o) => {
            const copy = Object.assign({}, o);
            delete copy.san;
            return copy;
          });
        }
      }
    }

    const visibleForYou = messages.filter((m) => canSee(m, me, dmId));
    const isDmMe = Boolean(me && me === dmId);

    return json(res, 200, {
      characters: characters.map(characterView),
      messages: isDmMe ? visibleForYou : visibleForYou.map(maskDarkRoll),
      maxSeq,
      state: stateForYou,
      abilities: ABILITIES,
      skills: SKILLS,
      classes: CLASSES,
      /* 怪啖规则 */
      buffs: BUFFS,
      conditions: CONDITIONS,
      you: { clientId: me, isDm: Boolean(me && me === dmId) },
      typing: listTyping(me),
      /* 论坛登录态带过来的玩家名；为空表示直接访问（没走论坛网关） */
      forumPlayer,
      mode: USE_DB ? 'db' : 'memory',
      serverTime: nowISO(),
    });
  }

  /* ---------- GET /api/export ---------- */
  if (p === '/api/export' && method === 'GET') {
    const me = String(q.get('me') || '');
    const [room, characters, allMessages] = await Promise.all([
      store.loadState(),
      store.listCharacters(),
      store.listMessages(0),
    ]);

    const md = buildExport(room, characters, allMessages, me);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const filename = `跑团记录-${stamp}.md`;
    const body = Buffer.from(md, 'utf8');

    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': body.length,
      'Content-Disposition': `attachment; filename="dnd-log.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  /* ---------- POST 路由 ---------- */
  if (method !== 'POST') throw httpError(404, '未知接口');

  const body = await readBody(req);

  switch (p) {
    case '/api/dm': {
      const room = await store.loadState();
      const clientId = String(body.clientId || '');
      const release = Boolean(body.release);

      if (release || !clientId) {
        const old = room.dm;
        room.dm = null;
        await store.saveState(room);
        if (old) await systemMessage(`主持人（${old.name || displayId(old.clientId)}）释放了主持人身份`);
        return json(res, 200, { dm: null, state: room });
      }

      if (room.dm && room.dm.clientId !== clientId) {
        throw httpError(409, `主持人已由 ${room.dm.name || displayId(room.dm.clientId)} 担任`);
      }

      room.dm = { clientId, name: String(body.name || displayId(clientId)).slice(0, 24) };
      await store.saveState(room);
      await systemMessage(`${room.dm.name} 认领了主持人`);
      return json(res, 200, { dm: room.dm, state: room });
    }

    /* 表情回应：同一个人点第二次就取消 */
    case '/api/reaction': {
      const seq = Number(body.seq);
      const emoji = String(body.emoji || '').slice(0, 8);
      const me = String(body.clientId || '');
      if (!seq || !emoji || !me) throw httpError(400, '参数不全');

      const all = await store.listMessages(0);
      const target = all.find((m) => Number(m.seq) === seq);
      if (!target) throw httpError(404, '消息不存在');

      const meta = Object.assign({}, target.meta || {});
      const reactions = Object.assign({}, meta.reactions || {});
      const list = Array.isArray(reactions[emoji]) ? reactions[emoji].slice() : [];
      const idx = list.indexOf(me);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(me);
      if (list.length) reactions[emoji] = list;
      else delete reactions[emoji];
      meta.reactions = reactions;

      const saved = await store.patchMessage(seq, { meta });
      return json(res, 200, { message: saved });
    }

    case '/api/character': {
      const saved = await createCharacter(body);
      return json(res, 200, { character: characterView(saved) });
    }

    case '/api/character/update': {
      const saved = await updateCharacter(body);
      return json(res, 200, { character: characterView(saved) });
    }

    case '/api/character/delete': {
      const out = await deleteCharacter(body);
      return json(res, 200, out);
    }

    case '/api/gm/notes': {
      const out = await setGmNotes(body);
      return json(res, 200, out);
    }

    case '/api/announcement': {
      const out = await setAnnouncement(body);
      return json(res, 200, out);
    }

    case '/api/forum/sync': {
      const out = await syncForumCharacters();
      return json(res, 200, out);
    }

    case '/api/message': {
      const speaker = await resolveSpeaker(body);
      const room = await store.loadState();
      const dmId = room.dm ? room.dm.clientId : null;
      const sender = String(body.sender || '');

      /* 场景标记：只有主持人能发，强制成 system 类型 */
      const isScene = Boolean(body.scene && dmId && sender === dmId);

      const kind = isScene ? 'system' : normalizeKind(body.kind);
      const segs = buildSegments(body.text, kind);
      if (!segs.length) throw httpError(400, '消息不能为空');

      /* 传了角色卡却解析不出来 = 冒用别人的卡（含 NPC），直接拒绝 */
      if (String(body.characterId || '').trim() && !speaker) {
        throw httpError(403, '无权使用这张角色卡');
      }

      const baseMeta = speaker ? { characterId: speaker.id, avatar: speaker.avatar || '' } : {};
      // 主持人的发言单独标记，前端用来凸显
      if (dmId && sender === dmId) baseMeta.gm = true;
      // 场景分隔标记（只有主持人能发）
      if (isScene) baseMeta.scene = true;

      // 回复：把被引用的消息做个快照，原消息删了引用也不会瞎
      // 皮下（ooc）是提示行，和系统消息一样不可回复，直接忽略
      if (body.replyTo) {
        const all = await store.listMessages(0);
        const target = all.find((m) => Number(m.seq) === Number(body.replyTo));
        if (target && target.kind !== 'ooc' && canSee(target, sender, dmId)) {
          baseMeta.reply = {
            seq: target.seq,
            author: String(target.author || ''),
            text: String(target.text || '').slice(0, 120),
          };
        }
      }

      // 一段一条消息，按顺序落库，保证 seq / pos 连续
      const created = [];
      let firstSeg = true;
      for (const seg of segs) {
        const inline = rollInline(seg.text);
        const meta = Object.assign({}, baseMeta);
        if (!firstSeg) delete meta.reply; // 引用只挂在第一段
        firstSeg = false;
        if (inline.length) meta.inline = inline;
        created.push(await appendMessage({
          kind: seg.kind,
          author: speaker ? speaker.name : body.author,
          role: speaker ? 'pc' : body.role,
          text: seg.text,
          sender: body.sender,
          channel: body.channel,
          visibility: body.visibility,
          audience: body.audience,
          meta,
        }));
      }
      return json(res, 200, { messages: created, message: created[0] });
    }

    case '/api/preview': {
      const kind = normalizeKind(body.kind);
      return json(res, 200, {
        kind,
        auto: kind === 'auto',
        segments: buildSegments(body.text, kind),
        inline: scanInline(body.text),
      });
    }

    case '/api/rescue': {
      const out = await rescueCharacter(body);
      return json(res, 200, out);
    }

    case '/api/damage': {
      const out = await doDamage(body);
      return json(res, 200, out);
    }

    case '/api/attack': {
      const out = await rollAttack(body);
      return json(res, 200, out);
    }

    case '/api/death-save': {
      const out = await deathSaveRoll(body);
      return json(res, 200, out);
    }

    case '/api/rest': {
      const out = await partyRest(body);
      return json(res, 200, out);
    }

    case '/api/combat/start': {
      const combat = await combatStart(body);
      return json(res, 200, { combat });
    }

    case '/api/combat/next': {
      const combat = await combatNext(body);
      return json(res, 200, { combat });
    }

    case '/api/combat/next-round': {
      const out = await combatNextRound(body);
      return json(res, 200, out);
    }

    case '/api/rps/invite': {
      const out = await rpsInvite(body);
      return json(res, 200, out);
    }

    case '/api/rps/join': {
      const out = await rpsJoin(body);
      return json(res, 200, out);
    }

    case '/api/contest/invite': {
      const out = await contestInvite(body);
      return json(res, 200, out);
    }

    case '/api/contest/join': {
      const out = await contestJoin(body);
      return json(res, 200, out);
    }

    case '/api/lottery/open': {
      const out = await lotteryOpen(body);
      return json(res, 200, out);
    }

    case '/api/lottery/join': {
      const out = await lotteryJoin(body);
      return json(res, 200, out);
    }

    case '/api/lottery/close': {
      const out = await lotteryClose(body);
      return json(res, 200, out);
    }

    case '/api/combat/contest': {
      const out = await combatContest(body);
      return json(res, 200, out);
    }

    case '/api/combat/end': {
      const combat = await combatEnd(body);
      return json(res, 200, { combat });
    }

    case '/api/combat/patch': {
      const combat = await combatPatch(body);
      return json(res, 200, { combat });
    }

    case '/api/combat/plotkill': {
      const out = await combatPlotKill(body);
      return json(res, 200, out);
    }

    case '/api/channel/create': {
      const out = await channelCreate(body);
      return json(res, 200, out);
    }

    case '/api/channel/rename': {
      const out = await channelRename(body);
      return json(res, 200, out);
    }

    case '/api/channel/delete': {
      const out = await channelDelete(body);
      return json(res, 200, out);
    }

    case '/api/message/move': {
      const out = await messageMove(body);
      return json(res, 200, out);
    }

    case '/api/message/update': {
      const out = await editMessage(body);
      return json(res, 200, out);
    }

    case '/api/message/fold': {
      const out = await foldMessage(body);
      return json(res, 200, out);
    }

    case '/api/typing': {
      const speaker = await resolveSpeaker(body);
      if (!speaker) return json(res, 200, { ok: false });
      const channel = String(body.channel || 'main');
      typingMap.set(channel + '|' + String(body.sender || ''), {
        sender: String(body.sender || ''),
        channel,
        author: speaker.name,
        avatar: speaker.avatar || '',
        at: Date.now(),
      });
      return json(res, 200, { ok: true });
    }

    case '/api/message/delete': {
      const out = await removeMessage(body);
      return json(res, 200, out);
    }

    default:
      throw httpError(404, '未知接口');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/* 这些扩展名会做长缓存（头像文件名带版本号，替换后 URL 自动变化） */
const ASSET_EXT = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf']);

/* 论坛表情图片：/emoji/<文件名> 直接读论坛表情目录，不复制一份 */
function serveForumEmoji(req, res, pathname) {
  const file = path.basename(decodeURIComponent(pathname));
  if (!file || file.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400');
  }
  const full = path.join(FORUM_EMOJI_DIR, file);
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'image/webp',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=600',
    });
    res.end(buf);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(path.resolve(ROOT))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403');
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      /* 头像等资源：固定文件名，用短缓存（10 分钟）兼顾「刷新不重复下载」和「换头像及时生效」 */
      'Cache-Control': ASSET_EXT.has(path.extname(full).toLowerCase())
        ? 'public, max-age=600'
        : 'no-store, max-age=0',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      const status = err && err.status ? err.status : 500;
      if (status >= 500) console.error('[ERR]', req.method, url.pathname, err && err.message);
      if (!res.headersSent) {
        json(res, status, { error: (err && err.message) || '服务器错误' });
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
    return;
  }

  /* 论坛表情图片走独立目录转发 */
  if (url.pathname.startsWith('/emoji/')) {
    serveForumEmoji(req, res, url.pathname);
    return;
  }

  serveStatic(req, res, url.pathname);
});

async function autoImportForumCards() {
  if (!fs.existsSync(FORUM_DB_PATH)) return null;
  try {
    const chars = await store.listCharacters();
    if (chars.length) return null; // 已有数据就不覆盖，避免冲掉本地改动
    return await syncForumCharacters();
  } catch (err) {
    console.warn('  ! 论坛角色卡自动导入失败：' + err.message);
    return null;
  }
}

/* ---------------- 论坛数据随时同步 ----------------
 * db.json 的 mtime/大小一变就同步一次角色卡（新增 / 改名 / 换头像），
 * 不用玩家手动点「同步论坛卡」。论坛删用户不会删跑团里已有的卡。
 */
let forumStamp = '';
let forumSyncing = false;

function forumSignature() {
  try {
    const st = fs.statSync(FORUM_DB_PATH);
    return st.mtimeMs + ':' + st.size;
  } catch (err) {
    return '';
  }
}

async function watchForumChanges() {
  const sig = forumSignature();
  if (!sig || sig === forumStamp || forumSyncing) return;
  forumStamp = sig;
  forumSyncing = true;
  try {
    const out = await syncForumCharacters();
    if (out.created || out.refreshed) {
      console.log(`[forum] 自动同步：新增 ${out.created} 张、更新 ${out.refreshed} 张（共 ${out.cards}）`);
    }
  } catch (err) {
    console.warn('[forum] 自动同步失败：' + err.message);
  } finally {
    forumSyncing = false;
  }
}

async function main() {
  /* 退出/重启前把内存状态同步写盘（pm2 restart 发的是 SIGINT/SIGTERM） */
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
    process.on(sig, () => {
      try { if (store && typeof store.flushNow === 'function') store.flushNow(); } catch (err) {}
      process.exit(0);
    });
  });

  const imported = await autoImportForumCards();

  /* 论坛账号 / 角色卡随时同步（20 秒检查一次 db.json 是否变动） */
  forumStamp = forumSignature();
  setInterval(() => { watchForumChanges(); }, 20000);

  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log('');
    console.log('  单房间 · 怪啖跑团平台（1d6 规则）');
    console.log('  ─────────────────────────────');
    console.log(`  监听：http://${shown}:${PORT}`);
    console.log(`  存储：${USE_DB ? 'PostgREST（' + SUPABASE_URL + '）' : '文件（' + STORE_FILE + '）'}`);

    if (imported) {
      console.log(`  论坛卡：已导入 ${imported.cards} 张（跳过 ${imported.skipped} 个空/测试账号）`);
    } else if (fs.existsSync(FORUM_DB_PATH)) {
      console.log('  论坛卡：已有数据，跳过自动导入（侧栏「同步论坛卡」可手动刷新）');
    } else {
      console.log('  论坛卡：未找到 db.json，跳过导入');
    }

    console.log('');
    console.log('  打开页面后选「玩家名」作为账号，同名下的角色即你的角色卡。');
    console.log('');
  });
}

main();