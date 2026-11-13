/**
 * 每日签到。
 *
 * 领取接口是 `/alice/ug/campaign/item/reward/claim/`，不是 landing/checkin。
 * 之前试 landing/checkin 一直拿 710010702，是因为那条路对 Web 侧关着；
 * 而 item/reward/claim 这条路走得通，关键是请求体字段名：
 *   direct 类任务（reward_mode === 2，含 daily_signin）：
 *     { task_id: "", campaign_group_code, campaign_item_code }
 *   task_id 类任务：
 *     { task_id }
 * 用 campaign_code 而不是 campaign_item_code 会得到 710010202。
 *
 * 幂等与风控：先读状态，已签直接返回；领取前落一个按北京日分日的原子保留记录，
 * 结果不确定就只查不重提，避免重复领取和失败重试的风控特征。
 */
import { ProviderError } from './errors.mjs'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 签到活动组。账号没有投放时 launch 会返回空，必须先读再用 */
export const CAMPAIGN_SCENE = 'pc_incentive_task_mvp_v3'
/** 签到任务的 campaign_code */
export const SIGNIN_TASK = 'daily_signin'
const DETAIL_PATH = '/alice/ug/campaign/v3/detail/'
const CLAIM_PATH = '/alice/ug/campaign/item/reward/claim/'

/** 从 launch 里读这个账号实际投放的活动组 */
export function campaignGroup(launch) {
  return String(launch?.ug_campaign_info?.campaign_group_code ?? '').trim()
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** 北京时间分日 */
export function beijingDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

/**
 * 从活动详情里读签到任务的状态。
 *
 * 优先找 `daily_signin`；找不到时退而找任何一个带 `daily_checkin` 的任务。
 * 这样账号换活动组、任务改名时不会直接失效。
 * @returns {{ found: boolean, claimed?: boolean, points?: number, streak?: number, body?: object }}
 */
export function readCheckin(detail) {
  const data = detail?.data ?? detail
  const tasks = Array.isArray(data?.tasks) ? data.tasks
    : Array.isArray(data?.campaign_group?.tasks) ? data.campaign_group.tasks
      : []
  const withDaily = tasks.filter((t) => t?.campaign_code && t?.daily_checkin)
  const task = withDaily.find((t) => t.campaign_code === SIGNIN_TASK) ?? withDaily[0]
  if (!task) return { found: false }

  const daily = task.daily_checkin
  const group = String(task.campaign_group_code ?? CAMPAIGN_SCENE)
  // reward_mode 2 是「直接发额度」，这类用 campaign_item_code 领取
  const direct = Number(task.reward_mode) === 2
  const status = Number(task.task_status)
  const claimable = status === 2 || (direct && [1, 4].includes(status))

  return {
    found: true,
    group,
    claimed: daily.checked_in_today === true,
    points: num(daily.reward?.reward_amount),
    streak: num(daily.continuous_days),
    lastDate: daily.last_checkin_date ? String(daily.last_checkin_date) : undefined,
    claimable,
    body: claimable
      ? (direct
        ? { task_id: '', campaign_group_code: group, campaign_item_code: task.campaign_code }
        : (task.task_id ? { task_id: task.task_id } : undefined))
      : undefined,
  }
}

/** 签到账本目录 */
function ledgerRoot() {
  if (process.env.DOUBAO_WORK_LEDGER) return process.env.DOUBAO_WORK_LEDGER
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'magpie-doubao-work-auth', 'checkin')
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'magpie-doubao-work-auth', 'checkin')
}

async function writeAtomic(path, value) {
  const temp = `${path}.${Date.now()}.tmp`
  await mkdir(ledgerRoot(), { recursive: true, mode: 0o700 })
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}

/**
 * 执行签到。
 * @returns magpie 的 checkin 结果：{ outcome, credit?, streak?, message? }
 */
