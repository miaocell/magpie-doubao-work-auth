#!/usr/bin/env node
/**
 * 生成 releases/<tag>.md。
 *
 * 正文来自 tools/release-notes.mjs（面向用户的一句话摘要），
 * 不是 CHANGELOG——CHANGELOG 是给改代码的人看的，发行页上放签名算法、
 * 错误码这类细节只会把用户淹掉。
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { NOTES, LATEST, installHint } from './release-notes.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

// 版本 → commit（从 git log package.json 的历史里核对过）
//
// 0.4.0 不在列表里：11-19 那天版本号连改三次（27f33bc → 70f8c0b → 7aab7c1），
// 最后落到 0.4.1，从没作为独立版本发布过。
const TAGS = [
  ['0.1.0', '9ba0a48'],
  ['0.2.0', '1bc4d27'],
  ['0.3.0', 'fe1977b'],
  ['0.3.1', 'e84da7d'],
  ['0.3.2', '258d986'],
  ['0.3.3', '16711ff'],
  ['0.3.4', '9d26067'],
  ['0.4.1', '3ea3055'],
  ['0.4.2', 'd3eabb0'],
  ['0.4.3', '1282016'],
  ['0.4.4', '70a3e19'],
  ['0.4.5', '530c2eb'],
  ['0.4.6', '98d0429'],
  ['0.4.7', 'f66722d'],
  ['0.4.8', '603ddf5'],
  ['0.4.9', 'b1f1088'],
  ['0.4.10', 'dec671d'],
  ['0.4.11', '1e3fe53'],
  ['0.4.12', '315433a'],
  ['0.4.13', '167f496'],
]

const dir = join(root, 'releases')
if (!existsSync(dir)) mkdirSync(dir)

let written = 0
for (const [version] of TAGS) {
  const items = NOTES[version]
  if (!items?.length) {
    console.error(`✖ ${version} 没有摘要`)
    continue
  }
  const body = items.map((t) => `- ${t}`).join('\n')
  writeFileSync(join(dir, `${version}.md`), `${body}\n\n---\n\n${installHint(version)}\n`)
  written++
}

// 顺带检查摘要表里有没有多出来的版本
for (const v of Object.keys(NOTES)) {
  if (!TAGS.some(([t]) => t === v)) console.warn(`⚠ 摘要里有 ${v}，但不在 TAGS 里`)
}

console.log(`写出 ${written} 份，最新 ${LATEST}`)
