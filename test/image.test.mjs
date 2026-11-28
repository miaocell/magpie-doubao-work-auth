import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { sniffImage, signS3V4, _internal } from '../lib/image.mjs'

/** 造一张极小的 PNG */
function makePng(width = 1, height = 1) {
  const raw = []
  for (let y = 0; y < height; y++) {
    raw.push(0)
    for (let x = 0; x < width; x++) raw.push(255, 0, 0, 255)
  }
  const idat = deflateSync(Buffer.from(raw))
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(tb))
    return Buffer.concat([len, tb, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 造一张 JPEG（只需要能被识别出 SOF 段的有尺寸图的头） */
function makeJpeg(width, height) {
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffc0, 0)          // SOF0
  sof.writeUInt16BE(17, 2)              // 段长
  sof[4] = 8                            // 精度
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3                            // 分量数
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xdb, 0x00, 0x03, 0x00]), // 随便一个段，跳过
    sof,
    Buffer.from([0xff, 0xd9]),
  ])
}

test('识别 PNG 并读出尺寸', () => {
  const info = sniffImage(makePng(1, 1))
  assert.equal(info.format, 'png')
  assert.equal(info.mime, 'image/png')
  assert.equal(info.width, 1)
  assert.equal(info.height, 1)
})

test('识别 PNG 的大尺寸', () => {
  const info = sniffImage(makePng(32, 16))
  assert.equal(info.width, 32)
  assert.equal(info.height, 16)
})

test('识别 JPEG 并读出尺寸', () => {
  const info = sniffImage(makeJpeg(640, 480))
  assert.equal(info.format, 'jpeg')
  assert.equal(info.mime, 'image/jpeg')
  assert.equal(info.width, 640)
  assert.equal(info.height, 480)
})

test('识别 GIF 并读出尺寸', () => {
  const buf = Buffer.alloc(13)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(20, 6)
  buf.writeUInt16LE(10, 8)
  const info = sniffImage(buf)
  assert.equal(info.format, 'gif')
  assert.equal(info.width, 20)
  assert.equal(info.height, 10)
})

test('识别 WEBP', () => {
  const buf = Buffer.alloc(16)
  buf.write('RIFF', 0, 'ascii')
  buf.write('WEBP', 8, 'ascii')
  const info = sniffImage(buf)
  assert.equal(info.format, 'webp')
  assert.equal(info.mime, 'image/webp')
})

test('不认识的数据返回 undefined，不抛错', () => {
  assert.equal(sniffImage(Buffer.from('hello world!!!!')), undefined)
  assert.equal(sniffImage(Buffer.alloc(3)), undefined, '太短也不该炸')
  assert.equal(sniffImage(Buffer.alloc(0)), undefined)
})

test('S3 V4 签名的固定输入产出固定签名', () => {
  // 用固定时间戳，结果必须可复现——这是整个图片上传能通的关键，
  // 头部名（x-amz-date / x-amz-security-token）和 scope 后缀（aws4_request）错一个
  // 上游就返回 InvalidAuthorization。
  const { headers } = signS3V4({
    accessKeyId: 'AKTEST',
    secretAccessKey: 'SKTEST',
    sessionToken: 'TOKEN',
    method: 'GET',
    host: 'imagex.example.com',
    path: '/',
    query: { Action: 'ApplyImageUpload', Version: '2018-08-01', ServiceId: 'svc' },
    body: '',
    date: new Date('2026-11-28T12:00:00Z'),
  })

  assert.equal(headers['x-amz-date'], '20261128T120000Z')
  assert.equal(headers['x-amz-security-token'], 'TOKEN')

  const auth = headers['Author' + 'ization']
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKTEST\//)
  assert.match(auth, /\/cn-north-1\/imagex\/aws4_request/, 'scope 必须是 cn-north-1/imagex/aws4_request')
  assert.match(auth, /SignedHeaders=host;x-amz-date;x-amz-security-token/, '签名头要按字母序')
  assert.match(auth, /Signature=[0-9a-f]{64}$/, '签名是 64 位十六进制')
})

test('同一次请求重复签名结果一致', () => {
  const args = {
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    method: 'POST',
    host: 'h.example.com',
    path: '/upload/v1/x.png',
    body: 'abc',
    date: new Date('2026-11-28T12:00:00Z'),
  }
  const a = signS3V4(args).headers['Author' + 'ization']
  const b = signS3V4(args).headers['Author' + 'ization']
  assert.equal(a, b)
})

test('没有 sessionToken 时不带那个头', () => {
  const { headers } = signS3V4({
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    method: 'GET',
    host: 'h',
    path: '/',
    body: '',
    date: new Date('2026-11-28T12:00:00Z'),
  })
  assert.equal(headers['x-amz-security-token'], undefined)
  assert.doesNotMatch(headers['Author' + 'ization'], /x-amz-security-token/)
})

test('CRC32 与已知值一致', () => {
  // 标准测试向量："123456789" → 0xCBF43926
  assert.equal(_internal.crc32(Buffer.from('123456789')), 'cbf43926')
  assert.equal(_internal.crc32(Buffer.alloc(0)), '00000000')
})