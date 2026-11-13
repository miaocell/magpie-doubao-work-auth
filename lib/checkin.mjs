/**
 * 每日签到。
 *
 * 结论先说：**Web 侧签不了**。豆包把签到限死在电脑版客户端里，活动页原文是
 * 「该活动仅支持在豆包电脑版参与」，服务端对 Web 请求一律回 710010702。
 * 这不是签名问题——在浏览器页面上下文里带全部 Cookie 直接调，同样是 710010702。
 *
 * 所以这个钩子只读状态，**不发领取请求**：
 *   - 已签：返回 done，带上连续天数和奖励额度
 *   - 未签：返回 ineligible，说明要去客户端领
 *
 * 为什么不试一次：那个请求 100% 失败，而高频失败请求正是风控最敏感的模式。
 * 对用户账号的保护优先于「看起来努力过了」。
 */
import { ProviderError } from './errors.mjs'

/** 签到活动组。网页版固定这个值 */
export const CAMPAIGN_SCENE = 'pc_incentive_task_mvp_v3'
/** 签到任务的 campaign_code */
export const SIGNIN_TASK = 'daily_signin'
const DETAIL_PATH = '/alice/ug/campaign/v3/detail/'
/** 服务端对 Web 侧签到请求的固定拒绝码 */
const WEB_BLOCKED = 710010702

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 从活动详情里读签到状态。
 * @returns {{ found: boolean, claimed?: boolean, points?: number, streak?: number, group?: string }}
 */
export function readCheckin(detail) {
  const data = detail?.data ?? detail
  const tasks = Array.isArray(data?.tasks) ? data.tasks
    : Array.isArray(data?.campaign_group?.tasks) ? data.campaign_group.tasks
      : []
  const task = tasks.find((t) => t?.campaign_code === SIGNIN_TASK && t?.daily_checkin)
  if (!task) return { found: false }

  const daily = task.daily_checkin
  return {
    found: true,
    group: String(task.campaign_group_code ?? CAMPAIGN_SCENE),
    claimed: daily.checked_in_today === true,
    points: num(daily.reward?.reward_amount),
    streak: num(daily.continuous_days),
    lastDate: daily.last_checkin_date ? String(daily.last_checkin_date) : undefined,
  }
}

/** 只读地报告签到状态，不尝试领取 */
export async function checkin(session) {
  try {
    await session.ready()

    let state
    try {
      state = readCheckin(await session.json(DETAIL_PATH, { campaign_group_code: CAMPAIGN_SCENE }))
    } catch (error) {
      if (error instanceof ProviderError && error.signIn) {
        return { outcome: 'failed', message: `登录已失效：${error.message}` }
      }
      return { outcome: 'failed', message: `查询签到状态失败：${String(error?.message || error).slice(0, 240)}` }
    }

    if (!state.found) {
      return { outcome: 'inactive', message: '当前账号没有每日签到活动' }
    }

    const credit = state.points !== undefined ? { credit: state.points } : {}
    const streak = state.streak !== undefined ? { streak: state.streak } : {}

    if (state.claimed) {
      return { outcome: 'done', ...credit, ...streak, message: `今天已签到${state.streak ? `，连续 ${state.streak} 天` : ''}` }
    }

    return {
      outcome: 'ineligible',
      ...credit, ...streak,
      message: '今日未签。豆包限制签到只能在电脑版客户端完成，请在客户端里点一下',
    }
  } catch (error) {
    return { outcome: 'failed', message: String(error?.message || error).slice(0, 300) }
  }
}

export const _internal = { WEB_BLOCKED }

