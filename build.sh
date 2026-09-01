#!/usr/bin/env bash
# 从原始产物 dist.orig/ 生成打好补丁的 build/，并做语法与内容校验。
# 幂等：每次都从 dist.orig 重新展开，不会在已打补丁的文件上二次打补丁。
#
# 需要 config.env（照 config.env.example 复制填写），或直接用环境变量提供
# SQ_SITE_ORIGIN / SQ_BASE_PATH。
set -euo pipefail
cd "$(dirname "$0")"

# 读取 config.env 作为默认值；已在环境里显式给出的变量优先（便于一次性覆盖）
_pre_site="${SQ_SITE_ORIGIN:-}"
_pre_base="${SQ_BASE_PATH:-}"
_pre_srcbase="${SQ_SOURCE_BASE_PATH:-}"
# shellcheck disable=SC1091
[ -f config.env ] && set -a && . ./config.env && set +a
[ -n "$_pre_site" ]    && SQ_SITE_ORIGIN="$_pre_site"
[ -n "$_pre_base" ]    && SQ_BASE_PATH="$_pre_base"
[ -n "$_pre_srcbase" ] && SQ_SOURCE_BASE_PATH="$_pre_srcbase"

: "${SQ_SITE_ORIGIN:?缺少 SQ_SITE_ORIGIN（见 config.env.example）}"

norm_path() {   # 归一化成 /xxx/ 或 /
  local p
  p="/$(echo "$1" | sed 's#^/*##; s#/*$##')/"
  [ "$p" = "//" ] && p="/"
  echo "$p"
}
SQ_BASE_PATH=$(norm_path "${SQ_BASE_PATH:-/squoosh-cn/}")
# dist.orig 是按哪个前缀编译的（官方产物里烙死的那个）
SQ_SOURCE_BASE_PATH=$(norm_path "${SQ_SOURCE_BASE_PATH:-/squoosh-cn/}")
export SQ_SITE_ORIGIN SQ_BASE_PATH SQ_SOURCE_BASE_PATH

[ -d dist.orig ] || {
  echo "缺少 dist.orig（Squoosh 官方产物基线）。见 README「准备基线产物」。" >&2
  exit 1
}

rm -rf build
cp -a dist.orig build

# 0) 预检：dist.orig 必须是**未打补丁的上游产物**。
#    Release 附件里的 squoosh-cn-build.tar.gz 是已打好补丁的成品，
#    可直接部署，但不能当 dist.orig 用（补丁不可二次施加）。
if grep -q 'sq-cn-fab' build/c/batch-cn.js 2>/dev/null \
   || ! grep -q 'google-analytics' build/index.html; then
  echo "dist.orig 看起来已经是打过补丁的成品（含批量面板 / 已去 GA）。" >&2
  echo "build.sh 需要未经修改的上游 Squoosh 产物；见 README「准备基线产物」路线 B。" >&2
  echo "如果你只想部署，直接用 release 附件解包上传，不需要跑 build.sh。" >&2
  exit 1
fi

# 1) 批量面板注入
#    ?v= 取自文件内容哈希：/c/ 下是 immutable 长缓存，固定版本号改了内容也不会重取
cp src/batch-cn.js build/c/batch-cn.js
BATCH_VER=$(md5sum src/batch-cn.js | cut -c1-10)
if grep -q 'batch-cn\.js?v=' build/index.html; then
  sed -i "s#batch-cn\.js?v=[0-9a-f]*#batch-cn.js?v=${BATCH_VER}#" build/index.html
else
  # 官方原始产物里没有这个 script，首次构建时插入（用源前缀，稍后统一 rebase）
  sed -i "s#</body>#<script src=\"${SQ_SOURCE_BASE_PATH}c/batch-cn.js?v=${BATCH_VER}\"></script></body>#" build/index.html
fi
grep -q "batch-cn.js?v=${BATCH_VER}" build/index.html \
  || { echo "batch-cn 版本戳未写入" >&2; exit 1; }

# 2) 编辑器界面汉化
python3 tools/i18n_patch.py build/c/Compress-0fa45b75.js build/c/initial-app-66f2784a.js

# 3) 站点级：去 GA、修 og:image / canonical 域名、bump service worker
python3 tools/site_patch.py build

# 4) 把产物里烙死的基路径换成目标基路径
#    官方产物把 /squoosh-cn/ 硬写进 manifest / serviceworker / 各 wasm glue
#    共 23 个文件 211 处，只改 index.html 会让 SW 预缓存与 manifest 图标全 404
python3 tools/rebase_path.py build "$SQ_SOURCE_BASE_PATH" "$SQ_BASE_PATH"

# 5) editor/index.html 必须与首页 index.html 保持同一份
#    （原产物是两份拷贝；只改首页会导致直接访问 <base>editor/ 拿到未打补丁的旧版）
cp build/index.html build/editor/index.html

# 6) 校验
for f in build/c/Compress-0fa45b75.js build/c/initial-app-66f2784a.js \
         build/c/batch-cn.js build/serviceworker.js; do
  node --check "$f"
done
python3 -c "import json,sys; json.load(open('build/manifest.json'))" \
  || { echo "manifest.json 不是合法 JSON" >&2; exit 1; }

test "$(md5sum < build/index.html)" = "$(md5sum < build/editor/index.html)" \
  || { echo "editor/index.html 与 index.html 不一致" >&2; exit 1; }

! grep -q 'google-analytics\|UA-128752250' build/index.html build/editor/index.html \
  build/c/initial-app-66f2784a.js || { echo "GA 残留" >&2; exit 1; }

grep -q "${SQ_SITE_ORIGIN}${SQ_BASE_PATH}c/icon-large-maskable" build/index.html \
  || { echo "og:image 域名未修" >&2; exit 1; }

grep -q '"c/batch-cn.js"' build/serviceworker.js \
  || { echo "serviceworker 预缓存未含 batch-cn.js" >&2; exit 1; }

# 基路径 rebase 生效性：产物内不得残留源前缀（源==目标时这条自然成立）
if [ "$SQ_SOURCE_BASE_PATH" != "$SQ_BASE_PATH" ]; then
  ! grep -rqI -- "$SQ_SOURCE_BASE_PATH" build/ \
    || { echo "基路径 rebase 未彻底：仍有 ${SQ_SOURCE_BASE_PATH} 残留" >&2; exit 1; }
fi
grep -q -- "\"${SQ_BASE_PATH}\"" build/manifest.json \
  || grep -q -- "${SQ_BASE_PATH}c/icon-large" build/manifest.json \
  || { echo "manifest.json 基路径不正确" >&2; exit 1; }

echo "BUILD OK  files=$(find build -type f | wc -l)  site=${SQ_SITE_ORIGIN}${SQ_BASE_PATH}"
