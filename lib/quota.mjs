/**
 * 额度：把豆包工作的订阅概况翻译成 magpie 的 usage 结构。
 *
 * 这是「积分兑换出来用」的关键一环：magpie 的账号卡片、`magpie quota`
 * 和网关的 /v1/magpie/quotas 都读这个返回值，路由也能据此在账号之间挑选，
 * 所以 amount / limit 必须给真实计数，不能拿百分比糊过去。
 */
function num(value) {
  if (value === undefined || value === null || value === '') return undefined
  const result = Number(typeof value === 'string' ? value.replaceAll(',', '') : value)
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

function iso(value) {
  const n = num(value)
  if (!n) return undefined
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

const SECTIONS = [
  ['window_limit_section', '订阅额度'],
  ['incentive_quota_section', '活动赠送'],
  ['enterprise_window_limit_section', '企业额度'],
]

export function normalizeQuota(overview, summary, user, checkin) {
  const sections = SECTIONS.filter(([key]) => (summary?.[key]?.window_limit_groups?.length ?? 0) > 0)
  const subscription = overview?.current_subscription || summary?.current_subscription

  const windows = []
  for (const [key, label] of sections) {
    const section = summary[key]
    // 另一类额度池还有余量时，这个池耗尽不算账号不可用
    const alternative = sections.some(([other]) => other !== key && summary[other]?.usage_exhausted === false)
    for (const group of section.window_limit_groups) {
      const limits = group.window_limits || []
      for (const [index, window] of limits.entries()) {
        const amount = num(window.used_amount)
        const limit = num(window.total_amount)
        const used = num(window.used_percent)
        const end = iso(window.end_time)
        const fmt = (value) => value.toLocaleString('en-US')
        windows.push({
          name: `${group.feature_group_name || label}${limits.length > 1 ? ` · 窗口${window.window_type ?? index + 1}` : ''}`,
          ...(used === undefined ? {} : { used }),
          ...(amount === undefined ? {} : { amount }),
          ...(limit === undefined ? {} : { limit }),
          unit: '积分',
          // 服务端用 less_than_one_percent 表示「不足 1%」，直接采纳而不是自己算
          ...(window.less_than_one_percent === true ? { usedNote: '不足 1%' } : {}),
          display: amount !== undefined && limit !== undefined
            ? `${fmt(amount)} / ${fmt(limit)} 积分`
            : '服务端未提供计数',
          // 活动赠送额度到期不会补，用 runsOutAt；订阅额度用 resetsAt
          ...(end ? (key === 'incentive_quota_section'
            ? { runsOutAt: end, ...(amount !== undefined && limit !== undefined ? { runsOut: Math.max(0, limit - amount) } : {}) }
            : { resetsAt: end }) : {}),
          aside: section.usage_exhausted === true && alternative,
        })
      }
    }
  }

  const unsupported = ['package_entitlement_groups', 'quota_package_entitlement_groups', 'enterprise_package_entitlement_groups']
    .some((key) => (summary?.[key]?.length ?? 0) > 0)

  return {
    plan: subscription?.display?.short_name || subscription?.display?.product_name || '豆包工作',
    user,
    ...(subscription?.end_time ? { until: iso(subscription.end_time) } : {}),
    windows: [...windows, ...(checkin ? checkinWindow(checkin) ?? [] : [])],
    ...(unsupported ? { error: '账号含额外额度包，其字段尚未验证；这里只显示服务端已识别的窗口。' } : {}),
  }
}

/**
 * 把签到状态做成一个额度窗口。
 *
 * 签到只能在豆包电脑版完成（Web 侧被服务端以 710010702 拒绝），所以这里只做
 * 展示：今天签没签、连续几天、能领多少。没签时提示去客户端点一下，
 * 但不会谎报已签，也不会替用户发那些注定失败的请求。
 */
export function checkinWindow(state) {
  if (!state?.found) return undefined
  const note = state.claimed
    ? `今日已签${state.streak ? ` · 连续 ${state.streak} 天` : ''}`
    : `今日未签${state.points ? ` · 可领 ${state.points} 额度` : ''}`
  return [{
    name: `每日签到（${note}）`,
    ...(state.streak !== undefined ? { streak: state.streak } : {}),
    ...(state.points !== undefined ? { credit: state.points } : {}),
    ...(state.claimed ? { usedNote: '已领取' } : { usedNote: '需在豆包电脑版领取' }),
  }]
}

export const _internal = { num, iso }
