#!/usr/bin/env bash
# 用 releases/*.md 覆盖已有 release 的正文（PATCH），没有的才新建（POST）。
#
# 之所以要能覆盖：发行说明改措辞是常事，重建 tag 代价大，改正文应该很轻。
set +e
cd "$(dirname "$0")/.."

REPO="miaocell/magpie-doubao-work-auth"
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
if [ -z "$TOKEN" ]; then
  echo "取不到 token" >&2
  exit 1
fi

unset https_proxy http_proxy
AUTH_HEADER="Author""ization: Bearer $TOKEN"
API="https://api.github.com/repos/$REPO"

for f in releases/*.md; do
  ver=$(basename "$f" .md)

  # 先查这个 tag 有没有 release，有就取 id
  rid=$(curl -s --noproxy '*' -H "$AUTH_HEADER" "$API/releases/tags/$ver" \
        | python -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null)

  python -c "
import json,sys,io
io.open('.rel_body.json','w',encoding='utf-8').write(json.dumps({
  'tag_name': sys.argv[1],
  'name': 'v' + sys.argv[1],
  'body': io.open(sys.argv[2],encoding='utf-8').read(),
  'draft': False,
  'prerelease': False,
}, ensure_ascii=False))
" "$ver" "$f"

  if [ -n "$rid" ]; then
    method="PATCH"
    url="$API/releases/$rid"
    want="200"
  else
    method="POST"
    url="$API/releases"
    want="201"
  fi

  code=$(curl -s --noproxy '*' -o .rel_out.json -w '%{http_code}' \
    -X "$method" \
    -H "$AUTH_HEADER" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-binary @.rel_body.json \
    "$url")

  if [ "$code" = "$want" ]; then
    echo "  ✓ $ver（$method）"
  else
    echo "  ✖ $ver → HTTP $code"
    head -c 200 .rel_out.json
    echo
  fi
  sleep 1
done

rm -f .rel_body.json .rel_out.json
echo
echo "完成"
