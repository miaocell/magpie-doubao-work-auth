#!/usr/bin/env bash
# 删掉并重建全部 release，让页面顺序完全按版本号倒序。
#
# 为什么要删了重建：GitHub 页面按 published_at 排，而 PATCH 不更新这个字段。
# 之前按字母序建过一轮（0.4.1、0.4.10…0.4.9），0.4.9 落到了最后，
# 于是它一直排在 0.4.10 前面。只有重新创建才能拿到新的 published_at。
#
# 代价：release ID 变了。没有外链依赖，也没有附件，所以安全。
set +e
cd "$(dirname "$0")/.."

REPO="miaocell/magpie-doubao-work-auth"
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
if [ -z "$TOKEN" ]; then echo "取不到 token" >&2; exit 1; fi
unset https_proxy http_proxy
AUTH_HEADER="Author""ization: Bearer $TOKEN"
API="https://api.github.com/repos/$REPO"

LATEST=$(ls releases/*.md | sed 's|.*/||; s|\.md$||' | sort -V | tail -1)

echo "① 删除现有 release"
for ver in $(ls releases/*.md | sed 's|.*/||; s|\.md$||' | sort -V); do
  rid=$(curl -s --noproxy '*' -H "$AUTH_HEADER" "$API/releases/tags/$ver" \
        | python -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null)
  if [ -z "$rid" ]; then
    echo "  - $ver 本来就没有"
    continue
  fi
  code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
    -X DELETE -H "$AUTH_HEADER" "$API/releases/$rid")
  if [ "$code" = "204" ]; then echo "  ✓ 删除 $ver"; else echo "  ✖ $ver → HTTP $code"; fi
  sleep 1
done

echo
echo "② 按版本号从旧到新重建（这样最新版最后创建，published_at 最晚）"
for ver in $(ls releases/*.md | sed 's|.*/||; s|\.md$||' | sort -V); do
  f="releases/$ver.md"

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
" "$ver" "$f" "$LATEST"

  code=$(curl -s --noproxy '*' -o .rel_out.json -w '%{http_code}' \
    -X POST \
    -H "$AUTH_HEADER" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-binary @.rel_body.json \
    "$API/releases")

  if [ "$code" = "201" ]; then echo "  ✓ $ver"; else
    echo "  ✖ $ver → HTTP $code"; head -c 200 .rel_out.json; echo
  fi
  sleep 1
done

rm -f .rel_body.json .rel_out.json
echo
echo "完成"
