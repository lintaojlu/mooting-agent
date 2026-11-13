import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCOUNTS = Object.freeze(['nil', 'zoe', 'john', 'yanyi', 'fengshuai', 'yuxia', 'zhaoxin', 'olsen']);
const PASSWORD_DIGEST = createHash('sha256').update('mooting@2026', 'utf8').digest();
const COOKIE = 'mooting_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeBase(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') return '';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  if (!/^\/[A-Za-z0-9/_-]+$/.test(withSlash) || withSlash.includes('//')) throw new Error('MOOTING_BASE_PATH 只能包含字母、数字、斜杠、下划线和连字符');
  return withSlash.replace(/\/$/, '');
}

export function publicHostList(value) {
  return [...new Set(String(value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
}

function digest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

/** Shared team password. The digest comparison does not reveal which field failed. */
export function credentialsMatch(username, password) {
  const name = String(username ?? '').trim().toLowerCase();
  const passwordOk = timingSafeEqual(digest(password), PASSWORD_DIGEST);
  return passwordOk && ACCOUNTS.includes(name) ? name : '';
}

export function forwardedProto(req) {
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
}

export function hostDecision(req, publicHosts) {
  const host = String(req.headers.host ?? '');
  if (/^127\.0\.0\.1:\d+$/.test(host)) return { ok: true, host, hostname: '127.0.0.1', loopback: true };
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (hostname && publicHosts.includes(hostname)) return { ok: true, host, hostname, loopback: false };
  return { ok: false, host, hostname, loopback: false };
}

export function originAllowed(req, decision) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (decision.loopback) return origin === `http://${decision.host}`;
  const proto = forwardedProto(req);
  if (proto === 'https' || proto === 'http') return origin === `${proto}://${decision.hostname}`;
  return origin === `https://${decision.hostname}` || origin === `http://${decision.hostname}`;
}

export function socketAllowed(req, publicHosts) {
  const decision = hostDecision(req, publicHosts);
  if (!decision.ok || !req.headers.origin) return false;
  return originAllowed(req, decision);
}

export function createAccess({ basePath = '', publicHosts = [], auth = false } = {}) {
  const sessions = new Map();
  const failures = new Map();
  const base = normalizeBase(basePath);
  const readCookie = req => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const text = part.trim();
      const eq = text.indexOf('=');
      if (eq > 0 && text.slice(0, eq) === COOKIE) return decodeURIComponent(text.slice(eq + 1));
    }
    return '';
  };
  return {
    base, auth, publicHosts,
    clientIp(req) {
      if (req.socket?.remoteAddress === '127.0.0.1' && req.headers['x-real-ip']) return String(req.headers['x-real-ip']).split(',')[0].trim();
      return req.socket?.remoteAddress || 'unknown';
    },
    tooMany(ip) {
      const row = failures.get(ip);
      return Boolean(row && row.reset > Date.now() && row.count >= 20);
    },
    fail(ip) {
      const now = Date.now();
      const row = failures.get(ip);
      if (!row || row.reset <= now) failures.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
      else row.count += 1;
    },
    clearFailures(ip) { failures.delete(ip); },
    sessionUser(req) {
      if (!auth) return 'local';
      const token = readCookie(req);
      const row = token ? sessions.get(token) : undefined;
      if (!row || row.expires <= Date.now()) { if (token) sessions.delete(token); return ''; }
      return row.username;
    },
    issue(res, username, secure) {
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { username, expires: Date.now() + SESSION_MS });
      const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Lax', `Path=${base || '/'}`, `Max-Age=${SESSION_MS / 1000}`];
      if (secure) parts.push('Secure');
      res.setHeader('Set-Cookie', parts.join('; '));
    },
    clearCookie(res, req, secure) {
      const token = readCookie(req);
      if (token) sessions.delete(token);
      const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Lax', `Path=${base || '/'}`, 'Max-Age=0'];
      if (secure) parts.push('Secure');
      res.setHeader('Set-Cookie', parts.join('; '));
    },
  };
}

export function loginDocument(base) {
  const root = base || '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>登录</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fafafa; color: #171717; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    main { width: min(420px, calc(100% - 32px)); }
    .mark { margin: 0 0 14px; font-size: 28px; line-height: 1; font-weight: 500; color: #171717; }
    form { border: 1px solid #dedede; border-radius: 6px; padding: 22px 22px 18px; background: #ffffff; }
    h1 { margin: 0; font-size: 16px; font-weight: 600; }
    p { margin: 8px 0 0; color: #666666; font-size: 13px; line-height: 1.7; }
    label { display: block; margin-top: 16px; font-size: 13px; color: #171717; }
    input { display: block; width: 100%; margin-top: 6px; border: 1px solid #cccccc; border-radius: 4px; padding: 10px 12px; background: #ffffff; color: #171717; font: inherit; }
    input:focus { outline: none; border-color: #171717; box-shadow: 0 0 0 1px #171717; }
    .error { min-height: 1.7em; margin: 12px 0 0; color: #171717; }
    .error:not(:empty) { padding: 8px 12px; border: 1px solid #cccccc; border-left: 3px solid #171717; background: #f0f0f0; }
    button { margin-top: 8px; width: 100%; border: 0; border-radius: 6px; padding: 10px 12px; background: #171717; color: #ffffff; font: inherit; font-weight: 600; cursor: pointer; }
    button:hover:not(:disabled) { background: #383838; }
    button:disabled { opacity: .45; cursor: progress; }
    button:focus-visible { outline: 2px solid #171717; outline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <p class="mark" aria-hidden="true">(ovo)</p>
    <form id="login" data-action="${root}/api/login" data-next="${root}/">
      <h1>进入工作台</h1>
      <p>使用分配的账号和密码。</p>
      <label>账号<input name="username" autocomplete="username" required></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
      <p id="error" class="error" role="alert"></p>
      <button type="submit">进入</button>
    </form>
  </main>
  <script src="${root}/login.js"></script>
</body>
</html>`;
}
