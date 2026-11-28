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

export function normalizeQuota(overview, summary, user, checkin, cards) {
  const sections = SECTIONS.filter(([key]) => (summary?.[key]?.window_limit_groups?.length ?? 0) > 0)
  const subscription = overview?.current_subscription || summary?.current_subscription
  // 30 天赠送订阅：能读到这个标记才说得清「你已经有赠送权益」。
  // 以前完全不读，界面看起来像没订阅。
  const gifted = overview?.is_membership_gift === true || overview?.data?.is_membership_gift === true

  const windows = []
  // 判断「这个池用光了，但别的池还有余量」时不能只看 usage_exhausted：
  // 实测有的账号活动赠送额度已经 1600/1600（已用 100%），但服务端仍返回
  // usage_exhausted: false。只看这个标志会让 magpie 拿满格的赠送池当总体进度，
  // 界面上显示「几乎用尽」，而订阅额度其实还剩八成 —— issue #20。
  const exhaustedOf = (key) => {
    const section = summary[key]
    if (!section) return false
    if (section.usage_exhausted === true) return true
    // 退一步按窗口实际用量判断：任意一个窗口用满就算这个池尽力了
    for (const group of section.window_limit_groups || []) {
      for (const window of group.window_limits || []) {
        const used = num(window.used_amount)
        const limit = num(window.total_amount)
        if (used !== undefined && limit !== undefined && limit > 0 && used >= limit) return true
        if (num(window.used_percent) === 100) return true
      }
    }
    return false
  }
  for (const [key, label] of sections) {
    const section = summary[key]
    // 另一类额度池还有余量时，这个池耗尽不算账号不可用
    const alternative = sections.some(([other]) => other !== key && !exhaustedOf(other))
    for (const group of section.window_limit_groups) {
      const limits = group.window_limits || []
      for (const [index, window] of limits.entries()) {
        const amount = num(window.used_amount)
        const limit = num(window.total_amount)
        const used = num(window.used_percent)
        const end = iso(window.end_time)
        const fmt = (value) => value.toLocaleString('en-US')
        // 有总量就显示「已用 / 上限」。used_percent 几乎恒存在（赠送套餐恒为 0），
        // 先判它会永远走百分比分支，把 500 的上限藏起来。
        const hasCounts = amount !== undefined && limit !== undefined
        windows.push({
          name: `${group.feature_group_name || label}${limits.length > 1 ? ` · 窗口${window.window_type ?? index + 1}` : ''}`,
          ...(used === undefined ? {} : { used }),
          ...(amount === undefined ? {} : { amount }),
          ...(limit === undefined ? {} : { limit }),
          unit: '积分',
          // 服务端用 less_than_one_percent 表示「不足 1%」，直接采纳而不是自己算
          ...(window.less_than_one_percent === true ? { usedNote: '不足 1%' } : {}),
          display: hasCounts ? `${fmt(amount)} / ${fmt(limit)} 积分` : '服务端未提供计数',
          // 活动赠送额度到期不会补，用 runsOutAt；订阅额度用 resetsAt
          ...(end ? (key === 'incentive_quota_section'
            ? { runsOutAt: end, ...(hasCounts ? { runsOut: Math.max(0, limit - amount) } : {}) }
            : { resetsAt: end }) : {}),
          aside: exhaustedOf(key) && alternative,
        })
      }
    }
  }

  windows.push(...cardWindows(cards))

  const unsupported = ['package_entitlement_groups', 'quota_package_entitlement_groups', 'enterprise_package_entitlement_groups']
    .some((key) => (summary?.[key]?.length ?? 0) > 0)

  return {
    plan: planLabel(subscription, gifted),
    user,
    ...(subscription?.end_time ? { until: iso(subscription.end_time) } : {}),
    windows: [...windows, ...(checkin ? checkinWindow(checkin) ?? [] : [])],
    ...(unsupported ? { error: '账号含额外额度包，其字段尚未验证；这里只显示服务端已识别的窗口。' } : {}),
  }
}

/** 套餐名；赠送订阅加个标记，免得看着像没订阅 */
function planLabel(subscription, gifted) {
  const base = subscription?.display?.short_name || subscription?.display?.product_name || '豆包工作'
  if (!gifted) return base
  return base.includes('赠送') ? base : `${base}（赠送）`
}

/**
 * 把活动赠送卡做成额度窗口。
 *
 * `/alice/commerce/marketing/card/list/` 里的卡不在 overview 里。免费体验账号
 * 常常只有这里存在额度，不读的话界面显示「暂无额度」，实际是有卡的。
 */
export function cardWindows(cards) {
  const list = cards?.data?.cards ?? cards?.cards ?? []
  if (!Array.isArray(list) || !list.length) return []
  return list.map((card) => {
    const track = card.track_params || {}
    const remain = num(track.card_balance)
    const validDays = num(track.valid_days)
    const end = card.expire_time ? iso(Date.parse(card.expire_time)) : undefined
    return {
      name: `${card.source_display_text || '活动赠送'} · ${card.card_key || '额度卡'}`,
      ...(remain === undefined ? {} : { amount: remain }),
      unit: '次',
      ...(end ? { runsOutAt: end } : {}),
      ...(validDays === undefined ? {} : { note: `${validDays} 天有效` }),
      display: remain === undefined ? '服务端未提供计数' : `剩 ${remain} 次`,
      ...(card.usable_on_current_device === false ? { aside: true, usedNote: '当前设备不可用' } : {}),
    }
  })
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
    ...(state.claimed ? { usedNote: '已领取' } : { usedNote: '需去豆包电脑版领' }),
  }]
}

export const _internal = { num, iso }
