/*!
 * Squoosh 中文版 — 批量压缩面板 v4
 *
 * v4 修卡死（用户实测：25.82 MB 的 mmexport 大图卡在「正在压缩 1/14…」不动）：
 *
 *   根因：worker 被浏览器因内存不足杀掉时是**完全静默**的 —— message / error /
 *   messageerror 三个事件一个都不触发（实测 terminate 正在编码的 worker，
 *   12 秒内零事件）。v3 的 worker.call() 只等 message、没有超时也没有死亡检测，
 *   Promise 永不 settle，整条队列就永远停在第 1 张。
 *
 *   实测门槛（本机，内存宽裕）：
 *     108MP（RGBA 412MB）→ 成功 14.2s
 *     192MP（RGBA 732MB）→ ExitStatus exit(1)
 *     300MP（RGBA 1144MB）→ wasm abort()
 *   低配机（目标环境含低配 Chromebook）会在远低于此的量级被系统直接杀掉。
 *
 *   修复：
 *     1. 每张图带看门狗超时（按像素量伸缩），超时即 terminate + 重建 worker，
 *        该图记失败并继续下一张 —— 绝不整队列挂死。
 *     2. 超大图先降采样到安全像素上限再编码：用 drawImage 缩放绘制，
 *        避免为全尺寸分配几百 MB 的 RGBA ImageData。
 *     3. ZIP 改流式：逐张解压，不再一次性把 14 张全 materialize 成 blob 常驻内存。
 *     4. 加「停止」按钮 + 分阶段进度（解压 / 解码 / 编码），不再只有一个静止的数字。
 *     5. 每张编码完主动释放 ImageData / bitmap 引用，降低峰值内存。
 *
 * v3（布局）：右下角固定入口 + 全屏模态浮层。官方页面 html/body 都是
 *   overflow:hidden、#app 是 position:absolute 全屏层，走文档流的面板用户
 *   既滚不到也点不到。
 *
 * v2（引擎）：压缩走官方 WASM codec（MozJPEG / WebP / OxiPNG），不用
 *   canvas.toBlob（canvas 重编码在 PNG 输入上会把体积放大数倍到十几倍）；
 *   保留 ZIP 内目录结构修重名覆盖；过滤 __MACOSX / ._xxx / .DS_Store / 0 字节；
 *   结果比原图大时保留原图；jszip 绝对路径注入。
 */
