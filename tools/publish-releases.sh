#!/usr/bin/env bash
# 用 releases/*.md 给每个 tag 建一条 release。
# token 从 git credential 取，不落盘、不打印。
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

  if curl -s --noproxy '*' -H "$AUTH_HEADER" "$API/releases/tags/$ver" | grep -q '"id"'; then
    echo "  跳过 $ver（已有 release）"
    continue
  fi

  # 请求体写文件，别塞进命令行——正文有换行，塞进去 curl 会把 URL 截断
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

  code=$(curl -s --noproxy '*' -o .rel_out.json -w '%{http_code}' \
    -X POST \
    -H "$AUTH_HEADER" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-binary @.rel_body.json \
    "$API/releases")

  if [ "$code" = "201" ]; then
    echo "  ✓ $ver"
  else
    echo "  ✖ $ver → HTTP $code"
    head -c 240 .rel_out.json
    echo
  fi
  sleep 1
done

rm -f .rel_body.json .rel_out.json
echo
echo "完成"
