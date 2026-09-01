#!/usr/bin/env bash
# 把 build/ 部署到远端站点目录。
# 原子替换 + 保留上一版为 <name>.prev（可一键回滚）+ 部署后校验 md5。
#
# 需要 config.env（照 config.env.example 复制填写）。
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
[ -f config.env ] && set -a && . ./config.env && set +a

: "${SQ_SSH_HOST:?缺少 SQ_SSH_HOST（见 config.env.example）}"
: "${SQ_SSH_KEY:?缺少 SQ_SSH_KEY（见 config.env.example）}"
: "${SQ_REMOTE_ROOT:?缺少 SQ_REMOTE_ROOT（见 config.env.example）}"
: "${SQ_SITE_ORIGIN:?缺少 SQ_SITE_ORIGIN（见 config.env.example）}"
SQ_BASE_PATH="${SQ_BASE_PATH:-/squoosh-cn/}"
SQ_BASE_PATH="/$(echo "$SQ_BASE_PATH" | sed 's#^/*##; s#/*$##')/"
[ "$SQ_BASE_PATH" = "//" ] && SQ_BASE_PATH="/"

# 远端目录名取自 base path 最后一段；部署到根目录时直接用 SQ_REMOTE_ROOT
NAME=$(basename "$SQ_BASE_PATH")
[ "$SQ_BASE_PATH" = "/" ] && { echo "部署到域名根目录请直接 rsync build/ 到 SQ_REMOTE_ROOT" >&2; exit 1; }

KEY=$(eval echo "$SQ_SSH_KEY")
SSHOPT=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

[ -d build ] || { echo "先跑 ./build.sh" >&2; exit 1; }

tar czf /tmp/squoosh-cn-deploy.tgz -C build .
ssh "${SSHOPT[@]}" "$SQ_SSH_HOST" "
set -e
rm -rf /tmp/sqdeploy && mkdir -p /tmp/sqdeploy && tar xzf - -C /tmp/sqdeploy
${SQ_REMOTE_OWNER:+chown -R $SQ_REMOTE_OWNER /tmp/sqdeploy}
chmod -R a+rX /tmp/sqdeploy
cd '$SQ_REMOTE_ROOT'
rm -rf '$NAME.prev'
[ -d '$NAME' ] && mv '$NAME' '$NAME.prev'
mv /tmp/sqdeploy '$NAME'
find '$NAME' -type f | wc -l
" < /tmp/squoosh-cn-deploy.tgz

echo "--- md5 校验 ---"
FILES="index.html editor/index.html c/batch-cn.js serviceworker.js"
REMOTE=$(ssh "${SSHOPT[@]}" "$SQ_SSH_HOST" "cd '$SQ_REMOTE_ROOT/$NAME' && md5sum $FILES")
LOCAL=$(cd build && md5sum $FILES)
if [ "$(echo "$REMOTE" | awk '{print $1}')" = "$(echo "$LOCAL" | awk '{print $1}')" ]; then
  echo "OK 远端与本地一致"
  echo "$LOCAL"
else
  echo "MISMATCH" >&2; echo "$REMOTE" >&2; echo "$LOCAL" >&2; exit 1
fi

echo "--- 线上响应头（需 COOP/COEP 才能跑多线程 WASM）---"
curl -sI "${SQ_SITE_ORIGIN}${SQ_BASE_PATH}" | tr -d '\r' \
  | grep -iE 'http/|cross-origin|cache-control'