(function () {
  'use strict';

  /* 部署基路径：从本脚本自身的 URL 反推（本文件位于 <base>/c/batch-cn.js），
     这样换部署路径（根目录或任意子路径）都不用改代码。 */
  var BASE = (function () {
    var el = document.currentScript;
    if (!el) {
      var all = document.querySelectorAll('script[src*="batch-cn.js"]');
      el = all[all.length - 1];
    }
    if (el && el.src) {
      var p = new URL(el.src, location.href).pathname;   // …/c/batch-cn.js
      var i = p.lastIndexOf('/c/');
      if (i >= 0) return p.slice(0, i + 1);              // …/
    }
    return '/';
  })();
  var WORKER_URL = BASE + 'c/features-worker-2c1c1edc.js';
  var JSZIP_URL = BASE + 'c/jszip.min.js';
  var Z = 2147483000;

  /* 安全像素上限：RGBA 内存 = 像素 × 4 字节。
     40MP ≈ 160MB，本机实测 108MP 才开始吃紧，但目标环境含低配设备，
     取 40MP 留足余量；超过就降采样，长边等比缩小。 */
  var MAX_PIXELS = 40e6;
  /* 看门狗：基础 45s，再按像素量给 3s/MP。40MP 图 ≈ 165s 预算。 */
  var TIMEOUT_BASE = 45000;
  var TIMEOUT_PER_MP = 3000;

  var L = {
    entry: '批量压缩',
    h2: '批量压缩',
    p: '多张图片或 ZIP 压缩包（递归读取子目录）。使用与官方编辑器相同的 MozJPEG / WebP / OxiPNG WASM 编码器，全程在本地完成，图片不会上传。',
    dropTitle: '把图片或 ZIP 拖到这里',
    dropSub: '也可以点击选择 · 支持整个 ZIP 压缩包',
    dropActive: '松手即可开始',
    clear: '清空',
    stop: '停止',
    download: '下载全部 ZIP',
    close: '关闭',
    out: '输出格式',
    resize: '分辨率',
    resizeOrig: '保持原始尺寸',
    resizeCustom: '自定义长边…',
    resizeHint: '长边像素',
    quality: '质量',
    keepBigger: '压缩后变大时保留原图',
    scanning: '正在读取文件列表…',
    unpacking: '正在解压',
    none: '没有找到可压缩的图片',
    stageRead: '解压中',
    stageDecode: '解码中',
    stageEncode: '编码中',
    done: '完成',
    stopped: '已停止',
    ok: '成功',
    fail: '失败',
    skipped: '保留原图',
    zhang: '张',
    saving: '省',
    bigger: '增',
    kept: '原图',
    scaled: '已缩放',
    timeout: '超时（图片过大，已跳过）',
    oom: '内存不足（图片过大）',
    zipname: 'squoosh-批量压缩.zip',
    packing: '正在打包 ZIP…',
    totalLine: '总计',
    pngNote: 'PNG 为无损优化，不受质量滑杆影响。',
    bigNote: '超过 40 兆像素的图片会先等比缩小再压缩，否则浏览器会因内存不足直接崩掉。'
  };

  var IMG_RE = /\.(png|jpe?g|webp|avif|gif|bmp)$/i;
  var JUNK_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|\._)/i;

  /* ---------- 官方 features-worker 的极简 comlink 客户端（带看门狗） ---------- */
  function CodecWorker() {
    this._w = null;
    this._seq = 0;
    this._pending = [];      // 待决调用的 reject 回调
  }
  CodecWorker.prototype._start = function () {
    if (!this._w) this._w = new Worker(WORKER_URL);
    return this._w;
  };
  /* terminate 后 worker 不会再发任何事件（message / error / messageerror 全无），
     所以必须在这里主动把待决的 Promise reject 掉，否则调用方永远挂着。
     这正是「停止」按钮点了没反应、以及 OOM 静默死亡卡死队列的同一个根因。 */
  CodecWorker.prototype.terminate = function (reason) {
    if (this._w) { this._w.terminate(); this._w = null; }
    var p = this._pending;
    this._pending = [];
    for (var i = 0; i < p.length; i++) {
      try { p[i](new Error(reason || '已中断')); } catch (e) { /* ignore */ }
    }
  };
  CodecWorker.prototype.call = function (name, args, transfer, timeoutMs) {
    var self = this;
    var w = this._start();
    var id = 'b' + (++this._seq);
    return new Promise(function (resolve, reject) {
      var timer = null;
      var settled = false;
      function cleanup() {
        settled = true;
        if (timer) clearTimeout(timer);
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
        var k = self._pending.indexOf(abort);
        if (k >= 0) self._pending.splice(k, 1);
      }
      function abort(err) {
        if (settled) return;
        cleanup();
        reject(err);
      }
      function onMsg(e) {
        if (!e.data || e.data.id !== id) return;
        cleanup();
        if (e.data.type === 3) {          // comlink THROW
          var v = e.data.value;
          var msg = (v && v.value && v.value.message) || (v && v.message) || '';
          // wasm 侧内存不足表现为 ExitStatus / abort()，翻译成人话
          if (/exit\(|abort|memory|allocation/i.test(msg)) reject(new Error(L.oom));
          else reject(new Error(msg || '编码失败'));
        } else {
          resolve(e.data.value);
        }
      }
      function onErr(e) {
        cleanup();
        self.terminate();
        reject(new Error((e && e.message) || '编码器异常退出'));
      }
      self._pending.push(abort);
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      timer = setTimeout(function () {
        // 看门狗：worker 可能已被系统静默杀掉，杀掉重建并让本张失败
        self.terminate(L.timeout);
      }, timeoutMs || 120000);
      w.postMessage({
        id: id,
        type: 2,                        // APPLY
        path: [name],
        argumentList: args.map(function (v) { return { type: 0, value: v }; })
      }, transfer || []);
    });
  };

  /* ---------- 编码参数（与官方编辑器默认值一致） ---------- */
  function mozjpegOpts(q) {
    return {
      quality: q, baseline: false, arithmetic: false, progressive: true,
      optimize_coding: true, smoothing: 0, color_space: 3, quant_table: 3,
      trellis_multipass: false, trellis_opt_zero: false, trellis_opt_table: false,
      trellis_loops: 1, auto_subsample: true, chroma_subsample: 2,
      separate_chroma_quality: false, chroma_quality: q
    };
  }
  function webpOpts(q) {
    return {
      quality: q, target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50,
      filter_strength: 60, filter_sharpness: 0, filter_type: 1, partitions: 0,
      segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0,
      partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100,
      lossless: 0, exact: 0, image_hint: 0, emulate_jpeg_size: 0, thread_level: 0,
      low_memory: 0, near_lossless: 100, use_delta_palette: 0, use_sharp_yuv: 0
    };
  }

  var FORMATS = {
    jpeg: { codec: 'mozjpegEncode', opts: mozjpegOpts, ext: 'jpg', mime: 'image/jpeg', lossy: true, label: 'JPEG（MozJPEG）' },
    webp: { codec: 'webpEncode', opts: webpOpts, ext: 'webp', mime: 'image/webp', lossy: true, label: 'WebP' },
    png: { codec: 'oxipngEncode', opts: function () { return { level: 2, interlace: false }; }, ext: 'png', mime: 'image/png', lossy: false, label: 'PNG（OxiPNG 无损）' }
  };

  /* ---------- 工具 ---------- */
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function safePath(name) {
    return String(name).replace(/\\/g, '/').replace(/^(\.\.?\/)+/, '').replace(/^\/+/, '')
      .split('/').filter(function (s) { return s && s !== '.' && s !== '..'; }).join('/');
  }
  function swapExt(path, ext) { return path.replace(/\.[^./]+$/, '') + '.' + ext; }
  function uniqueName(used, name) {
    if (!used[name]) { used[name] = 1; return name; }
    var m = name.match(/^(.*?)(\.[^./]+)$/);
    var stem = m ? m[1] : name, tail = m ? m[2] : '';
    var i = 2;
    while (used[stem + '-' + i + tail]) i++;
    var out = stem + '-' + i + tail;
    used[out] = 1;
    return out;
  }
  function idle() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ---------- 输入收集：只列清单，不解压内容（流式） ---------- */
  async function collect(fileList, onProgress) {
    var items = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (/\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
        onProgress(L.unpacking + ' ' + f.name + '…');
        var zip = await JSZip.loadAsync(f);
        var names = Object.keys(zip.files);
        for (var j = 0; j < names.length; j++) {
          var n = names[j], entry = zip.files[n];
          if (entry.dir || JUNK_RE.test(n) || !IMG_RE.test(n)) continue;
          // 只登记引用，真正解压推迟到轮到它时才做（避免 14 张大图一次性常驻内存）
          items.push({
            path: safePath(n),
            size: 0,                    // ZIP 内条目体积在解压后才确定
            fromZip: true,
            get: (function (en) { return function () { return en.async('blob'); }; })(entry)
          });
        }
      } else if (IMG_RE.test(f.name) || /^image\//.test(f.type)) {
        if (!f.size) continue;
        items.push({
          path: safePath(f.webkitRelativePath || f.name),
          size: f.size,
          fromZip: false,
          get: (function (file) { return function () { return Promise.resolve(file); }; })(f)
        });
      }
    }
    return items;
  }

  /* ---------- 解码（按用户设定的长边缩放；并有内存安全上限兜底） ---------- */
  async function decodeToImageData(blob, maxLongEdge) {
    var bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch (e) {
      throw new Error('无法解码（文件损坏或格式不支持）');
    }
    var ow = bmp.width, oh = bmp.height;    // close() 之后就读不到了，先存
    var w = ow, h = oh;
    var scaled = false, byUser = false;

    // 1) 用户指定长边上限（只缩不放）
    if (maxLongEdge && Math.max(ow, oh) > maxLongEdge) {
      var k1 = maxLongEdge / Math.max(ow, oh);
      w = Math.max(1, Math.round(ow * k1));
      h = Math.max(1, Math.round(oh * k1));
      scaled = true; byUser = true;
    }
    // 2) 内存安全兜底：即使用户选了原始尺寸，超大图也必须降下来，否则浏览器直接崩
    if (w * h > MAX_PIXELS) {
      var k2 = Math.sqrt(MAX_PIXELS / (w * h));
      w = Math.max(1, Math.round(w * k2));
      h = Math.max(1, Math.round(h * k2));
      scaled = true;
    }

    var canvas = ('OffscreenCanvas' in self)
      ? new OffscreenCanvas(w, h)
      : (function () { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; })();
    var ctx = canvas.getContext('2d');
    if (!ctx) { if (bmp.close) bmp.close(); throw new Error(L.oom); }
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
    // 缩放绘制：全尺寸 ImageData 从不分配
    ctx.drawImage(bmp, 0, 0, ow, oh, 0, 0, w, h);
    if (bmp.close) bmp.close();
    var id;
    try {
      id = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      throw new Error(L.oom);
    }
    return { data: id.data, width: w, height: h, scaled: scaled, byUser: byUser, origW: ow, origH: oh };
  }

  /* ---------- 状态 ---------- */
  var results = [];
  var worker = new CodecWorker();
  var busy = false;
  var abortFlag = false;
  var els = {};

  var CSS = [
    '#sq-cn-fab{position:fixed;right:20px;bottom:20px;z-index:' + Z + ';display:flex;align-items:center;gap:8px;',
    'border:0;border-radius:999px;background:#ff3385;color:#fff;padding:14px 22px;font-size:15px;font-weight:700;',
    'cursor:pointer;box-shadow:0 8px 30px #ff338566,0 2px 8px #0006;font-family:inherit;line-height:1.2}',
    '#sq-cn-fab:hover{background:#ff1f77}',
    '#sq-cn-fab:focus-visible{outline:3px solid #fff;outline-offset:2px}',
    '#sq-cn-fab[hidden]{display:none}',

    '#sq-cn-modal{position:fixed;inset:0;z-index:' + (Z + 1) + ';background:#08080cf2;backdrop-filter:blur(6px);',
    'overflow:auto;-webkit-overflow-scrolling:touch;padding:32px 16px;font-family:inherit;color:#fff;',
    'font-size:15px;line-height:1.5}',
    '#sq-cn-modal[hidden]{display:none}',
    '#sq-cn-modal *{box-sizing:border-box}',
    '.sq-cn-card{max-width:900px;margin:0 auto;background:#14141c;border:1px solid #ffffff1f;border-radius:20px;',
    'padding:26px 26px 30px;box-shadow:0 30px 90px #000a}',
    '.sq-cn-head{display:flex;align-items:flex-start;gap:16px}',
    '.sq-cn-head h2{margin:0 0 6px;font-size:24px;line-height:1.25}',
    '.sq-cn-lead{margin:0;opacity:.7;font-size:13.5px;line-height:1.65}',
    '.sq-cn-x{margin-left:auto;flex:0 0 auto;border:0;background:#ffffff14;color:#fff;border-radius:10px;',
    'width:38px;height:38px;font-size:20px;cursor:pointer;line-height:1}',
    '.sq-cn-x:hover{background:#ffffff26}',

    '.sq-cn-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;',
    'margin:20px 0 18px;padding:38px 20px;border:2px dashed #ffffff33;border-radius:16px;cursor:pointer;',
    'background:#ffffff08;text-align:center;transition:border-color .15s,background .15s}',
    '.sq-cn-drop:hover{border-color:#ff338599;background:#ff33850f}',
    '.sq-cn-drop.sq-cn-over{border-color:#ff3385;background:#ff338524}',
    '.sq-cn-drop-t{font-size:17px;font-weight:700}',
    '.sq-cn-drop-s{font-size:13px;opacity:.6}',
    '.sq-cn-drop input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',

    '.sq-cn-options{display:flex;gap:20px;flex-wrap:wrap;align-items:center;margin:0 0 8px;font-size:14px}',
    '.sq-cn-options label{display:flex;gap:8px;align-items:center}',
    '.sq-cn-options select{background:#ffffff14;color:#fff;border:1px solid #ffffff2b;border-radius:8px;padding:7px 9px;font:inherit}',
    '.sq-cn-options input[type=number]{background:#ffffff14;color:#fff;border:1px solid #ffffff2b;border-radius:8px;',
    'padding:7px 9px;font:inherit;width:96px}',
    '.sq-cn-options input[type=number][hidden]{display:none}',
    '.sq-cn-options input[type=range]{accent-color:#ff3385}',
    '.sq-cn-note{font-size:12.5px;opacity:.55;min-height:18px;margin:0 0 10px;line-height:1.5}',

    '.sq-cn-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:4px 0 14px}',
    '.sq-cn-actions button{border:0;border-radius:999px;background:#ff3385;color:#fff;padding:11px 20px;',
    'font-weight:700;font-size:14.5px;cursor:pointer;font-family:inherit;line-height:1.2}',
    '.sq-cn-ghost{background:#ffffff18 !important}',
    '.sq-cn-actions button:disabled{opacity:.4;cursor:not-allowed}',
    '#sq-cn-stop[hidden]{display:none}',

    /* 总进度条 */
    '.sq-cn-bar{height:5px;border-radius:3px;background:#ffffff1a;overflow:hidden;margin:0 0 10px;display:none}',
    '.sq-cn-bar.on{display:block}',
    '.sq-cn-bar>i{display:block;height:100%;width:0;background:#ff3385;transition:width .2s}',

    '.sq-cn-status{min-height:22px;margin:0 0 12px;font-size:14px}',
    '#sq-cn-list{display:grid;gap:7px}',
    '.sq-cn-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:14px;align-items:center;',
    'background:#ffffff0d;border-radius:11px;padding:9px 13px;font-size:13.5px}',
    '.sq-cn-row.sq-cn-active{background:#ff33851f}',
    '.sq-cn-row b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}',
    '.sq-cn-good{color:#68f0ae}.sq-cn-bad{color:#ffab91}.sq-cn-kept{color:#ffd479}.sq-cn-work{color:#9ecbff}',
    '.sq-cn-total{margin-top:12px;padding-top:12px;border-top:1px solid #ffffff20;font-weight:700;font-size:14px}',

    '@media(max-width:640px){',
    '#sq-cn-fab{right:14px;bottom:14px;padding:12px 18px;font-size:14px}',
    '#sq-cn-modal{padding:14px 10px}',
    '.sq-cn-card{padding:20px 16px 24px;border-radius:16px}',
    '.sq-cn-head h2{font-size:20px}',
    '.sq-cn-row{grid-template-columns:1fr;gap:3px}',
    '.sq-cn-row b{direction:ltr}',
    '.sq-cn-options{gap:12px}',
    '}'
  ].join('');

  function inject() {
    if (document.getElementById('sq-cn-fab')) return;

    var css = document.createElement('style');
    css.id = 'sq-cn-css';
    css.textContent = CSS;
    document.head.appendChild(css);

    var fab = document.createElement('button');
    fab.id = 'sq-cn-fab';
    fab.type = 'button';
    fab.setAttribute('aria-haspopup', 'dialog');
    fab.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 15V5a2 2 0 0 0-2-2H9"/><rect x="3" y="7" width="12" height="14" rx="2"/>' +
      '<path d="M7 13h4M9 11v4"/></svg><span>' + L.entry + '</span>';
    document.body.appendChild(fab);

    var modal = document.createElement('div');
    modal.id = 'sq-cn-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', L.h2);
    modal.innerHTML =
      '<div class="sq-cn-card">' +
        '<div class="sq-cn-head">' +
          '<div><h2>' + L.h2 + '</h2><p class="sq-cn-lead">' + L.p + '</p></div>' +
          '<button class="sq-cn-x" id="sq-cn-close" type="button" aria-label="' + L.close + '">×</button>' +
        '</div>' +
        '<label class="sq-cn-drop" id="sq-cn-drop">' +
          '<span class="sq-cn-drop-t" id="sq-cn-drop-t">' + L.dropTitle + '</span>' +
          '<span class="sq-cn-drop-s">' + L.dropSub + '</span>' +
          '<input id="sq-cn-files" type="file" multiple accept="image/*,.zip,application/zip">' +
        '</label>' +
        '<div class="sq-cn-options">' +
          '<label>' + L.out +
            '<select id="sq-cn-format">' +
              '<option value="jpeg">' + FORMATS.jpeg.label + '</option>' +
              '<option value="webp">' + FORMATS.webp.label + '</option>' +
              '<option value="png">' + FORMATS.png.label + '</option>' +
            '</select>' +
          '</label>' +
          '<label>' + L.resize +
            '<select id="sq-cn-resize">' +
              '<option value="0">' + L.resizeOrig + '</option>' +
              '<option value="3840">3840 px（4K）</option>' +
              '<option value="2560">2560 px（2K）</option>' +
              '<option value="1920">1920 px（1080p）</option>' +
              '<option value="1280">1280 px</option>' +
              '<option value="800">800 px</option>' +
              '<option value="custom">' + L.resizeCustom + '</option>' +
            '</select>' +
            '<input id="sq-cn-resize-n" type="number" min="64" max="20000" step="1" value="1920" ' +
              'placeholder="' + L.resizeHint + '" hidden>' +
          '</label>' +
          '<label id="sq-cn-qwrap">' + L.quality +
            '<input id="sq-cn-quality" type="range" min="30" max="100" value="75">' +
            '<span id="sq-cn-qv">75</span>' +
          '</label>' +
          '<label><input id="sq-cn-keep" type="checkbox" checked>' + L.keepBigger + '</label>' +
        '</div>' +
        '<div class="sq-cn-note" id="sq-cn-note">' + L.bigNote + '</div>' +
        '<div class="sq-cn-actions">' +
          '<button id="sq-cn-download" type="button" disabled>' + L.download + '</button>' +
          '<button id="sq-cn-stop" type="button" class="sq-cn-ghost" hidden>' + L.stop + '</button>' +
          '<button id="sq-cn-clear" type="button" class="sq-cn-ghost">' + L.clear + '</button>' +
        '</div>' +
        '<div class="sq-cn-bar" id="sq-cn-bar"><i></i></div>' +
        '<div class="sq-cn-status" id="sq-cn-status"></div>' +
        '<div id="sq-cn-list"></div>' +
      '</div>';
    document.body.appendChild(modal);

    els = {
      fab: fab, modal: modal,
      input: modal.querySelector('#sq-cn-files'),
      drop: modal.querySelector('#sq-cn-drop'),
      dropT: modal.querySelector('#sq-cn-drop-t'),
      close: modal.querySelector('#sq-cn-close'),
      dl: modal.querySelector('#sq-cn-download'),
      stop: modal.querySelector('#sq-cn-stop'),
      clear: modal.querySelector('#sq-cn-clear'),
      q: modal.querySelector('#sq-cn-quality'),
      qv: modal.querySelector('#sq-cn-qv'),
      qwrap: modal.querySelector('#sq-cn-qwrap'),
      fmt: modal.querySelector('#sq-cn-format'),
      resize: modal.querySelector('#sq-cn-resize'),
      resizeN: modal.querySelector('#sq-cn-resize-n'),
      keep: modal.querySelector('#sq-cn-keep'),
      list: modal.querySelector('#sq-cn-list'),
      status: modal.querySelector('#sq-cn-status'),
      note: modal.querySelector('#sq-cn-note'),
      bar: modal.querySelector('#sq-cn-bar'),
      barFill: modal.querySelector('#sq-cn-bar > i')
    };
    setup();
  }

  function openModal() { els.modal.hidden = false; els.fab.hidden = true; els.close.focus(); }
  function closeModal() { els.modal.hidden = true; els.fab.hidden = false; }

  function setup() {
    els.fab.addEventListener('click', openModal);
    els.close.addEventListener('click', closeModal);
    els.modal.addEventListener('click', function (e) { if (e.target === els.modal) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !els.modal.hidden) closeModal();
    });

    els.q.addEventListener('input', function () { els.qv.textContent = els.q.value; });
    function syncFormat() {
      var lossy = FORMATS[els.fmt.value].lossy;
      els.qwrap.style.display = lossy ? '' : 'none';
      els.note.textContent = (lossy ? '' : L.pngNote + ' ') + L.bigNote;
    }
    els.fmt.addEventListener('change', syncFormat);
    syncFormat();

    function syncResize() {
      els.resizeN.hidden = (els.resize.value !== 'custom');
    }
    els.resize.addEventListener('change', syncResize);
    syncResize();

    els.clear.addEventListener('click', function () {
      abortFlag = true;
      results = [];
      els.list.innerHTML = '';
      els.status.textContent = '';
      els.dl.disabled = true;
      els.input.value = '';
      els.bar.classList.remove('on');
      worker.terminate();
    });

    els.stop.addEventListener('click', function () {
      abortFlag = true;
      els.stop.disabled = true;
      els.status.textContent = L.stopped + '…';
      worker.terminate(L.stopped);   // 立刻打断当前编码，并让待决 Promise 立即 reject
    });

    els.input.addEventListener('change', function () {
      if (els.input.files && els.input.files.length) run(els.input.files);
    });

    ['dragenter', 'dragover'].forEach(function (t) {
      els.drop.addEventListener(t, function (e) {
        e.preventDefault(); e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        els.drop.classList.add('sq-cn-over');
        els.dropT.textContent = L.dropActive;
      });
    });
    ['dragleave', 'dragend'].forEach(function (t) {
      els.drop.addEventListener(t, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.drop.classList.remove('sq-cn-over');
        els.dropT.textContent = L.dropTitle;
      });
    });
    els.drop.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      els.drop.classList.remove('sq-cn-over');
      els.dropT.textContent = L.dropTitle;
      if (e.dataTransfer && e.dataTransfer.files.length) run(e.dataTransfer.files);
    });
    els.modal.addEventListener('dragover', function (e) { e.preventDefault(); });
    els.modal.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) run(e.dataTransfer.files);
    });

    /* 整页拖放：ZIP 或多文件时接管；单张图片仍归官方编辑器 */
    function wantsBatch(dt) {
      if (!dt) return false;
      var items = dt.items;
      if (items && items.length > 1) return true;
      if (items) for (var i = 0; i < items.length; i++) if (/zip/i.test(items[i].type || '')) return true;
      if (dt.files && dt.files.length > 1) return true;
      if (dt.files) for (var j = 0; j < dt.files.length; j++) if (/\.zip$/i.test(dt.files[j].name)) return true;
      return false;
    }
    window.addEventListener('dragover', function (e) {
      if (els.modal.hidden && wantsBatch(e.dataTransfer)) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }
    }, true);
    window.addEventListener('drop', function (e) {
      if (!els.modal.hidden) return;
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      if (!wantsBatch(e.dataTransfer)) return;
      e.preventDefault(); e.stopPropagation();
      openModal();
      run(e.dataTransfer.files);
    }, true);

    els.dl.addEventListener('click', pack);
  }

  /* ---------- 主流程 ---------- */
  async function run(fileList) {
    if (busy || !fileList || !fileList.length) return;
    busy = true;
    abortFlag = false;
    results = [];
    els.list.innerHTML = '';
    els.dl.disabled = true;
    els.stop.hidden = false;
    els.stop.disabled = false;
    els.bar.classList.add('on');
    els.barFill.style.width = '0%';
    els.status.textContent = L.scanning;

    var fmt = FORMATS[els.fmt.value];
    var quality = Number(els.q.value);
    var keepBigger = els.keep.checked;
    var maxLongEdge = 0;
    if (els.resize.value === 'custom') {
      maxLongEdge = Math.max(0, Math.min(20000, Number(els.resizeN.value) || 0));
      if (maxLongEdge && maxLongEdge < 64) maxLongEdge = 64;
    } else {
      maxLongEdge = Number(els.resize.value) || 0;
    }
    var used = {};
    var okCount = 0, keptCount = 0, failCount = 0, srcTotal = 0, outTotal = 0;

    try {
      var items = await collect(fileList, function (m) { els.status.textContent = m; });
      if (!items.length) { els.status.textContent = L.none; return; }

      for (var i = 0; i < items.length; i++) {
        if (abortFlag) break;
        var it = items[i];

        var row = document.createElement('div');
        row.className = 'sq-cn-row sq-cn-active';
        row.innerHTML = '<b></b><span></span><span></span>';
        row.children[0].textContent = it.path;
        row.children[0].title = it.path;
        row.children[1].textContent = it.size ? fmtBytes(it.size) + ' → …' : '…';
        row.children[2].className = 'sq-cn-work';
        els.list.appendChild(row);

        var stageRow = row, stageIdx = i, stageTotal = items.length;
        var tick = function (stage) {
          els.status.textContent = '正在处理 ' + (stageIdx + 1) + '/' + stageTotal + '：' + stage;
          stageRow.children[2].textContent = stage;
        };
        tick(it.fromZip ? L.stageRead : L.stageDecode);
        els.barFill.style.width = ((i / items.length) * 100).toFixed(1) + '%';
        await idle();   // 让 UI 有机会重绘，进度不再假死

        var srcBlob = null, dec = null;
        try {
          // 1) 取原始字节（ZIP 流式解压，用完即弃）
          srcBlob = await it.get();
          var srcSize = srcBlob.size;
          if (!srcSize) throw new Error('空文件');
          row.children[1].textContent = fmtBytes(srcSize) + ' → …';
          tick(L.stageDecode);
          await idle();

          // 2) 解码（按用户设定缩放；超大图仍有内存兜底）
          dec = await decodeToImageData(srcBlob, maxLongEdge);
          var wasScaled = dec.scaled;
          var dec_byUser = dec.byUser;
          var scaleNote = wasScaled ? ('（' + dec.origW + '×' + dec.origH + ' → ' + dec.width + '×' + dec.height + '）') : '';
          tick(L.stageEncode + (wasScaled ? ' ' + L.scaled : ''));
          await idle();

          // 3) 编码：带看门狗。worker 被 OOM 杀掉是静默的（无 message/error 事件），
          //    只有超时兜底能救回来，否则整条队列永远卡在这一张。
          var px = dec.width * dec.height;
          var budget = TIMEOUT_BASE + (px / 1e6) * TIMEOUT_PER_MP;
          var plain = { data: dec.data, width: dec.width, height: dec.height };
          dec = null;                                  // 提前断引用，降峰值内存
          var buf = await worker.call(fmt.codec, [plain, fmt.opts(quality)], [plain.data.buffer], budget);
          var outBlob = new Blob([buf], { type: fmt.mime });

          var finalBlob = outBlob;
          var finalPath = swapExt(it.path, fmt.ext);
          var wasKept = false;
          // 用户主动要求缩分辨率时，不能回退成原图 —— 那就违背了他的设置
          if (keepBigger && !dec_byUser && outBlob.size >= srcSize) {
            finalBlob = srcBlob; finalPath = it.path; wasKept = true;
          }
          finalPath = uniqueName(used, finalPath);
          results.push({ path: finalPath, blob: finalBlob });

          srcTotal += srcSize;
          outTotal += finalBlob.size;

          row.classList.remove('sq-cn-active');
          row.children[1].textContent = fmtBytes(srcSize) + ' → ' + fmtBytes(finalBlob.size) + scaleNote;
          if (wasKept) {
            row.children[2].className = 'sq-cn-kept';
            row.children[2].textContent = L.kept;
            keptCount++;
          } else {
            var pct = (1 - finalBlob.size / srcSize) * 100;
            row.children[2].className = pct >= 0 ? 'sq-cn-good' : 'sq-cn-bad';
            row.children[2].textContent = (pct >= 0 ? L.saving : L.bigger) + ' ' + Math.abs(pct).toFixed(0) + '%';
            okCount++;
          }
        } catch (e) {
          row.classList.remove('sq-cn-active');
          row.children[1].textContent = (srcBlob ? fmtBytes(srcBlob.size) : (it.size ? fmtBytes(it.size) : '')) + ' → —';
          row.children[2].className = 'sq-cn-bad';
          if (abortFlag) {
            row.children[2].textContent = L.stopped;
          } else {
            row.children[2].textContent = L.fail + '：' + ((e && e.message) || '未知错误');
            failCount++;
          }
          // 超时/崩溃后 worker 已被杀，下一张会自动重建；队列继续，绝不停摆
        } finally {
          srcBlob = null; dec = null;
        }
      }

      els.barFill.style.width = '100%';
      var head = abortFlag ? L.stopped : L.done;
      var parts = [head + '：' + L.ok + ' ' + okCount + ' ' + L.zhang];
      if (keptCount) parts.push(L.skipped + ' ' + keptCount + ' ' + L.zhang);
      if (failCount) parts.push(L.fail + ' ' + failCount + ' ' + L.zhang);
      els.status.textContent = parts.join('，');

      if (results.length) {
        var total = document.createElement('div');
        total.className = 'sq-cn-total';
        var tp = (1 - outTotal / srcTotal) * 100;
        total.textContent = L.totalLine + '：' + fmtBytes(srcTotal) + ' → ' + fmtBytes(outTotal) +
          '（' + (tp >= 0 ? L.saving : L.bigger) + ' ' + Math.abs(tp).toFixed(1) + '%）';
        els.list.appendChild(total);
      }
      els.dl.disabled = !results.length;
    } catch (e) {
      els.status.textContent = (e && e.message) || String(e);
    } finally {
      worker.terminate();
      busy = false;
      abortFlag = false;
      els.stop.hidden = true;
      els.input.value = '';
      setTimeout(function () { els.bar.classList.remove('on'); }, 800);
    }
  }

  async function pack() {
    if (!results.length) return;
    els.dl.disabled = true;
    var old = els.status.textContent;
    els.status.textContent = L.packing;
    try {
      var zip = new JSZip();
      for (var i = 0; i < results.length; i++) zip.file(results[i].path, results[i].blob);
      var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = L.zipname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      els.status.textContent = old;
    } catch (e) {
      els.status.textContent = (e && e.message) || String(e);
    } finally {
      els.dl.disabled = false;
    }
  }

  /* ---------- 启动 ---------- */
  function loadJsZip() {
    return new Promise(function (res, rej) {
      if (typeof JSZip !== 'undefined') return res();
      var s = document.createElement('script');
      s.src = JSZIP_URL;
      s.onload = res;
      s.onerror = function () { rej(new Error('jszip load failed')); };
      document.head.appendChild(s);
    });
  }

  var lastAtIntro = null;
  function syncVisibility() {
    if (!els.fab) return;
    // 介绍页（拖放区）在 DOM 里 = 还没进入图片编辑器。
    // 不能用 pathname 判断：直连 /squoosh-cn/editor/ 且没有图片时渲染的也是介绍页。
    var atIntro = !!document.querySelector('[class*="intro"]');
    if (atIntro === lastAtIntro) return;
    lastAtIntro = atIntro;
    if (atIntro) {
      if (els.modal.hidden) els.fab.hidden = false;
    } else {
      closeModal();
      els.fab.hidden = true;
    }
  }

  function boot() {
    loadJsZip().then(function () {
      inject();
      syncVisibility();
      var app = document.getElementById('app');
      if (app && window.MutationObserver) {
        new MutationObserver(syncVisibility).observe(app, { childList: true, subtree: true });
      }
      window.addEventListener('popstate', syncVisibility);
    }).catch(function (e) { console.error('[squoosh-cn batch]', e); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
