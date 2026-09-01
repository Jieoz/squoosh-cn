#!/usr/bin/env python3
"""把产物里烙死的部署基路径改成目标基路径。

Squoosh 官方产物是按某个固定 PATH_PREFIX 编译的，`/squoosh-cn/` 这个前缀被
硬写进 manifest.json、serviceworker.js、各 WASM glue chunk 等 23 个文件共
211 处。只改 index.html 是不够的 —— service worker 的预缓存清单、worker 的
兄弟 chunk 路径、manifest 的 icon/screenshot/share_target 都会 404。

用法：python3 tools/rebase_path.py <build 目录> <原前缀> <新前缀>
      两个前缀都要形如 /xxx/ 或 /

幂等：新旧相同时直接跳过。改完断言零残留。
"""
import os
import sys

# 只重写文本资源；图片/wasm 二进制里不会有路径字符串
TEXT_EXT = {'.html', '.js', '.json', '.webmanifest', '.css', '.svg', '.txt', '.map'}


def main(root, old, new):
    if not (old.startswith('/') and old.endswith('/')):
        sys.exit('原前缀必须形如 /xxx/ 或 /，收到 %r' % old)
    if not (new.startswith('/') and new.endswith('/')):
        sys.exit('新前缀必须形如 /xxx/ 或 /，收到 %r' % new)
    if old == new:
        print('rebase: 基路径未变（%s），跳过' % old)
        return

    ob, nb = old.encode(), new.encode()
    changed_files = 0
    changed_hits = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if os.path.splitext(name)[1].lower() not in TEXT_EXT:
                continue
            path = os.path.join(dirpath, name)
            with open(path, 'rb') as f:
                data = f.read()
            n = data.count(ob)
            if not n:
                continue
            with open(path, 'wb') as f:
                f.write(data.replace(ob, nb))
            changed_files += 1
            changed_hits += n

    if changed_hits == 0:
        sys.exit('rebase: 未找到任何 %s，产物前缀可能不是这个（检查 SQ_SOURCE_BASE_PATH）' % old)

    # 断言零残留
    leftovers = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if os.path.splitext(name)[1].lower() not in TEXT_EXT:
                continue
            path = os.path.join(dirpath, name)
            if ob in open(path, 'rb').read():
                leftovers.append(path)
    if leftovers:
        sys.exit('rebase: 仍有残留 %s: %s' % (old, leftovers[:5]))

    print('rebase: %s -> %s  文件 %d，替换 %d 处' % (old, new, changed_files, changed_hits))


if __name__ == '__main__':
    main(sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3])
