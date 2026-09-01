#!/usr/bin/env python3
"""把 squoosh-cn 的 nginx location 块插入 server 块尾部（幂等）。

用法：python3 insert_nginx_block.py <目标 nginx 配置> <squoosh-cn.conf>

插到最后一个单独成行的 } 之前，即 server 块收尾处。
已存在标记则跳过，可反复执行。
"""
import sys

MARK = 'squoosh-cn'


def main(conf_path, block_path):
    text = open(conf_path, encoding='utf-8').read()
    if MARK in text:
        print('already present, skip')
        return
    block = open(block_path, encoding='utf-8').read().rstrip('\n')
    lines = text.split('\n')
    # 最后一个只含 } 的行 = server 块收尾
    idx = max(i for i, l in enumerate(lines) if l.strip() == '}')
    lines[idx:idx] = [''] + block.split('\n') + ['']
    open(conf_path, 'w', encoding='utf-8').write('\n'.join(lines))
    print('inserted before line', idx + 1)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
