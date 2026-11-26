-- =============================================================
-- 单房间 · DND 5e 跑团平台 —— PostgREST（Supabase）表结构
-- 在 Supabase → SQL Editor 里整段执行，可重复执行（幂等）。
-- =============================================================
--
-- 【重要】PostgREST 的列名大小写敏感。
--   ownerClientId / maxHp 这类混合大小写列必须用双引号建列，
--   服务端请求体里的字段名也必须和列名大小写完全一致。
--   （写成 ownerclientid 会得到 42703 column does not exist）
--
-- =============================================================

-- ---------- characters ----------
create table if not exists public.characters (
  "id"              text primary key,
  "name"            text not null default '未命名',
  "owner"           text default '',
  "ownerClientId"   text default '',
  "avatar"          text default '',   -- 头像路径 /avatars/xxx.webp（从论坛同步时复制过来）
  "cls"             text default '战士',
  "level"           int  default 1,
  "str"             int  default 10,
  "dex"             int  default 10,
  "con"             int  default 10,
  "inte"            int  default 10,   -- 智力：避开保留字 int
  "wis"             int  default 10,
  "cha"             int  default 10,
  "maxHp"           int  default 10,
  "hp"              int  default 10,
  "ac"              int  default 10,
  "notes"           text default '',
  "proficient"      jsonb default '[]'::jsonb,   -- 18 个技能的 id 数组
  "conditions"      jsonb default '[]'::jsonb,   -- 15 种状态的 id 数组
  "created_at"      timestamptz default now()
);

-- ---------- messages ----------
create table if not exists public.messages (
  "seq"             bigserial primary key,
  "kind"            text default 'ic',      -- ic / emote / ooc / roll / system / combat
  "author"          text default '',
  "role"            text default 'player',  -- pc / dm / player / system
  "text"            text default '',
  "meta"            jsonb default '{}'::jsonb,
  "sender"          text default '',        -- clientId
  "visibility"      text default 'all',     -- all / dm / direct
  "audience"        jsonb default '[]'::jsonb,
  "channel"         text default 'main',
  "pos"             double precision,       -- 频道内排序位；null 时按 seq 兜底
  "created_at"      timestamptz default now()
);

-- ---------- room_state（单行，id 恒为 1）----------
create table if not exists public.room_state (
  "id"              int primary key,
  "data"            jsonb default '{}'::jsonb
);
insert into public.room_state ("id", "data") values (1, '{}'::jsonb) on conflict ("id") do nothing;

-- =============================================================
-- 给「已有表」加新字段：必须用幂等 ALTER
-- =============================================================
alter table public.characters add column if not exists "ownerClientId" text default '';
alter table public.characters add column if not exists "avatar"        text default '';
alter table public.characters add column if not exists "proficient"    jsonb default '[]'::jsonb;
alter table public.characters add column if not exists "conditions"    jsonb default '[]'::jsonb;
alter table public.messages   add column if not exists "channel"       text default 'main';
alter table public.messages   add column if not exists "pos"           double precision;
alter table public.messages   add column if not exists "audience"      jsonb default '[]'::jsonb;

-- 【坑】ADD COLUMN ... DEFAULT 不会回填历史行，旧数据该列仍是 NULL。
-- 新增 channel 列时，历史消息必须全部归到 'main'，否则按频道过滤会漏掉它们：
update public.messages set "channel" = 'main' where "channel" is null;
-- pos 为空的历史消息，用 seq 当排序位：
update public.messages set "pos" = "seq" where "pos" is null;
-- 顺手把 null 的 jsonb 列补成空数组：
update public.characters set "proficient" = '[]'::jsonb where "proficient" is null;
update public.characters set "conditions" = '[]'::jsonb where "conditions" is null;
update public.messages   set "audience"   = '[]'::jsonb where "audience"   is null;

-- =============================================================
-- 索引
-- =============================================================
create index if not exists messages_channel_pos_idx on public.messages ("channel", "pos");
create index if not exists characters_owner_idx     on public.characters ("ownerClientId");

-- =============================================================
-- 权限（内部自用：anon key 直接读写）
-- 注意：这等同于「拿到地址的人都能读写」，不要用于公网正式场景。
-- =============================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.characters to anon, authenticated;
grant select, insert, update, delete on public.messages   to anon, authenticated;
grant select, insert, update, delete on public.room_state to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

alter table public.characters enable row level security;
alter table public.messages   enable row level security;
alter table public.room_state enable row level security;

drop policy if exists demo_all on public.characters;
drop policy if exists demo_all on public.messages;
drop policy if exists demo_all on public.room_state;

create policy demo_all on public.characters for all to anon, authenticated using (true) with check (true);
create policy demo_all on public.messages   for all to anon, authenticated using (true) with check (true);
create policy demo_all on public.room_state for all to anon, authenticated using (true) with check (true);