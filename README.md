# squoosh-cn

[Squoosh](https://squoosh.app)（Google Chrome Labs 出品的浏览器端图片压缩工具）的
**中文版 + 批量压缩** 部署工程。

- 全站中文界面（编辑器 99 处界面串）
- 新增**批量压缩面板**：多图 / ZIP 压缩包一次处理，结果打包成 ZIP 下载
- 修好子路径部署下的一系列问题（COOP/COEP、缓存、canonical、GA 等，见下）
- 域名与部署路径全部变量化，`config.env` 一份配置即可部署到自己的站点

> 压缩全程在浏览器本地完成，图片不上传服务器 —— 这一点与官方 Squoosh 一致。

## 这个仓库解决什么问题

官方 Squoosh 只能一张一张地压。批量场景（一个相册、一个 ZIP、一堆微信导出图）
得手工重复几十次。这里在不改动官方应用的前提下，注入一个独立的批量面板，
**复用官方的 WASM 编码器**（MozJPEG / WebP / OxiPNG），所以压缩质量与官方一致。

另外官方产物是为 Netlify 打的包，直接丢到 nginx 上会踩一串坑，这里一并修掉。

## 快速开始

```bash
git clone https://github.com/Jieoz/squoosh-cn.git
cd squoosh-cn

# 1) 准备基线产物：编译上游 Squoosh 得到 dist.orig/（见下节）
#    只想直接部署的话下载 release 附件即可，无需这一步

# 2) 配置
cp config.env.example config.env
$EDITOR config.env          # 填域名、部署路径、SSH 信息

# 3) 构建
./build.sh                  # 产出 build/

# 4) 部署
./deploy.sh                 # 打包上传、原子替换、md5 回读校验
```

`config.env` 已被 `.gitignore` 忽略，你的域名和私钥路径不会进 git。

### 准备基线产物

`dist.orig/` 是 Squoosh 的**未打补丁的上游编译产物**（82 个文件、约 26 MB，含 WASM），
按仓库体积与上游许可考虑没有入库。

> **只想部署、不改代码？** 直接下载 release 附件 `squoosh-cn-build.tar.gz`，
> 解包上传即可，**不需要** `dist.orig`，也不需要跑 `build.sh`。
> 那个附件是已打好补丁的成品，不能当 `dist.orig` 用（补丁不可二次施加，
> `build.sh` 会预检并拒绝）。默认基路径 `/squoosh-cn/`、og:image 指向
> `https://example.com`；要换成自己的域名就走下面的自编译路线。

自己编译上游：

```bash
git clone https://github.com/GoogleChromeLabs/squoosh.git
cd squoosh && npm ci
# 部署到子路径时设置前缀，例如 /squoosh-cn/
npx del-cli .tmp/build && npx rollup -c --environment PATH_PREFIX:/squoosh-cn/
cp -a .tmp/build/static ../squoosh-cn/dist.orig
```

编译时用的前缀要写进 `config.env` 的 `SQ_SOURCE_BASE_PATH`。

## 配置项

| 变量 | 说明 |
|---|---|
| `SQ_SITE_ORIGIN` | 站点源，如 `https://example.com`。写入 og:image / canonical |
| `SQ_BASE_PATH` | 部署到站点下的哪个路径，如 `/squoosh-cn/`。根目录填 `/` |
| `SQ_SOURCE_BASE_PATH` | `dist.orig/` 是按哪个前缀编译的 |
| `SQ_SSH_HOST` | 部署目标，`user@host` |
| `SQ_SSH_KEY` | SSH 私钥路径 |
| `SQ_REMOTE_ROOT` | 服务器上的站点根目录 |
| `SQ_REMOTE_OWNER` | 部署后 chown 给谁，如 `www-data:www-data`，留空不改 |

`SQ_BASE_PATH` 与 `SQ_SOURCE_BASE_PATH` 不同时，`tools/rebase_path.py` 会把产物里
烙死的旧前缀全部改掉 —— 官方产物把它硬写进 `manifest.json`、`serviceworker.js`
和各 WASM glue chunk 共 23 个文件 211 处，只改 `index.html` 会让 service worker
预缓存和 manifest 图标全部 404。

## nginx 配置（必须）

`nginx/` 目录下有现成的配置片段。**COOP/COEP 是硬要求**：
官方产物靠 Netlify 的 `_headers` 文件下发这两个头，nginx 不读该文件；
缺了 cross-origin isolation 就没有 `SharedArrayBuffer`，
AVIF / JPEG XL / WebP v2 的多线程 WASM 编码器会退化甚至失败。

```bash
# 1) 放置 COOP/COEP snippet
sudo cp nginx/squoosh-cn-headers.conf /etc/nginx/snippets/

# 2) 把 location 块插入你的 server 块（幂等，可反复跑）
sudo python3 nginx/insert_nginx_block.py \
  /etc/nginx/sites-available/your-site nginx/squoosh-cn.conf

sudo nginx -t && sudo nginx -s reload
```

部署到别的路径时，`nginx/squoosh-cn.conf` 里的 `/squoosh-cn/` 要一起改。

验证：

```bash
curl -sI https://example.com/squoosh-cn/ | grep -i cross-origin
# 应看到 Cross-Origin-Embedder-Policy / Cross-Origin-Opener-Policy
```

浏览器控制台里 `crossOriginIsolated` 应为 `true`。

## 批量压缩面板

首页右下角「批量压缩」按钮打开，或者直接往页面上拖 ZIP / 多个文件。

- **输入**：多张图片，或含图片的 ZIP（保留目录结构）
- **输出格式**：MozJPEG / WebP / OxiPNG
- **分辨率**：保持原始 / 3840 / 2560 / 1920 / 1280 / 800 px / 自定义长边。
  按长边等比缩放，只缩不放
- **质量**：滑块（OxiPNG 为无损，自动隐藏）
- **结果**：逐项列出原始体积 → 压缩后体积、缩放前后尺寸、节省比例，
  打包成 ZIP 下载
- ZIP 输入会自动跳过 `__MACOSX/`、`._*`、`.DS_Store`、0 字节文件与非图片，
  并在重名时自动加后缀而不是互相覆盖
- 可中途「停止」，已完成的部分照样能下载

单张图片仍然交给官方编辑器（那才是它的强项：实时对比、逐参数调）。

### 内存与超时保护

大图（微信导出图动辄几千万像素）解码成 RGBA 要几百 MB 到 1 GB 以上，
低配设备上 worker 会被系统直接杀掉。而**被杀掉的 worker 是完全静默的** ——
`message` / `error` / `messageerror` 三个事件一个都不触发，
naive 的实现会永久挂起（进度条停在第一张不动）。

本实现的对策：

- 每张编码带看门狗超时（`45s + 3s/百万像素`），超时即杀掉重建 worker、
  该张记失败、**队列继续**
- `CodecWorker.terminate()` 主动 reject 所有待决调用，不留悬空 Promise
- 解码时按目标尺寸缩放绘制，全尺寸 RGBA 从不分配
- 硬上限 4000 万像素：即使选「保持原始尺寸」也会降采样，否则浏览器必崩
- ZIP 流式逐张解压，不把整包一次性 materialize 进内存

实测编码门槛（内存宽裕的桌面机）：108MP 成功、192MP `exit(1)`、300MP wasm `abort()`。

## 修掉的部署问题

| # | 问题 | 后果 |
|---|---|---|
| 1 | `_headers` 是 Netlify 格式，nginx 不读 | 无 COOP/COEP → 无 `SharedArrayBuffer` → 多线程编码器失效 |
| 2 | 批量面板早期版本用 `canvas.toBlob` | PNG 输入体积**放大** 316%–1292% |
| 3 | ZIP 内重名文件 | 互相覆盖，静默丢文件 |
| 4 | `__MACOSX` / `._*` / `.DS_Store` / 0 字节 | 被当成图片处理并报失败 |
| 5 | 压缩结果比原图大 | 不回退，越压越大 |
| 6 | `editor/index.html` 是首页的独立拷贝 | 直链 `/editor/` 拿到未打补丁的旧版 |
| 7 | `?v=` 写死 + `/c/` immutable 长缓存 | 改了内容浏览器也不重取 → 改成内容 md5 |
| 8 | Google Analytics | 第三方请求，国内网络白等超时 |
| 9 | `canonical` 指向官方站 | 搜索引擎把本站当官方站的重复内容 |
| 10 | `og:description` 是英文原文 | 分享卡片文案不对 |
| 11 | 面板 append 到 `body` 末尾 | 官方 `#app` 是 `position:absolute` 全屏层、`body` 又 `overflow:hidden`，面板被完全遮盖 → 改成 fixed 浮层 |
| 12 | worker 被 OOM 杀掉静默无事件 | 队列永久挂起 → 看门狗 + 主动 reject |
| 13 | 基路径烙进 23 个文件 | 换部署路径后 SW 预缓存与 manifest 全 404 → `rebase_path.py` |

## 目录结构

```
src/batch-cn.js            批量压缩面板（唯一的自研前端代码）
build.sh                   从 dist.orig 生成 build，带校验断言
deploy.sh                  原子替换部署 + md5 回读校验 + 保留 .prev 回滚
config.env.example         配置模板
tools/i18n_patch.py        编辑器界面汉化（白名单式替换）
tools/site_patch.py        去 GA、修 og/canonical、bump service worker
tools/rebase_path.py       重写产物里烙死的部署基路径
tools/scan_strings*.py     从产物里提取待汉化界面串（开发辅助）
nginx/squoosh-cn.conf      location 块（COOP/COEP + 分级缓存）
nginx/squoosh-cn-headers.conf   COOP/COEP snippet
nginx/insert_nginx_block.py     幂等插入 location 块
dist.orig/                 官方产物基线（不入库，见「准备基线产物」）
build/                     构建输出（不入库）
```

## 回滚

`deploy.sh` 会把上一版留成 `<name>.prev`：

```bash
ssh user@host "cd /var/www/html && rm -rf squoosh-cn && mv squoosh-cn.prev squoosh-cn"
```

## 已知非缺陷

- 直接访问 `<base>editor/` 且没有图片时渲染的是首页介绍页 —— 官方 SPA 行为，
  批量面板据此按 DOM 介绍页标记判断可见性，不用 pathname
- OxiPNG 是无损压缩，质量滑块对它无效（面板会自动隐藏）
- 小图（几百 KB 以下）压缩收益有限，甚至可能变大；勾选「结果更大时保留原图」即可

## 许可与致谢

- 上游 [GoogleChromeLabs/squoosh](https://github.com/GoogleChromeLabs/squoosh)，
  Apache License 2.0。本仓库不重新分发上游源码，
  只提供针对其**编译产物**的部署补丁与自研批量面板。
- 本仓库自有代码（`src/`、`tools/`、`nginx/`、构建与部署脚本）同样以
  Apache License 2.0 提供，见 [LICENSE](LICENSE)。
- 批量面板依赖 [JSZip](https://stuk.github.io/jszip/)（MIT）。
