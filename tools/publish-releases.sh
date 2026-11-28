#!/usr/bin/env bash
# 用 releases/*.md 覆盖已有 release 的正文（PATCH），没有的才新建（POST）。
#
# 两个坑，都踩过：
#   1. 按字母序遍历（0.4.1 → 0.4.10 → ... → 0.4.9）会让 0.4.9 最后被写、
#      published_at 最晚，GitHub 就把它当成「最新发行版」。必须按版本号排。
#   2. 只按顺序写还不够稳——显式给最新版传 make_latest=true 才确定。
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

# 按版本号升序遍历，最新版自然排在最后
LATEST=$(ls releases/*.md | sed 's|.*/||; s|\.md$||' | sort -V | tail -1)
echo "最新版：$LATEST"
echo

for ver in $(ls releases/*.md | sed 's|.*/||; s|\.md$||' | sort -V); do
  f="releases/$ver.md"

  rid=$(curl -s --noproxy '*' -H "$AUTH_HEADER" "$API/releases/tags/$ver" \
        | python -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null)

  # 最新版显式标成 latest，其余不碰这个字段（传 false 会把别的版本降级）
  if [ "$ver" = "$LATEST" ]; then
    make_latest=', "make_latest": "true"'
  else
    make_latest=''
  fi

  python -c "
import json,sys,io
payload = {
  'tag_name': sys.argv[1],
  'name': 'v' + sys.argv[1],
  'body': io.open(sys.argv[2], encoding='utf-8').read(),
  'draft': False,
  'prerelease': False,
}
extra = sys.argv[3]
if extra:
    payload['make_latest'] = 'true'
io.open('.rel_body.json','w',encoding='utf-8').write(json.dumps(payload, ensure_ascii=False))
" "$ver" "$f" "$make_latest"

  if [ -n "$rid" ]; then
    method="PATCH"; url="$API/releases/$rid"; want="200"
  else
    method="POST";  url="$API/releases";      want="201"
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
