# -*- coding: utf-8 -*-
"""把两个制卡工具原样内联为站点原生页面（register.html / publish.html）。
不修改工具原文件；提取其 <style> 并做作用域前缀化，提取 <body> 标记与内联脚本。"""
import re, io, os

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, 'site')

def read(p):
    with io.open(p, encoding='utf-8') as f:
        return f.read()

def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)

def prefix_selector(sel, wrap):
    sel = sel.strip()
    if not sel:
        return None
    if sel.startswith(':root'):
        return wrap + sel[len(':root'):]
    if sel == 'html' or sel == 'html,body':
        return wrap
    if sel == 'body':
        return wrap
    if sel.startswith('body'):
        rest = sel[4:]
        if rest.startswith(':'):          # body:before -> wrap:before（不可带空格）
            return wrap.rstrip() + rest
        return 'body' + rest + ' ' + wrap  # body.choosing -> body.choosing wrap
    if sel.startswith('html'):
        return wrap + ' ' + sel[4:].lstrip()
    if sel == '*':
        return wrap + ' *,' + wrap
    if sel.startswith('*'):
        return wrap + ' ' + sel
    return wrap + ' ' + sel

def scope_css(css, wrap):
    css = strip_comments(css)
    out = []
    i, n = 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j == -1:
            out.append(css[i:])
            break
        prelude = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == '{': depth += 1
            elif css[k] == '}': depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        if prelude.startswith('@'):
            head = prelude.split()[0].rstrip('{').lower()
            if head in ('@media', '@supports', '@container', '@layer'):
                out.append(prelude + '{' + scope_css(body, wrap) + '}')
            else:
                out.append(prelude + '{' + body + '}')
        else:
            sels = []
            for sel in prelude.split(','):
                p = prefix_selector(sel, wrap)
                if p: sels.append(p)
            if sels:
                out.append(','.join(sels) + '{' + body + '}')
        i = k
    return ''.join(out)

def rewrite_css_urls(css, mount):
    css = re.sub(r'url\((["\']?)\.{0,2}/?assets/', lambda m: 'url(' + m.group(1) + mount, css)
    return css

def rewrite_markup_urls(html, mount):
    html = re.sub(r'(src|href)=(["\'])\.{0,2}/?assets/', lambda m: m.group(1) + '=' + m.group(2) + mount, html)
    return html

def extract(html):
    styles = re.findall(r'<style[^>]*>(.*?)</style>', html, flags=re.S)
    bodym = re.search(r'<body[^>]*>(.*)</body>', html, flags=re.S)
    body = bodym.group(1)
    scripts_inline, scripts_src = [], []
    for m in re.finditer(r'<script([^>]*)>(.*?)</script>', body, flags=re.S):
        attrs, code = m.group(1), m.group(2)
        if 'src=' in attrs:
            scripts_src.append(attrs)
        elif code.strip():
            scripts_inline.append(code)
    body_noscript = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.S)
    return '\n'.join(styles), body_noscript, scripts_inline, scripts_src

HEAD = '''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/assets/openeye.png">
<title>{title}</title>
<link rel="stylesheet" href="/assets/forum.css">
<link rel="stylesheet" href="/assets/{toolcss}?v=20091130">
<style>
#site-header {{ position: relative; z-index: 60; }}
.bridge-note {{ position: relative; z-index: 55; }}
{extra}
</style>
</head>
'''

DECODE_SHIM = '''<script>
/* 兼容补丁：个别环境（后台标签页/无头浏览器）中 image.decode() 可能永不 settle，
   会使制卡工具的徽记与图片读取卡死。这里用 load 事件与之竞速，真实浏览器行为不变。 */
(function () {
  var orig = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    var img = this;
    return Promise.race([
      orig.call(img).catch(function () {}),
      new Promise(function (res) {
        if (img.complete) return res();
        img.addEventListener('load', function () { res(); }, { once: true });
        img.addEventListener('error', function () { res(); }, { once: true });
      })
    ]);
  };
})();
</script>
'''

