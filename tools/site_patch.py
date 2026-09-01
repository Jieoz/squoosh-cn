#!/usr/bin/env python3
"""对已构建的 Squoosh 产物做站点级修复。

1. 去掉 Google Analytics（ga 调用 + analytics.js 动态注入）——第三方请求，中国网络下白等超时。
2. og:image / og:image:secure_url 域名从 squoosh.app 改成本站，分享卡片能取到图。
3. og:image:alt 与 twitter 账号本地化。
4. serviceworker：把 batch-cn.js / jszip.min.js 纳入预缓存清单，并 bump VERSION，
   让老访客的旧缓存失效（否则改了也看不到）。
每步都断言实际改动，未命中即报错退出。
"""
import hashlib
import os
import re
import sys

# 站点地址由环境变量提供（见 config.env.example）。仓库内不硬编码任何真实域名。
SITE = os.environ.get('SQ_SITE_ORIGIN', '').rstrip('/')
# 产物自带的基路径（官方产物编译期烙死的那个）。本脚本只按它匹配；
# 真正换成目标基路径由 tools/rebase_path.py 在之后统一做。
SRC_BASE = '/' + os.environ.get('SQ_SOURCE_BASE_PATH', 'squoosh-cn').strip('/') + '/'
if not SITE:
    sys.exit('缺少环境变量 SQ_SITE_ORIGIN（例如 https://example.com）')


GA_RE = re.compile(
    r'\{const \w+=navigator\.standalone\|\|window\.matchMedia\('
    r'"\(display-mode: standalone\)"\)\.matches\?"standalone":"browser";'
    r'window\.ga=.*?google-analytics\.com/analytics\.js"'
    r'.{0,60}?appendChild\(\w+\)\}\)\)\}',
    re.S,
)


def strip_ga(path):
    """去掉 GA：index.html 的内联 bundle 与 initial-app chunk 各有一份。"""
    s = open(path, encoding='utf-8').read()
    s2, n = GA_RE.subn('', s)
    if n == 0:
        sys.exit('GA 块未命中: %s' % path)
    if 'google-analytics' in s2 or 'UA-128752250' in s2:
        sys.exit('GA 残留: %s' % path)
    open(path, 'w', encoding='utf-8').write(s2)
    print('%s: 去 GA %d 处' % (path.rsplit('/', 1)[-1], n))


def fix_html(path):
    strip_ga(path)
    s = open(path, encoding='utf-8').read()
    orig = s

    before = s.count('https://squoosh.app' + SRC_BASE)
    if before == 0:
        sys.exit('og:image 未找到 squoosh.app%s，产物可能已变（检查 SQ_SOURCE_BASE_PATH）' % SRC_BASE)
    s = s.replace('https://squoosh.app' + SRC_BASE, SITE + SRC_BASE)

    # canonical 仍指向官方站，会让搜索引擎把本站当官方站的重复内容
    s = s.replace('<link rel="canonical" href="https://squoosh.app"',
                  '<link rel="canonical" href="%s"' % (SITE + SRC_BASE))
    if 'canonical" href="https://squoosh.app"' in s:
        sys.exit('canonical 未替换')

    # og:description 还是英文原文
    en_desc = ('Squoosh is the ultimate image optimizer that allows you to '
               'compress and compare images with different codecs in your browser.')
    if en_desc in s:
        s = s.replace(en_desc, 'Squoosh 图片压缩：在浏览器中使用多种编码器压缩图片并即时对比效果，'
                               '支持多图与 ZIP 压缩包批量处理，图片不会离开你的设备。')
    else:
        print('  提示: og:description 英文原文未找到（可能已改过）')

    s = s.replace(
        'content="A cartoon of a hand squeezing an image file on a dark background."',
        'content="一只手在深色背景上挤压图片文件的卡通图。"',
    )
    s = s.replace('content="@SquooshApp"', 'content="Squoosh 图片压缩"')

    if s == orig:
        sys.exit('index.html 没有任何改动')
    open(path, 'w', encoding='utf-8').write(s)
    print('index.html: 去 GA 1 处、og 域名 %d 处' % before)


def fix_sw(path, extra_assets):
    s = open(path, encoding='utf-8').read()
    orig = s

    m = re.search(r'const ASSETS = \[\n(.*?)\n\];', s, re.S)
    if not m:
        sys.exit('ASSETS 数组未命中')
    body = m.group(1)
    added = []
    for a in extra_assets:
        if '"%s"' % a in body:
            continue
        body = body.rstrip()
        if not body.endswith(','):
            body += ','
        body += '\n  "%s"' % a
        added.append(a)
    s = s[:m.start(1)] + body + s[m.end(1):]

    m2 = re.search(r'const VERSION = "([0-9a-f]+)";', s)
    if not m2:
        sys.exit('VERSION 未命中')
    old_ver = m2.group(1)
    new_ver = hashlib.sha1(('%s|cn-fix-v2' % old_ver).encode()).hexdigest()
    s = s.replace('const VERSION = "%s";' % old_ver, 'const VERSION = "%s";' % new_ver)

    if s == orig:
        sys.exit('serviceworker.js 没有任何改动')
    open(path, 'w', encoding='utf-8').write(s)
    print('serviceworker.js: 新增预缓存 %s，VERSION %s -> %s' % (added, old_ver[:8], new_ver[:8]))


if __name__ == '__main__':
    root = sys.argv[1].rstrip('/')
    fix_html(root + '/index.html')
    strip_ga(root + '/c/initial-app-66f2784a.js')
    fix_sw(root + '/serviceworker.js', ['c/batch-cn.js', 'c/jszip.min.js'])
