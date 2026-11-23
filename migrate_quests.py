#!/usr/bin/env python3
"""把「调查委托」频道里已有的求助帖迁移成委托模块的记录。

- 论坛帖子本身保留不动，委托通过 threadId 指回原文
- 幂等：同一 threadId 只会生成一条委托，重复运行不会重复插入
- 只改 data/db.json，不碰 files/

用法： python migrate_quests.py
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, 'data', 'db.json')
CHANNEL_NAME = '调查委托'
THREAD_TITLE_KEY = '村中行为诡异的人群'

# 原帖里附的两张外链图，取第一张作委托预览图。
# 若本地已备好压缩封面（data/files/quest-covers/<委托id>.webp），优先用本地文件，避免外链失效。
COVER_URL = 'https://beeimg.us.ci/temp/49c065c6369fc536bdbb591a11ed0d02.jpg'


def local_cover(quest_id):
    rel = os.path.join('data', 'files', 'quest-covers', quest_id + '.webp')
    if os.path.exists(os.path.join(ROOT, rel)):
        return '/files/quest-covers/%s.webp' % quest_id
    return COVER_URL


def load_db():
    with open(DB_PATH, encoding='utf-8') as f:
        return json.load(f)


def save_db(db):
    tmp = DB_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, DB_PATH)


def find_thread(db):
    ch = next((c for c in db.get('channels', []) if c.get('name') == CHANNEL_NAME), None)
    if not ch:
        return None
    for t in db.get('threads', []):
        if t.get('channelId') == ch['id'] and THREAD_TITLE_KEY in (t.get('title') or ''):
            return t
    return None


def build_quest(t):
    qid = 'mq' + str(int(time.time() * 1000))[-9:] + 'a1'
    return {
        'id': qid,
        'seq': 1,
        'title': t['title'],
        'kind': 'side',
        'cover': local_cover(qid),
        'desc': t.get('body') or '',
        'place': '闻山市郊区 · 徒步路线旁的村子',
        'when': '发现于当日 07:30 前后',
        'requirements': '原帖未写明。建议两人以上同行，携带照明与记录设备，不要惊动村民。',
        'status': 'open',
        'authorId': t.get('authorId'),
        'author': t.get('author') or '',
        'anon': bool(t.get('anon')),
        'threadId': t['id'],
        'votes': [],
        'createdAt': t.get('createdAt') or int(time.time() * 1000),
        'updatedAt': t.get('createdAt') or int(time.time() * 1000),
        'deleted': False,
    }


def main():
    if not os.path.exists(DB_PATH):
        sys.exit('找不到 %s' % DB_PATH)
    db = load_db()
    db.setdefault('quests', [])
    db.setdefault('questSeq', 0)

    t = find_thread(db)
    if not t:
        sys.exit('未在「%s」频道找到标题含「%s」的帖子，未做任何修改。' % (CHANNEL_NAME, THREAD_TITLE_KEY))

    exists = next((q for q in db['quests'] if q.get('threadId') == t['id']), None)
    if exists:
        print('已存在委托 %s（%s），跳过。' % (exists['id'], exists['title']))
        return

    q = build_quest(t)
    q['seq'] = db['questSeq'] + 1
    db['questSeq'] = q['seq']
    db['quests'].append(q)
    save_db(db)
    print('已迁移：%s -> 委托 %s' % (t['title'], q['id']))
    print('  类型: 普通委托(白)  地点: %s' % q['place'])


if __name__ == '__main__':
    main()