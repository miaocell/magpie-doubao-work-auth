/**
 * 统一的上游错误。
 *
 * 网关按状态码决定故障切换：401 会把账号标记为需要重新登录，429 会换账号，
 * 403/404 当作「模型被拒」。所以这里必须把豆包的错误码映射准确，
 * 否则一个偶发的限流会把整批账号打成失效。
 */
export class ProviderError extends Error {
  constructor(message, status = 502, code = 'upstream_error', extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 豆包网关错误码 → 我们的状态码 */
const CODE_MAP = {
  710012000: [401, 'sign_in_required'], // user invalid
  710012001: [401, 'sign_in_expired'],  // login invalid / 登录已过期
  710010202: [400, 'invalid_param'],    // common invalid param
  710020202: [400, 'invalid_param'],    // 同一类的业务参数拒绝（常见于会话 id 复用）
  710022004: [403, 'captcha_required'], // 风控验证码
  710012004: [429, 'rate_limited'],
};

/**
 * 上游的错误消息对人没什么用（比如风控拦下来也回 "rate limited"），
 * 加上一句能照着做的提示，不然用户只能看到 rate limited 以为是限流。
 */
const CODE_HINT = {
  captcha_required: '豆包要求人工验证：打开 https://www.doubao.com/chat/ 手动发一句话，过掉验证后再试。',
  invalid_param: '豆包拒绝了请求参数（常见原因是单笔请求过大，插件已自动压缩）。若仍出现，把诊断目录 %LOCALAPPDATA%\\magpie-doubao-work-auth\\diagnostics\\ 下最新的 json 和 magpie 请求记录一起发到插件仓库。',
  rate_limited: '豆包侧限流，稍等一会儿再试。',
};

/**
 * 从风控决定里读出具体原因，给一句对症的话。
 *
 * 上游 `710022004` 都带一个 `decision`（JSON 字符串），里面的 `subtype` 说明为什么拦：
 * 有的是要人工过验证码（`semantic_reasoning`），有的是请求本身不可信。
 * 全按「去网页验证」提示会误导人——那种情况在网页上怎么点都没用。
 */
function challengeHint(payload) {
  let decision;
  const raw = payload?.extra?.decision ?? payload?.decision;
  if (typeof raw === 'string') {
    try { decision = JSON.parse(raw); } catch { decision = undefined; }
  } else if (raw && typeof raw === 'object') {
    decision = raw;
  }
  const subtype = String(decision?.subtype ?? '');
  if (/device|session|fingerprint/i.test(subtype)) {
    return '这次请求缺设备标识，被判定成异常会话。重新登录一次插件（用浏览器登录或粘贴完整 Cookie）通常就好了，去网页点验证没用。';
  }
  if (/rate|frequen|speed/i.test(subtype)) {
    return '请求太密被限流了。停几分钟再用，期间别一直重试——越试恢复越慢。';
  }
  return CODE_HINT.captcha_required;
}

export function upstreamError(payload, fallbackStatus) {
  const code = payload?.error?.code ?? payload?.error_code ?? payload?.code;
  const message = payload?.error?.message ?? payload?.error_msg ?? payload?.message ?? payload?.msg ?? '豆包返回未知错误';
  const [status, ourCode] = CODE_MAP[code] || [fallbackStatus || 502, 'upstream_error'];
  const hint = ourCode === 'captcha_required' ? challengeHint(payload) : CODE_HINT[ourCode];
  const text = hint ? `${message}（${hint}）` : String(message);
  const error = new ProviderError(text.slice(0, 500), status, ourCode);
  // 只有登录类错误才让 magpie 标记账号；验证码不标记，避免账号被永久停用
  if (ourCode === 'sign_in_required' || ourCode === 'sign_in_expired') error.signIn = 'expired';
  // 要求人工验证时，换账号或重试都不会变好，反而每次重试都在加深风控。
  // 标成 refused，magpie 就不会再换账号重试（它默认把 403 当可重试）。
  if (ourCode === 'captcha_required') error.refused = text.slice(0, 200);
  return error;
}

export function errorResponse(error) {
  const status = error instanceof ProviderError ? error.status : 502;
  const code = error instanceof ProviderError ? error.code : 'plugin_error';
  const body = {
    error: {
      message: error?.message || '插件内部错误',
      type: code,
      code,
    },
  };
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (error?.signIn) headers['X-Magpie-Sign-In'] = error.signIn;
  // 风控验证和内容拒绝不是「换个账号就能成」的失败。magpie 默认把 403 一律当作
  // 可换账号重试（fallback.go 的 retryable 对 4xx 一律 true），于是同一个请求会连打
  // 五次，每次都撞在验证上，反而把风控状态越堆越高。
  // 带上 X-Magpie-Refused 后，magpie 走 h.refused 分支、不进 retryable，只失败一次。
  // HTTP 头只能是 ASCII，中文说明得编码后再放。
  if (error?.refused) headers['X-Magpie-Refused'] = encodeURIComponent(String(error.refused).slice(0, 200));
  return new Response(JSON.stringify(body), { status, headers });
}
