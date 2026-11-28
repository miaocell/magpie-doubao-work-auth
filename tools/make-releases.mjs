#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里切出每个版本的段落，写成 releases/<tag>.md。
 *
 * 只做切分和标题替换，内容原文照搬——发行说明就是 CHANGELOG 的那一段。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')

// 版本 → commit（从 git log package.json 的历史里手工核对过）
//
// 0.4.0 不在列表里：11-19 那天版本号连改了三次（27f33bc → 70f8c0b → 7aab7c1），
// 最后落到 0.4.1，CHANGELOG 也没有 0.4.0 的段落——它从没作为独立版本发布过。
// 硬造一个只会让发行页多一条和 0.4.1 内容重复的记录。
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

// 按 ## 切段
const sections = new Map()
const parts = changelog.split(/^## /m).slice(1)
for (const part of parts) {
  const nl = part.indexOf('\n')
  const head = part.slice(0, nl).trim()
  const body = part.slice(nl + 1).trim()
  const m = head.match(/^([0-9]+\.[0-9]+(?:\.[0-9x]+)?)/)
  if (m) sections.set(m[1], body)
}

const dir = join(root, 'releases')
if (!existsSync(dir)) mkdirSync(dir)

let written = 0
for (const [version, sha] of TAGS) {
  const key = sections.has(version) ? version : null
  let body = key ? sections.get(key) : null

  // 0.1.x 这种段落名对不上具体版本，单独处理
  if (!body && version === '0.1.0') body = sections.get('0.1.x')

  if (!body) {
    console.error(`✖ ${version} 在 CHANGELOG 里没有对应段落`)
    continue
  }

  const md = `${body}\n\n---\n\n安装：\`magpie\` 里添加供应商，来源填\n\`github:miaocell/magpie-doubao-work-auth#${version}\`\n或直接用主分支 \`github:miaocell/magpie-doubao-work-auth\`。\n`
  writeFileSync(join(dir, `${version}.md`), md)
  written++
}

console.log(`写出 ${written} 份发行说明到 releases/`)
