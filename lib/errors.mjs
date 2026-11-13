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
  710022004: [403, 'captcha_required'], // 风控验证码
  710012004: [429, 'rate_limited'],
};

export function upstreamError(payload, fallbackStatus) {
  const code = payload?.error?.code ?? payload?.error_code ?? payload?.code;
  const message = payload?.error?.message ?? payload?.message ?? payload?.msg ?? '豆包返回未知错误';
  const [status, ourCode] = CODE_MAP[code] || [fallbackStatus || 502, 'upstream_error'];
  const error = new ProviderError(String(message).slice(0, 500), status, ourCode);
  // 只有登录类错误才让 magpie 标记账号；验证码不标记，避免账号被永久停用
  if (ourCode === 'sign_in_required' || ourCode === 'sign_in_expired') error.signIn = 'expired';
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
  return new Response(JSON.stringify(body), { status, headers });
}
