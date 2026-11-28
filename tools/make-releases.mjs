#!/usr/bin/env node
/**
 * 生成 releases/<tag>.md。
 *
 * 正文来自 tools/release-notes.mjs，只放用户能感知的改动。
 * 实现细节在 CHANGELOG.md，安装方式在 README，都不在这里重复。
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { NOTES, LATEST } from './release-notes.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

// 版本列表（对照 git log package.json 的历史核对过）
//
// 0.4.8~0.4.13 已合并进 0.5.0：那六个版本是同一天陆续发的，
// 各自只修一处，用户看到的是六条零碎记录，其实是一件事。
// 已发布的旧 release 保留不动，新版本作为当天的完整说明。
const TAGS = [
  '0.1.0', '0.2.0', '0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.4',
  '0.4.1', '0.4.2', '0.4.3', '0.4.4', '0.4.5', '0.4.6', '0.4.7',
  '0.4.8', '0.4.9', '0.4.10', '0.4.11', '0.4.12', '0.4.13', '0.5.0',
]

const dir = join(root, 'releases')
if (!existsSync(dir)) mkdirSync(dir)

let written = 0
for (const version of TAGS) {
  const items = NOTES[version]
  if (!items?.length) {
    console.error(`✖ ${version} 没有摘要`)
    continue
  }
  writeFileSync(join(dir, `${version}.md`), items.map((t) => `- ${t}`).join('\n') + '\n')
  written++
}

for (const v of Object.keys(NOTES)) {
  if (!TAGS.includes(v)) console.warn(`⚠ 摘要含 ${v}，但不在 TAGS 内`)
}

console.log(`写出 ${written} 份，最新 ${LATEST}`)