export async function checkin(session) {
  try {
    await session.ready()

    // 先读这个账号实际投放的活动组。没投放的账号 launch 返回空字符串，
    // 直接拿常量去请求会得到 campaign not found。
    let group = campaignGroup(session.launch)
    if (!group) {
      // session 可能还没拉过 launch（缓存命中时 initialize 不跑）
      try {
        group = campaignGroup(await session.json('/alice/user/launch', {}))
      } catch { /* 下面按未投放处理 */ }
    }
    if (!group) {
      return { outcome: 'inactive', message: '这个账号当前没有投放签到活动' }
    }

    const day = beijingDay()
    const key = createHash('sha256').update(`${session.profile}:${session.uid}`).digest('hex').slice(0, 32)
    const ledgerPath = join(ledgerRoot(), `${key}.json`)

    let ledger = { day }
    try {
      const previous = JSON.parse(await readFile(ledgerPath, 'utf8'))
      if (previous?.day === day) ledger = previous
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return { outcome: 'failed', message: '签到记录读取异常，未提交领取；请检查后再试。' }
      }
    }

    let state
    try {
      state = readCheckin(await session.json(DETAIL_PATH, { campaign_group_code: group }))
    } catch (error) {
      if (error instanceof ProviderError && error.signIn) {
        return { outcome: 'failed', message: `登录已失效：${error.message}` }
      }
      // campaign not found 是「这个账号没被投放」，不是故障
      const text = String(error?.message || '')
      if (/campaign not found/i.test(text) || error?.upstreamCode === 710010404) {
        return { outcome: 'inactive', message: '这个账号当前没有投放签到活动' }
      }
      return { outcome: 'failed', message: `查询签到状态失败：${text.slice(0, 240)}` }
    }

    if (!state.found) return { outcome: 'inactive', message: '当前账号没有每日签到活动' }

    const credit = state.points !== undefined ? { credit: state.points } : {}
    const streak = state.streak !== undefined ? { streak: state.streak } : {}

    if (state.claimed) {
      await writeAtomic(ledgerPath, { day, group: state.group, confirmed: true })
      return { outcome: 'done', ...credit, ...streak, message: `今天已签到${state.streak ? `，连续 ${state.streak} 天` : ''}` }
    }

    // 今天已经提交过但没确认：只查不重提
    if (ledger.pending || ledger.confirmed) {
      return { outcome: 'failed', ...credit, ...streak, message: '今日领取结果待核对，没有重复提交' }
    }
    if (!state.body) {
      return { outcome: 'ineligible', ...credit, ...streak, message: '今日任务尚未满足领取条件' }
    }

    // 原子保留：跨进程/跨宿主只允许提交一次
    const claimFile = join(ledgerRoot(), `${key}.${day}.claim`)
    let reservation
    try {
      await mkdir(ledgerRoot(), { recursive: true, mode: 0o700 })
      reservation = await open(claimFile, 'wx', 0o600)
    } catch (error) {
      if (error.code === 'EEXIST') {
        return { outcome: 'failed', ...credit, ...streak, message: '今日领取已有提交记录，没有重复提交' }
      }
      return { outcome: 'failed', message: '签到提交记录创建失败，未提交领取' }
    }
    try {
      await reservation.writeFile(JSON.stringify({ day, group: state.group, reservedAt: Date.now() }))
      await reservation.sync()
    } finally {
      await reservation.close()
    }

    await writeAtomic(ledgerPath, { day, group: state.group, pending: true, submittedAt: Date.now() })

    let failure
    try {
      await session.request(CLAIM_PATH, state.body, AbortSignal.timeout(30_000))
    } catch (error) {
      failure = error
    }

    if (failure?.status === 429 || Number(failure?.upstreamCode) === 710022004) {
      return { outcome: 'captcha', ...credit, ...streak, message: '上游要求人工验证，今日不再自动提交' }
    }
    if (failure?.signIn) throw failure
    // 回查确认
    let fresh
    try {
      fresh = readCheckin(await session.json(DETAIL_PATH, { campaign_group_code: state.group }))
    } catch { /* 回查失败按未确认处理 */ }

    if (fresh?.claimed) {
      await writeAtomic(ledgerPath, { day, group: state.group, confirmed: true })
      return {
        outcome: 'claimed',
        ...(fresh.points !== undefined ? { credit: fresh.points } : credit),
        ...(fresh.streak !== undefined ? { streak: fresh.streak } : streak),
        message: '签到成功，已回查确认',
      }
    }
    return {
      outcome: 'failed',
      ...credit, ...streak,
      message: failure ? `领取请求失败：${String(failure.message).slice(0, 160)}` : '上游尚未确认领取结果，记录已保留，后续只查不重提',
    }
  } catch (error) {
    return { outcome: 'failed', message: String(error?.message || error).slice(0, 300) }
  }
}

export const _internal = { CLAIM_PATH, DETAIL_PATH, campaignGroup }

