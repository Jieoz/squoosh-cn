#!/usr/bin/env python3
"""汉化已构建的 Squoosh bundle 内界面字符串。

只替换白名单里已人工核对过是「界面文案」的字符串字面量。
排除项（绝不替换）：
  "Options"        -> 是 `"Options" in o` 的对象键
  ArrowUp/Digit1/Numpad1/Enter/Home/End -> KeyboardEvent.code
  AbortError       -> DOMException 名
  vector/lanczos3… -> option 的 value
  YCbCr/PSNR/SSIM/… -> 技术缩写，保留原文更易懂
每条替换都断言命中次数，数量不符即退出，避免静默漏改。
"""
import json
import re
import sys

MAP = {
    # 顶层界面
    '"Compress"': '"压缩"',
    '"Edit"': '"编辑"',
    '"Resize"': '"缩放尺寸"',
    '"Reduce palette"': '"减少调色板"',
    '"Back"': '"返回"',
    '"Advanced settings"': '"高级设置"',
    '"Original Image "': '"原图 "',
    '"Save side settings"': '"保存此侧设置"',
    '"Copy settings to other side"': '"把设置复制到另一侧"',
    '"Left side settings saved"': '"已保存左侧设置"',
    '"Right side settings saved"': '"已保存右侧设置"',
    '"Left side settings imported"': '"已载入左侧设置"',
    '"Right side settings imported"': '"已载入右侧设置"',
    '"Settings copied across"': '"设置已复制到另一侧"',
    # 通用编码选项
    '"Quality:"': '"质量："',
    '"Effort:"': '"编码强度："',
    '"Method:"': '"算法："',
    '"Passes:"': '"迭代次数："',
    '"Preset:"': '"预设："',
    '"Tuning:"': '"调优目标："',
    '"Type:"': '"类型："',
    '"Sharpness:"': '"锐度："',
    '"Color space:"': '"色彩空间："',
    '"Alpha Quality:"': '"Alpha 质量："',
    '"Alpha quality:"': '"Alpha 质量："',
    '"Lossless"': '"无损"',
    '"Slight loss"': '"轻微有损"',
    '"Slight loss:"': '"轻微有损："',
    '"Interlace"': '"隔行扫描"',
    '"Subsample chroma:"': '"色度二次采样："',
    '"Auto"': '"自动"',
    '"Vary"': '"可变"',
    '"Half"': '"一半"',
    '"Off"': '"关闭"',
    '"Auto edge filter"': '"自动边缘滤波"',
    '"Alternative lossy mode"': '"备用有损模式"',
    '"Preserve transparent data"': '"保留透明数据"',
    '"Extra chroma compression"': '"额外压缩色度"',
    '"Separate alpha quality"': '"单独设置 Alpha 质量"',
    '"Progressive rendering"': '"渐进式渲染"',
    '"Optimize Huffman table"': '"优化霍夫曼表"',
    '"Optimize zero block runs"': '"优化零块连续段"',
    '"Optimize after trellis quantization"': '"网格量化后再优化"',
    '"Spatial noise shaping:"': '"空间噪声整形："',
    '"Edge preserving filter:"': '"边缘保留滤波："',
    '"Error diffusion:"': '"误差扩散："',
    '"Noise synthesis:"': '"噪声合成："',
    '"Noise equivalent to ISO:"': '"等效 ISO 噪声："',
    '"Log2 of tile cols:"': '"分块列数 Log2："',
    '"Log2 of tile rows:"': '"分块行数 Log2："',
    '"Optimise for decoding speed (worse compression):"': '"优先解码速度（压缩率下降）："',
    '"Random matrix"': '"随机矩阵"',
    '"Vector"': '"矢量"',
    '"Triangle (bilinear)"': '"三角（双线性）"',
    '"hqx (pixel art)"': '"hqx（像素画）"',
    '"Browser JPEG"': '"浏览器 JPEG"',
    '"Browser PNG"': '"浏览器 PNG"',
    '"Browser GIF"': '"浏览器 GIF"',
    '"Browser low quality"': '"浏览器低质量"',
    '"Browser medium quality"': '"浏览器中等质量"',
    '"Browser high quality"': '"浏览器高质量"',
    '"Browser pixelated"': '"浏览器像素化"',
    '"WebP v2 (unstable)"': '"WebP v2（不稳定）"',
    '"JPEG XL (beta)"': '"JPEG XL（测试版）"',
    # 报错文案
    '"Encoding failed"': '"编码失败"',
    '"Couldn\'t decode image"': '"无法解码该图片"',
    '"Image loading error"': '"图片加载失败"',
    '"Data URL reading failed"': '"Data URL 读取失败"',
    '"Could not create canvas context"': '"无法创建 canvas 上下文"',
    '"Canvas not initialized"': '"canvas 尚未初始化"',
    '"No vector image available"': '"没有可用的矢量图"',
    '"SVG must have width/height or viewBox"': '"SVG 必须带 width/height 或 viewBox"',
    '"Failed to load app"': '"应用加载失败"',
}

# 期望命中次数；未列出的默认 1
EXPECT = {
    '"Lossless"': 4,
    '"Auto"': 2,
}


def main(paths):
    total = 0
    for path in paths:
        src = open(path, encoding='utf-8').read()
        out = src
        for needle, repl in MAP.items():
            n = out.count(needle)
            if n == 0:
                continue
            want = EXPECT.get(needle)
            if want is not None and n != want:
                sys.exit('命中次数不符 %s: got %d want %d (%s)' % (needle, n, want, path))
            out = out.replace(needle, repl)
            total += n
        if out != src:
            open(path, 'w', encoding='utf-8').write(out)
            print('patched %s (%d bytes)' % (path, len(out.encode('utf-8'))))
    print('replacements:', total)
    # 复查：不该残留的英文界面串
    leftovers = []
    for path in paths:
        s = open(path, encoding='utf-8').read()
        for k in ('"Quality:"', '"Advanced settings"', '"Lossless"', '"Encoding failed"'):
            if k in s:
                leftovers.append((path, k))
    if leftovers:
        sys.exit('残留: %s' % json.dumps(leftovers, ensure_ascii=False))
    print('verify ok: 无残留英文界面串')


if __name__ == '__main__':
    main(sys.argv[1:])