def build_register():
    html = read(os.path.join(ROOT, '怪啖论坛制卡工具', 'fantaforum_card.html'))
    css, body, inline, srcs = extract(html)
    css = rewrite_css_urls(scope_css(css, '#cardtool '), '/tools/card/assets/')
    body = rewrite_markup_urls(body, '/tools/card/assets/')
    with io.open(os.path.join(SITE, 'assets', 'cardtool.css'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('/* 由 build-native-pages.py 自动从 怪啖论坛制卡工具/fantaforum_card.html 提取并作用域化（#cardtool）。勿手改。 */\n')
        f.write(css)
    page = HEAD.format(title='创建账号 · 怪啖论坛', toolcss='cardtool.css',
        extra='#cardtool>header{display:none} /* 站点导航已含品牌与音乐开关，隐藏工具自带顶栏 */')
    page += '''<body data-section="register" data-section-name="创建账号">
''' + DECODE_SHIM + '''<header id="site-header"></header>

<div class="bridge-note">
  <span class="kicker">REGISTRATION / CARD MAKER</span>
  <span>下方即「怪啖论坛制卡工具」本体（已并入站点，无需内嵌框架）。填写完成后点击工具右上角的 <b>提交到怪啖论坛 · 创建账号</b>，即可把账号与卡面提交到论坛；仍可照常导出 PNG 留档。</span>
</div>
<div class="bridge-note" id="result-note" hidden style="border-color:#4d7a4f;background:#0b180cd9;color:#bcd8bb">
  <span id="result-text"></span>
  <a class="btn primary" href="index.html">去登入聊天室</a>
</div>

<div id="cardtool">
''' + body + '''
</div>

<script src="/tools/card/assets/card-capture.js"></script>
<script src="/tools/card/assets/card-runtime.js"></script>
<script>
/* 站点原生模式：跳过工具自带的音乐询问与欢迎动画（站点导航栏已有音乐开关），直接显示制卡界面 */
(() => {
  const gate = document.getElementById('music-gate');
  const scene = document.getElementById('welcome-scene');
  const main = document.getElementById('main-content');
  const reg = document.getElementById('registration');
  if (gate) gate.hidden = true;
  if (scene) scene.hidden = true;
  if (main) main.hidden = false;
  if (reg) reg.classList.add('registration-enter');
})();
</script>
<script src="/assets/forum.js?v=20091130"></script>
<script src="/assets/web-bridge.js?v=20091130"></script>
<script>
'use strict';
FF.renderHeader();
window.addEventListener('message', e => {
  if (e.origin !== location.origin || !e.data || e.data.source !== 'fanta-bridge') return;
  if (e.data.tool !== 'card' || !e.data.ok || e.data.ready) return;
  const note = document.getElementById('result-note');
  note.hidden = false;
  document.getElementById('result-text').textContent =
    e.data.status === 'approved' ? '账号创建成功并已通过审核，可直接登入聊天室。' : '账号创建成功，已提交管理员审核；通过审核后即可发言与投稿。';
  note.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
</script>
</body>
</html>
'''
    with io.open(os.path.join(SITE, 'register.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(page)
    print('register.html bytes:', len(page.encode('utf-8')), 'cardtool.css bytes:', len(css.encode('utf-8')))

def build_publish():
    html = read(os.path.join(ROOT, '怪谈档案制卡工具', 'guaitan_card.html'))
    css, body, inline, srcs = extract(html)
    css = rewrite_css_urls(scope_css(css, '#guaitool '), '/tools/guaitan/assets/')
    body = rewrite_markup_urls(body, '/tools/guaitan/assets/')
    # 警示语放进工具顶栏那一行，占类型选择阶段按钮隐藏后的位置
    notice = '<span id="notice-note">请勿投稿未经验证的怪谈，如果怪谈已经被验证则不存在怪谈</span>'
    marker = '<div class="header-actions">'
    if marker in body and 'id="notice-note"' not in body:
        body = body.replace(marker, notice + marker, 1)
    inline = [rewrite_markup_urls(s, '/tools/guaitan/assets/') for s in inline]
    with io.open(os.path.join(SITE, 'assets', 'guaitool.css'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('/* 由 build-native-pages.py 自动从 怪谈档案制卡工具/guaitan_card.html 提取并作用域化（#guaitool）。勿手改。 */\n')
        f.write(css)
    page = HEAD.format(title='发布怪谈 · 怪啖论坛', toolcss='guaitool.css',
        extra='#guaitool>header .site-heading{display:none} /* 站点导航已含品牌，隐藏工具顶栏标题、保留操作按钮 */\n'
              '#notice-note{display:none;align-self:center;color:#e5d9d1} /* 制卡阶段隐藏；类型选择阶段占顶栏按钮原位 */\n'
              'body.choosing #notice-note{display:block}')
    page += '''<body data-section="publish" data-section-name="发布怪谈">
''' + DECODE_SHIM + '''<header id="site-header"></header>

<div class="bridge-note" id="result-note" hidden style="border-color:#4d7a4f;background:#0b180cd9;color:#bcd8bb">
  <span id="result-text"></span>
  <a class="btn primary" href="archives.html">去怪谈档案看看</a>
</div>

<div id="guaitool">
''' + body + '''
</div>

<script src="/tools/guaitan/assets/capture.js"></script>
<script>
''' + '\n'.join(inline) + '''
</script>
<script src="/assets/forum.js?v=20091130"></script>
<script src="/assets/web-bridge.js?v=20091130"></script>
<script>
'use strict';
FF.renderHeader();
window.addEventListener('message', e => {
  if (e.origin !== location.origin || !e.data || e.data.source !== 'fanta-bridge') return;
  if (e.data.tool !== 'guaitan' || !e.data.ok || e.data.ready) return;
  const note = document.getElementById('result-note');
  note.hidden = false;
  document.getElementById('result-text').textContent =
    e.data.status === 'approved' ? '投稿成功，怪谈已放入档案库。' : '投稿已提交，等待管理员审核。';
  note.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
</script>
</body>
</html>
'''
    with io.open(os.path.join(SITE, 'publish.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(page)
    print('publish.html bytes:', len(page.encode('utf-8')), 'guaitool.css bytes:', len(css.encode('utf-8')))

build_register()
build_publish()
