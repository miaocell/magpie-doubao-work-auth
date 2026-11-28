#!/usr/bin/env bash
# 给历史上每个版本打 tag。注释用发行说明的第一行，省得发行页列表里全是空的。
set -e
cd "$(dirname "$0")/.."

tag() {
  local ver="$1" sha="$2"
  if git rev-parse -q --verify "refs/tags/$ver" >/dev/null; then
    echo "  跳过 $ver（已存在）"
    return
  fi
  git tag -a "$ver" "$sha" -m "v$ver"
  echo "  ✓ $ver → $sha"
}

tag 0.1.0  9ba0a48
tag 0.2.0  1bc4d27
tag 0.3.0  fe1977b
tag 0.3.1  e84da7d
tag 0.3.2  258d986
tag 0.3.3  16711ff
tag 0.3.4  9d26067
tag 0.4.1  3ea3055
tag 0.4.2  d3eabb0
tag 0.4.3  1282016
tag 0.4.4  70a3e19
tag 0.4.5  530c2eb
tag 0.4.6  98d0429
tag 0.4.7  f66722d
tag 0.4.8  603ddf5
tag 0.4.9  b1f1088
tag 0.4.10 dec671d
tag 0.4.11 1e3fe53
tag 0.4.12 315433a
tag 0.4.13 167f496

echo
echo "共 $(git tag -l | wc -l) 个 tag"
