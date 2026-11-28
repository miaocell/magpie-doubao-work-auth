#!/usr/bin/env bash
# 同步 release（按版本号升降序，最新版最后创建）。
#
# 三个坑，都踩过：
#   1. 按字母序遍历会让 0.4.9 落到最后、被当成「最新发行版」——必须 sort -V。
#   2. PATCH 不更新 published_at，只改正文修不了排序——要调顺序得删了重建。
#   3. 同一天发的多个版本会让发行页堆满零碎条目。合并过的旧版本在这里删掉。
#
# 用法：
#   bash tools/sync-releases.sh          只补缺的、更新正文
#   bash tools/sync-releases.sh --rebuild 全删重建（排序也一并修正）
set +e
cd "$(dirname "$0")/.."

REPO="miaocell/magpie-doubao-work-auth"
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
if [ -z "$TOKEN" ]; then echo "取不到 token" >&2; exit 1; fi
unset https_proxy http_proxy
AUTH_HEADER="Author""ization: Bearer $TOKEN"
API="https://api.github.com/repos/$REPO"

REBUILD=0
[ "$1" = "--rebuild" ] && REBUILD=1

# 已合并进新版本、不再单独保留的 tag
MERGED="0.4.8 0.4.9 0.4.10 0.4.11 0.4.12 0.4.13"

VERS=$(ls releases/*.md | sed 's|.*/||; s|\.md$||' | sort -V)
LATEST=$(echo "$VERS" | tail -1)
echo "最新版：$LATEST"

release_id() {
  curl -s --noproxy '*' -H "$AUTH_HEADER" "$API/releases/tags/$1" \
    | python -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null
}

delete_release() {
  local rid=$(release_id "$1")
  [ -z "$rid" ] && return
  local code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
    -X DELETE -H "$AUTH_HEADER" "$API/releases/$rid")
  [ "$code" = "204" ] && echo "  ✗ 删除 $1" || echo "  ! 删除 $1 失败 HTTP $code"
  sleep 1
}

create_release() {
  local ver="$1"
  python -c "
import json,sys,io
p = {
  'tag_name': sys.argv[1],
  'name': 'v' + sys.argv[1],
  'body': io.open(sys.argv[2], encoding='utf-8').read(),
  'draft': False,
  'prerelease': False,
}
if sys.argv[1] == sys.argv[3]:
    p['make_latest'] = 'true'
io.open('.rel_body.json','w',encoding='utf-8').write(json.dumps(p, ensure_ascii=False))
" "$ver" "releases/$ver.md" "$LATEST"

  local code=$(curl -s --noproxy '*' -o .rel_out.json -w '%{http_code}' \
    -X POST -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-binary @.rel_body.json "$API/releases")
  [ "$code" = "201" ] && echo "  ✓ $ver" || { echo "  ✖ $ver HTTP $code"; head -c 200 .rel_out.json; echo; }
  sleep 1
}

patch_release() {
  local ver="$1" rid=$(release_id "$1")
  if [ -z "$rid" ]; then create_release "$ver"; return; fi
  python -c "
import json,sys,io
p = {'body': io.open(sys.argv[2], encoding='utf-8').read()}
if sys.argv[1] == sys.argv[3]:
    p['make_latest'] = 'true'
io.open('.rel_body.json','w',encoding='utf-8').write(json.dumps(p, ensure_ascii=False))
" "$ver" "releases/$ver.md" "$LATEST"
  local code=$(curl -s --noproxy '*' -o .rel_out.json -w '%{http_code}' \
    -X PATCH -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-binary @.rel_body.json "$API/releases/$rid")
  [ "$code" = "200" ] && echo "  ✓ $ver（更新）" || { echo "  ✖ $ver HTTP $code"; head -c 200 .rel_out.json; echo; }
  sleep 1
}

if [ "$REBUILD" = "1" ]; then
  echo "① 删除已合并的旧版本"
  for v in $MERGED; do delete_release "$v"; done
  echo "② 按版本号从旧到新重建"
  for v in $VERS; do
    delete_release "$v" >/dev/null
    create_release "$v"
  done
else
  echo "① 清理已合并的旧版本"
  for v in $MERGED; do delete_release "$v"; done
  echo "② 补缺 / 更新正文"
  for v in $VERS; do patch_release "$v"; done
fi

rm -f .rel_body.json .rel_out.json
echo
echo "完成"