 
import { extractEmail, generateRandomId } from './commonUtils.js';
import { getOrCreateMailboxId, getMailboxIdByAddress, recordSentEmail, updateSentEmail, toggleMailboxPin, 
  listUsersWithCounts, createUser, updateUser, deleteUser, assignMailboxToUser, getUserMailboxes, unassignMailboxFromUser, 
  checkMailboxOwnership, getTotalMailboxCount, cleanupOldMessages, isSenderBlocked, listBlockedSenders, addBlockedSender, deleteBlockedSender, setMessagePinned,
  getAppConfig, setAppConfig } from './database.js';
import { checkCustomRateLimit } from './rateLimit.js';
import { parseEmailBody, extractVerificationCode, extractLoginLink, resolveInlineImages, resolveCidAttachments, extractInlineImages } from './emailParser.js';
import { sendEmailWithAutoResend, sendBatchWithAutoResend, getEmailFromResend, updateEmailInResend, cancelEmailInResend } from './emailSender.js';
import { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup } from './telegram.js';
import logger from './logger.js';

function escapeHtml(str) {
  const s = String(str || '');
  return s.replace(/[&<>]/g, function(ch) {
    if (ch === '&') {
      return '&amp;';
    }
    if (ch === '<') {
      return '&lt;';
    }
    if (ch === '>') {
      return '&gt;';
    }
    return ch;
  });
}

/**
 * 处理API请求
 * @param {Request} request - 请求对象
 * @param {object} db - 数据库对象
 * @param {string|string[]} mailDomains - 邮箱域名
 * @param {object} options - 配置选项
 * @returns {Promise<Response>} 响应对象
 */
export async function handleApiRequest(request, db, mailDomains, options = { resendApiKey: '', adminName: '', r2: null, authPayload: null, mailboxOnly: false, env: null }) {
  const logId = logger.generateLogId ? logger.generateLogId() : `api-${Date.now()}`;
  const url = new URL(request.url);
  const path = url.pathname;
  const isMailboxOnly = !!options.mailboxOnly;
  const RESEND_API_KEY = options.resendApiKey || '';

  // 记录API请求开始
  logger.info('API请求开始', {
    method: request.method,
    path: path,
    query: Object.fromEntries(url.searchParams),
    isMailboxOnly: isMailboxOnly
  }, logId);

  const env = options?.env || {};

  // 邮箱用户只能访问特定的API端点和自己的数据
  if (isMailboxOnly) {
    const payload = getJwtPayload();
    const mailboxAddress = payload?.mailboxAddress;
    const mailboxId = payload?.mailboxId;
    
    // 允许的API端点
    const allowedPaths = ['/api/emails', '/api/email/', '/api/auth', '/api/quota', '/api/mailbox/password'];
    const isAllowedPath = allowedPaths.some(allowedPath => path.startsWith(allowedPath));
    
    if (!isAllowedPath) {
      logger.warn('邮箱用户访问被拒绝', {
        path: path,
        mailboxAddress: mailboxAddress
      }, logId);
      return new Response('访问被拒绝', { status: 403 });
    }
    
    // 对于邮件相关API，限制只能访问自己的邮箱
    if (path === '/api/emails' && request.method === 'GET') {
      const requestedMailbox = url.searchParams.get('mailbox');
      if (requestedMailbox && requestedMailbox.toLowerCase() !== mailboxAddress?.toLowerCase()) {
        logger.warn('邮箱用户尝试访问他人邮箱', {
          requestedMailbox: requestedMailbox,
          userMailbox: mailboxAddress
        }, logId);
        return new Response('只能访问自己的邮箱', { status: 403 });
      }
      // 如果没有指定邮箱，自动设置为用户自己的邮箱
      if (!requestedMailbox && mailboxAddress) {
        url.searchParams.set('mailbox', mailboxAddress);
      }
    }
    
    // 对于单个邮件操作，验证邮件是否属于该用户的邮箱
    if (path.startsWith('/api/email/') && mailboxId) {
      const emailId = path.split('/')[3];
      if (emailId && emailId !== 'batch') {
        try {
          const { results } = await db.prepare('SELECT mailbox_id FROM messages WHERE id = ? LIMIT 1').bind(emailId).all();
          if (!results || results.length === 0) {
            logger.warn('邮件不存在', { emailId: emailId }, logId);
            return new Response('邮件不存在', { status: 404 });
          }
          if (results[0].mailbox_id !== mailboxId) {
            logger.warn('邮箱用户无权访问他人邮件', {
              emailId: emailId,
              userMailboxId: mailboxId,
              actualMailboxId: results[0].mailbox_id
            }, logId);
            return new Response('无权访问此邮件', { status: 403 });
          }
        } catch (e) {
          logger.error('邮件权限验证失败', e, { emailId: emailId }, logId);
          return new Response('验证失败', { status: 500 });
        }
      }
    }
  }

  function getJwtPayload() {
    // 优先使用服务端传入的已解析身份（支持 __root__ 超管）
    if (options && options.authPayload) {return options.authPayload;}
    try {
      const cookie = request.headers.get('Cookie') || '';
      const token = (cookie.split(';').find(s=>s.trim().startsWith('iding-session=')) || '').split('=')[1] || '';
      const parts = token.split('.');
      if (parts.length === 3) {
        const json = atob(parts[1].replace(/-/g,'+').replace(/_/g,'/'));
        return JSON.parse(json);
      }
    } catch (err) { void err; }
    return null;
  }
  function isStrictAdmin() {
    const p = getJwtPayload();
    if (!p) {return false;}
    // 严格管理员：role 为 admin 即视为管理员（不再限定用户名等于 ADMIN_NAME）。
    // 使数据库中以 role=admin 授予的管理员账号（如 chuancey）与 admin 享有相同最高权限、共享全部邮箱。
    return p.role === 'admin';
  }
  
  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const data = enc.encode(String(text || ''));
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {out += bytes[i].toString(16).padStart(2, '0');}
    return out;
  }

  // 返回域名列表给前端
  if (path === '/api/domains' && request.method === 'GET') {
    const domains = Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')];
    logger.info({ logId, action: 'get_domains', result: { count: domains.length } });
    return Response.json(domains);
  }

  if (path === '/api/telegram/status' && request.method === 'GET') {
    try {
      const payload = options?.authPayload || getJwtPayload();
      if (!payload) {
        return new Response('未登录', { status: 401 });
      }
      const role = payload.role || 'user';
      if (role !== 'admin' && role !== 'guest') {
        return new Response('Forbidden', { status: 403 });
      }
      const token = env.TELEGRAM_BOT_TOKEN || '';
      if (!token) {
        return Response.json({ enabled: false, reason: 'TELEGRAM_BOT_TOKEN 未配置' });
      }
      const apiUrl = `https://api.telegram.org/bot${token}/getWebhookInfo`;
      const meUrl = `https://api.telegram.org/bot${token}/getMe`;
      let info, meInfo;
      try {
        const [resp, meResp] = await Promise.all([
          fetch(apiUrl),
          fetch(meUrl)
        ]);
        
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          logger.error({ logId, action: 'telegram_get_webhook_info', status: resp.status, body: text });
          return Response.json({ enabled: true, ok: false, error: `Telegram API HTTP ${resp.status}`, raw: text });
        }
        info = await resp.json();
        
        if (meResp.ok) {
          meInfo = await meResp.json();
        }
      } catch (e) {
        logger.error({ logId, action: 'telegram_get_webhook_info', error: e.message, stack: e.stack });
        return Response.json({ enabled: true, ok: false, error: String(e?.message || e) });
      }
      const result = info && info.result ? info.result : {};
      const me = meInfo && meInfo.result ? meInfo.result : {};
      
      const origin = new URL(request.url).origin;
      const recommendedUrl = new URL('/telegram/webhook', origin).toString();
      let autoSetWebhook = false;
      let autoSetError = '';
      let autoSetCommands = false;
      let autoSetCommandsError = '';
      
      if (!result.url || result.url !== recommendedUrl) {
        try {
          const setUrl = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(recommendedUrl)}`;
          const setResp = await fetch(setUrl);
          if (!setResp.ok) {
            const text = await setResp.text().catch(() => '');
            logger.error({ logId, action: 'telegram_auto_set_webhook', status: setResp.status, body: text });
            autoSetError = `Telegram API HTTP ${setResp.status}`;
          } else {
            let setData = null;
            try {
              setData = await setResp.json();
            } catch (_) {
              setData = null;
            }
            if (setData && setData.ok) {
              autoSetWebhook = true;
              result.url = recommendedUrl;
              logger.info({ logId, action: 'telegram_auto_set_webhook_success', url: recommendedUrl });
            } else {
              const desc = setData && setData.description ? String(setData.description) : '';
              autoSetError = desc || '自动设置 Webhook 失败';
              logger.warn({ logId, action: 'telegram_auto_set_webhook_failed', description: desc });
            }
          }
        } catch (e) {
          autoSetError = String(e && e.message ? e.message : e);
          logger.error({ logId, action: 'telegram_auto_set_webhook_error', error: e.message, stack: e.stack });
        }
      }
      
      try {
        const commands = [
          { command: 'start', description: '显示欢迎信息和命令列表' },
          { command: 'new', description: '创建新邮箱，可加域名参数' },
          { command: 'list', description: '查看当前绑定的邮箱列表' },
          { command: 'latest', description: '查看指定邮箱的最新一封邮件' },
          { command: 'code', description: '快速获取验证码或登录链接' },
          { command: 'emails', description: '列出最近几封邮件概览' },
          { command: 'domains', description: '查看当前可用的域名列表' },
          { command: 'domainstats', description: '查看各域名的使用统计' },
          { command: 'id', description: '查看当前 Chat ID' }
        ];
        const urlSetCommands = `https://api.telegram.org/bot${token}/setMyCommands`;
        const respSetCommands = await fetch(urlSetCommands, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands })
        });
        if (!respSetCommands.ok) {
          const text = await respSetCommands.text().catch(() => '');
          logger.error({ logId, action: 'telegram_auto_set_commands', status: respSetCommands.status, body: text });
          autoSetCommandsError = `Telegram API HTTP ${respSetCommands.status}`;
        } else {
          let dataSetCommands = null;
          try {
            dataSetCommands = await respSetCommands.json();
          } catch (_) {
            dataSetCommands = null;
          }
          if (dataSetCommands && dataSetCommands.ok) {
            autoSetCommands = true;
            logger.info({ logId, action: 'telegram_auto_set_commands_success' });
          } else {
            const desc = dataSetCommands && dataSetCommands.description ? String(dataSetCommands.description) : '';
            autoSetCommandsError = desc || '自动设置命令列表失败';
            logger.warn({ logId, action: 'telegram_auto_set_commands_failed', description: desc });
          }
        }
      } catch (e) {
        autoSetCommandsError = String(e && e.message ? e.message : e);
        logger.error({ logId, action: 'telegram_auto_set_commands_error', error: e.message, stack: e.stack });
      }
      
      const currentUrl = result.url || '';
      const lastErrorDate = result.last_error_date || null;
      const ok = !!currentUrl && !lastErrorDate;
      
      // Mask token
      const tokenMasked = token.length > 10 ? 
        token.substring(0, 5) + '...' + token.substring(token.length - 5) : 
        '******';
        
      return Response.json({
        enabled: true,
        ok,
        url: currentUrl,
        pendingUpdateCount: result.pending_update_count || 0,
        lastErrorDate,
        lastErrorMessage: result.last_error_message || null,
        ipAddress: result.ip_address || '',
        hasCustomCertificate: !!result.has_custom_certificate,
        maxConnections: result.max_connections || null,
        allowedUpdates: result.allowed_updates || null,
        recommendedUrl,
        autoSetWebhook,
        autoSetError,
        autoSetCommands,
        autoSetCommandsError,
        botInfo: {
          id: me.id,
          first_name: me.first_name,
          username: me.username
        },
        tokenMasked,
        chatId: env.TELEGRAM_CHAT_ID || ''
      });
    } catch (e) {
      logger.error({ logId, action: 'telegram_status', error: e.message, stack: e.stack });
      return new Response('查询失败', { status: 500 });
    }
  }

  if (path === '/api/telegram/set-webhook' && request.method === 'POST') {
    try {
      const payload = options?.authPayload || getJwtPayload();
      if (!payload) {
        return new Response('未登录', { status: 401 });
      }
      const role = payload.role || 'user';
      if (role !== 'admin' && role !== 'guest') {
        return new Response('Forbidden', { status: 403 });
      }
      const token = env.TELEGRAM_BOT_TOKEN || '';
      if (!token) {
        return Response.json({ ok: false, message: 'TELEGRAM_BOT_TOKEN 未配置' }, { status: 400 });
      }
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        body = {};
      }
      const origin = new URL(request.url).origin;
      const defaultUrl = new URL('/telegram/webhook', origin).toString();
      const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
      const targetUrl = rawUrl || defaultUrl;
      const apiUrl = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(targetUrl)}`;
      const resp = await fetch(apiUrl);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        logger.error({ logId, action: 'telegram_set_webhook', status: resp.status, body: text });
        return Response.json({ ok: false, message: `Telegram API HTTP ${resp.status}`, raw: text, url: targetUrl }, { status: 502 });
      }
      let data;
      try {
        data = await resp.json();
      } catch (_) {
        data = null;
      }
      const success = !!(data && data.ok);
      if (!success) {
        const desc = data && data.description ? String(data.description) : '';
        logger.warn({ logId, action: 'telegram_set_webhook_failed', description: desc });
        return Response.json({ ok: false, message: desc || '设置 Webhook 失败', url: targetUrl, raw: data }, { status: 502 });
      }
      logger.info({ logId, action: 'telegram_set_webhook_success', url: targetUrl });
      return Response.json({ ok: true, url: targetUrl, result: data });
    } catch (e) {
      logger.error({ logId, action: 'telegram_set_webhook_error', error: e.message, stack: e.stack });
      return new Response('设置 Webhook 失败: ' + (e?.message || e), { status: 500 });
    }
  }

  if (path === '/api/telegram/test' && request.method === 'POST') {
    try {
      const payload = options?.authPayload || getJwtPayload();
      if (!payload) {
        return new Response('未登录', { status: 401 });
      }
      const role = payload.role || 'user';
      if (role !== 'admin' && role !== 'guest') {
        return new Response('Forbidden', { status: 403 });
      }
      const token = env.TELEGRAM_BOT_TOKEN || '';
      if (!token) {
        return Response.json({ ok: false, message: 'TELEGRAM_BOT_TOKEN 未配置' }, { status: 400 });
      }
      let targetChatId = env.TELEGRAM_CHAT_ID ? String(env.TELEGRAM_CHAT_ID) : '';
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        body = {};
      }
      if (body && typeof body.chatId === 'string' && body.chatId.trim()) {
        targetChatId = body.chatId.trim();
      }
      if (!targetChatId) {
        return Response.json({ ok: false, message: 'TELEGRAM_CHAT_ID 未配置，且未提供 chatId' }, { status: 400 });
      }
      const urlSend = `https://api.telegram.org/bot${token}/sendMessage`;
      const text = '✅ Temp-Mail Telegram 连接测试成功！\n\n如果你能看到这条消息，说明 Webhook 与 Bot 配置正常。';
      const resp = await fetch(urlSend, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        logger.error({ logId, action: 'telegram_test_send_error', status: resp.status, body: t });
        return Response.json({ ok: false, message: `Telegram API HTTP ${resp.status}`, raw: t }, { status: 502 });
      }
      let data;
      try {
        data = await resp.json();
      } catch (_) {
        data = null;
      }
      const success = !!(data && data.ok);
      if (!success) {
        const desc = data && data.description ? String(data.description) : '';
        logger.warn({ logId, action: 'telegram_test_send_failed', description: desc });
        return Response.json({ ok: false, message: desc || '发送测试消息失败', raw: data }, { status: 502 });
      }
      logger.info({ logId, action: 'telegram_test_send_success', chatId: targetChatId });
      return Response.json({ ok: true, chatId: targetChatId, result: data });
    } catch (e) {
      logger.error({ logId, action: 'telegram_test_error', error: e.message, stack: e.stack });
      return new Response('发送测试消息失败: ' + (e?.message || e), { status: 500 });
    }
  }

  if (path === '/api/generate') {
    const lengthParam = Number(url.searchParams.get('length') || 0);
    const randomId = generateRandomId(lengthParam || undefined);
    const domains = Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')];
    const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(url.searchParams.get('domainIndex') || 0)));
    const chosenDomain = domains[domainIdx] || domains[0];
    const email = `${randomId}@${chosenDomain}`;
    
    logger.info({ logId, action: 'generate_email', params: { length: lengthParam, domainIndex: domainIdx, chosenDomain } });
    
    // 访客模式不写入历史
    let userId;
    try {
      const payload = getJwtPayload();
      userId = payload?.userId;
      if (userId) {
        // 用户已登录：检查配额并创建邮箱
        const { getCachedUserQuota } = await import('./cacheHelper.js');
        const quota = await getCachedUserQuota(db, userId);
        if (quota.used >= quota.limit) {
          logger.warn({ logId, action: 'generate_email', error: 'quota_exceeded', userId, quota });
          return new Response('已达到邮箱创建上限', { status: 429 });
        }
        // 创建并分配邮箱
        await assignMailboxToUser(db, { userId, address: email });
        logger.info({ logId, action: 'generate_email', result: { userId, email, quotaUsed: quota.used + 1 } });
      } else {
        // 访客模式：直接创建邮箱（不分配）
        await getOrCreateMailboxId(db, email);
        logger.info({ logId, action: 'generate_email', result: { anonymous: true, email } });
      }
    } catch (e) {
      // 如果是邮箱上限错误，返回更明确的提示
      if (String(e?.message || '').includes('已达到邮箱上限')) {
        logger.warn({ logId, action: 'generate_email', error: 'quota_exceeded', message: e.message });
        return new Response('已达到邮箱创建上限', { status: 429 });
      }
      logger.error({ logId, action: 'generate_email', error: e.message, stack: e.stack });
      return new Response(String(e?.message || '生成失败'), { status: 400 });
    }
    return Response.json({ email, expires: Date.now() + 3600000 });
  }

  // ================= 用户管理接口（仅非演示模式） =================
  if (path === '/api/users' && request.method === 'GET') {
    if (!isStrictAdmin()) {
      logger.warn({ logId, action: 'get_users', status: 'forbidden', message: '非严格管理员尝试访问用户列表' });
      return new Response('Forbidden', { status: 403 });
    }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const sort = url.searchParams.get('sort') || 'desc';
    logger.info({ logId, action: 'get_users', params: { limit, offset, sort } });
    try {
      const users = await listUsersWithCounts(db, { limit, offset, sort });
      logger.info({ logId, action: 'get_users', result: { count: users.length } });
      return Response.json(users);
    } catch (e) { 
      logger.error({ logId, action: 'get_users', error: e.message, stack: e.stack });
      return new Response('查询失败', { status: 500 }); 
    }
  }

  if (path === '/api/users' && request.method === 'POST') {
    if (!isStrictAdmin()) {
      logger.warn({ logId, action: 'create_user', status: 'forbidden', message: '非严格管理员尝试创建用户' });
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const body = await request.json();
      const username = String(body.username || '').trim();
      const role = (body.role || 'user') === 'admin' ? 'admin' : 'user';
      const mailboxLimit = Number(body.mailboxLimit || 10);
      const password = String(body.password || '').trim();
      
      if (!username) {
        logger.warn({ logId, action: 'create_user', status: 'bad_request', message: '用户名不能为空' });
        return new Response('用户名不能为空', { status: 400 });
      }
      
      logger.info({ logId, action: 'create_user', params: { username, role, mailboxLimit, hasPassword: !!password } });
      
      let passwordHash = null;
      if (password) { passwordHash = await sha256Hex(password); }
      const user = await createUser(db, { username, passwordHash, role, mailboxLimit });
      logger.info({ logId, action: 'create_user', result: { userId: user.id, username: user.username } });
      return Response.json(user);
    } catch (e) { 
      logger.error({ logId, action: 'create_user', error: e.message, stack: e.stack });
      return new Response('创建失败: ' + (e?.message || e), { status: 500 }); 
    }
  }

  if (request.method === 'PATCH' && path.startsWith('/api/users/')) {
    if (!isStrictAdmin()) {
      logger.warn({ logId, action: 'update_user', status: 'forbidden', message: '非严格管理员尝试更新用户' });
      return new Response('Forbidden', { status: 403 });
    }
    const id = Number(path.split('/')[3]);
    if (!id) {
      logger.warn({ logId, action: 'update_user', status: 'bad_request', message: '无效的用户ID' });
      return new Response('无效ID', { status: 400 });
    }
    try {
      const body = await request.json();
      const fields = {};
      if (typeof body.mailboxLimit !== 'undefined') {fields.mailbox_limit = Math.max(0, Number(body.mailboxLimit));}
      if (typeof body.role === 'string') {fields.role = (body.role === 'admin' ? 'admin' : 'user');}
      if (typeof body.can_send !== 'undefined') {fields.can_send = body.can_send ? 1 : 0;}
      if (typeof body.password === 'string' && body.password) { fields.password_hash = await sha256Hex(String(body.password)); }
      if (typeof body.telegram_chat_id === 'string') {fields.telegram_chat_id = body.telegram_chat_id.trim() || null;}
      if (typeof body.telegram_username === 'string') {fields.telegram_username = body.telegram_username.trim() || null;}
      
      logger.info({ logId, action: 'update_user', params: { userId: id, fields } });
      
      await updateUser(db, id, fields);
      logger.info({ logId, action: 'update_user', result: { userId: id, success: true } });
      return Response.json({ success: true });
    } catch (e) { 
      logger.error({ logId, action: 'update_user', error: e.message, stack: e.stack, userId: id });
      return new Response('更新失败: ' + (e?.message || e), { status: 500 }); 
    }
  }

  if (path === '/api/user/telegram' && request.method === 'GET') {
    try {
      const payload = getJwtPayload();
      const uid = Number(payload?.userId || 0);
      if (!uid) {
        return new Response('未登录', { status: 401 });
      }
      const { results } = await db.prepare('SELECT telegram_chat_id, telegram_username FROM users WHERE id = ? LIMIT 1').bind(uid).all();
      const row = (results && results.length) ? results[0] : {};
      return Response.json({
        telegram_chat_id: row.telegram_chat_id || null,
        telegram_username: row.telegram_username || null
      });
    } catch (e) {
      logger.error({ logId, action: 'get_user_telegram', error: e.message, stack: e.stack });
      return new Response('查询失败', { status: 500 });
    }
  }

  if (path === '/api/user/telegram' && request.method === 'POST') {
    try {
      const payload = getJwtPayload();
      const uid = Number(payload?.userId || 0);
      if (!uid) {
        return new Response('未登录', { status: 401 });
      }
      if (payload?.role === 'guest') {
        return new Response('演示账户无权修改设置', { status: 403 });
      }
      const body = await request.json();
      const chatId = String(body.telegram_chat_id || '').trim();
      const username = String(body.telegram_username || '').trim();
      await updateUser(db, uid, {
        telegram_chat_id: chatId || null,
        telegram_username: username || null
      });
      logger.info({ logId, action: 'update_user_telegram', result: { userId: uid, chatId, username } });
      return Response.json({ success: true });
    } catch (e) {
      logger.error({ logId, action: 'update_user_telegram', error: e.message, stack: e.stack });
      return new Response('更新失败', { status: 500 });
    }
  }

  if (request.method === 'DELETE' && path.startsWith('/api/users/')) {
    if (!isStrictAdmin()) {
      logger.warn({ logId, action: 'delete_user', status: 'forbidden', message: '非严格管理员尝试删除用户' });
      return new Response('Forbidden', { status: 403 });
    }
    const id = Number(path.split('/')[3]);
    if (!id) {
      logger.warn({ logId, action: 'delete_user', status: 'bad_request', message: '无效的用户ID' });
      return new Response('无效ID', { status: 400 });
    }
    logger.info({ logId, action: 'delete_user', params: { userId: id } });
    try { 
      await deleteUser(db, id); 
      logger.info({ logId, action: 'delete_user', result: { userId: id, success: true } });
      return Response.json({ success: true });
    }
    catch (e) { 
      logger.error({ logId, action: 'delete_user', error: e.message, stack: e.stack, userId: id });
      return new Response('删除失败: ' + (e?.message || e), { status: 500 }); 
    }
  }

  if (path === '/api/users/assign' && request.method === 'POST') {
    if (!isStrictAdmin()) {
      logger.warn({ logId, action: 'assign_mailbox', status: 'forbidden', message: '非严格管理员尝试分配邮箱' });
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const body = await request.json();
      const username = String(body.username || '').trim();
      const address = String(body.address || '').trim().toLowerCase();
      if (!username || !address) {
        logger.warn({ logId, action: 'assign_mailbox', status: 'bad_request', message: '参数不完整', params: { username, address } });
        return new Response('参数不完整', { status: 400 });
      }
      logger.info({ logId, action: 'assign_mailbox', params: { username, address } });
      const result = await assignMailboxToUser(db, { username, address });
      logger.info({ logId, action: 'assign_mailbox', result: { username, address, success: true } });
      return Response.json(result);
    } catch (e) { 
      logger.error({ logId, action: 'assign_mailbox', error: e.message, stack: e.stack });
      return new Response('分配失败: ' + (e?.message || e), { status: 500 }); 
    }
  }

  if (path === '/api/users/unassign' && request.method === 'POST') {
    if (!isStrictAdmin()) {
      logger.warn({ logId, action: 'unassign_mailbox', status: 'forbidden', message: '非严格管理员尝试取消分配邮箱' });
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const body = await request.json();
      const username = String(body.username || '').trim();
      const address = String(body.address || '').trim().toLowerCase();
      if (!username || !address) {
        logger.warn({ logId, action: 'unassign_mailbox', status: 'bad_request', message: '参数不完整', params: { username, address } });
        return new Response('参数不完整', { status: 400 });
      }
      logger.info({ logId, action: 'unassign_mailbox', params: { username, address } });
      const result = await unassignMailboxFromUser(db, { username, address });
      logger.info({ logId, action: 'unassign_mailbox', result: { username, address, success: true } });
      return Response.json(result);
    } catch (e) { 
      logger.error({ logId, action: 'unassign_mailbox', error: e.message, stack: e.stack });
      return new Response('取消分配失败: ' + (e?.message || e), { status: 500 }); 
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/users/') && path.endsWith('/mailboxes')) {
    const id = Number(path.split('/')[3]);
    if (!id) {
      logger.warn({ logId, action: 'get_user_mailboxes', error: 'invalid_id', userId: id });
      return new Response('无效ID', { status: 400 });
    }
    logger.info({ logId, action: 'get_user_mailboxes', params: { userId: id } });
    try { 
      const list = await getUserMailboxes(db, id); 
      logger.info({ logId, action: 'get_user_mailboxes', result: { userId: id, count: list?.length || 0 } });
      return Response.json(list || []); 
    }
    catch (e) { 
      logger.error({ logId, action: 'get_user_mailboxes', error: e.message, stack: e.stack, userId: id });
      return new Response('查询失败', { status: 500 }); 
    }
  }

  // 自定义创建邮箱：{ local, domainIndex }
  if (path === '/api/create' && request.method === 'POST') {
    try {
      const body = await request.json();
      const local = String(body.local || '').trim().toLowerCase();
      const valid = /^[a-z0-9._-]{1,64}$/i.test(local);
      if (!valid) {
        logger.warn({ logId, action: 'create_custom_mailbox', status: 'bad_request', message: '非法用户名', local });
        return new Response('非法用户名', { status: 400 });
      }
      const domains = Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')];
      const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(body.domainIndex || 0)));
      const chosenDomain = domains[domainIdx] || domains[0];
      const email = `${local}@${chosenDomain}`;
      
      logger.info({ logId, action: 'create_custom_mailbox', params: { local, domainIdx, email } });
      
      let userId;
      try {
        const payload = getJwtPayload();
        userId = payload?.userId;
        
        // 检查邮箱是否已存在以及权限
        const ownership = await checkMailboxOwnership(db, email, userId);
        
        if (ownership.exists) {
          // 如果邮箱已存在，所有用户（包括超级管理员）都不允许创建
          if (userId && ownership.ownedByUser) {
            logger.warn({ logId, action: 'create_custom_mailbox', status: 'conflict', message: '用户尝试重复创建已拥有的邮箱', userId, email });
            return new Response('邮箱地址已存在，使用其他地址', { status: 409 });
          } else if (userId && !ownership.ownedByUser) {
            logger.warn({ logId, action: 'create_custom_mailbox', status: 'conflict', message: '普通用户尝试创建已存在但不属于自己的邮箱', userId, email });
            return new Response('邮箱地址已被占用，请向管理员申请或使用其他地址', { status: 409 });
          } else {
            logger.warn({ logId, action: 'create_custom_mailbox', status: 'conflict', message: '超级管理员尝试创建已存在的邮箱', email });
            return new Response('邮箱地址已存在，使用其他地址', { status: 409 });
          }
        }
        
        // 邮箱不存在，可以创建
        if (userId) {
          // 普通用户：通过assignMailboxToUser创建并分配
          logger.info({ logId, action: 'create_custom_mailbox', message: '普通用户创建邮箱', userId, email });
          await assignMailboxToUser(db, { userId: userId, address: email });
          logger.info({ logId, action: 'create_custom_mailbox', result: { userId, email, success: true } });
          return Response.json({ email, expires: Date.now() + 3600000 });
        } else {
          // 超级管理员：直接创建邮箱
          logger.info({ logId, action: 'create_custom_mailbox', message: '超级管理员创建邮箱', email });
          await getOrCreateMailboxId(db, email);
          logger.info({ logId, action: 'create_custom_mailbox', result: { email, success: true } });
          return Response.json({ email, expires: Date.now() + 3600000 });
        }
      } catch (e) { 
        // 如果是邮箱上限错误，返回更明确的提示
        if (String(e?.message || '').includes('已达到邮箱上限')) {
          logger.warn({ logId, action: 'create_custom_mailbox', status: 'quota_exceeded', message: '用户达到邮箱上限', userId, error: e.message });
          return new Response('已达到邮箱创建上限', { status: 429 });
        }
        logger.error({ logId, action: 'create_custom_mailbox', error: e.message, stack: e.stack, email });
        return new Response(String(e?.message || '创建失败'), { status: 400 }); 
      }
    } catch (e) { 
      logger.error({ logId, action: 'create_custom_mailbox', error: e.message, stack: e.stack });
      return new Response('创建失败', { status: 500 }); 
    }
  }

  // 当前用户配额：已用/上限
  if (path === '/api/user/quota' && request.method === 'GET') {
    try {
      const payload = getJwtPayload();
      const uid = Number(payload?.userId || 0);
      const role = payload?.role || 'user';

      logger.info({ logId, action: 'get_user_quota', params: { userId: uid, role, username: String(payload?.username || '') } });
      
      // 检查是否为超级管理员（role=admin 即视为，权限与 ADMIN_NAME 一致）
      const isSuperAdmin = (role === 'admin');
      
      if (isSuperAdmin) {
        // 超级管理员：显示系统中所有邮箱的总数
        const totalUsed = await getTotalMailboxCount(db);
        logger.info({ logId, action: 'get_user_quota', result: { isSuperAdmin: true, totalUsed } });
        return Response.json({ used: totalUsed, limit: 999999, isAdmin: true });
      } else if (uid) {
        // 普通用户：使用缓存查询个人邮箱数和上限
        const { getCachedUserQuota } = await import('./cacheHelper.js');
        const quota = await getCachedUserQuota(db, uid);
        logger.info({ logId, action: 'get_user_quota', result: { userId: uid, quota } });
        return Response.json({ ...quota, isAdmin: false });
      } else {
        // 未登录或无效用户
        logger.info({ logId, action: 'get_user_quota', result: { isAnonymous: true } });
        return Response.json({ used: 0, limit: 0, isAdmin: false });
      }
    } catch (e) { 
      logger.error({ logId, action: 'get_user_quota', error: e.message, stack: e.stack });
      return new Response('查询失败', { status: 500 }); 
    }
  }

  // 发件记录列表（按发件人地址过滤）
  if (path === '/api/sent' && request.method === 'GET') {
    const from = url.searchParams.get('from') || url.searchParams.get('mailbox') || '';
    if (!from) { return new Response('缺少 from 参数', { status: 400 }); }
    try {
      // 优化：减少默认查询数量
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      const { results } = await db.prepare(`
        SELECT id, resend_id, to_addrs as recipients, subject, created_at, status
        FROM sent_emails
        WHERE from_addr = ?
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `).bind(String(from).trim().toLowerCase(), limit).all();
      return Response.json(results || []);
    } catch (e) {
      logger.error({ logId, action: 'get_sent_list', error: e.message, stack: e.stack });
      return new Response('查询发件记录失败', { status: 500 });
    }
  }

  // 发件记录列表
  if (path === '/api/user/sent' && request.method === 'GET') {
    try {
      const payload = getJwtPayload();
      const uid = Number(payload?.userId || 0);
      if (!uid) {
        logger.warn({ logId, action: 'get_sent_emails', error: 'unauthorized', userId: uid });
        return new Response('未登录', { status: 401 });
      }
      
      const url = new URL(request.url);
      const page = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || 20);
      const offset = (page - 1) * pageSize;
      
      logger.info({ logId, action: 'get_sent_emails', params: { userId: uid, page, pageSize, offset } });
      
      // 查询发件记录
      const sent = await db.prepare(`
        SELECT * FROM sent_emails 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
      `).bind(uid, pageSize, offset).all();
      
      logger.info({ logId, action: 'get_sent_emails', result: { count: sent.results?.length || 0 } });
      return Response.json({ sent: sent.results });
    } catch (e) { 
      logger.error({ logId, action: 'get_sent_emails', error: e.message, stack: e.stack });
      return new Response('查询失败', { status: 500 }); 
    }
  }

  // 发件详情
  if (request.method === 'GET' && path.startsWith('/api/sent/')) {
    const sentId = path.substring('/api/sent/'.length);
    try {
      const payload = getJwtPayload();
      const uid = Number(payload?.userId || 0);
      if (!uid) {
        logger.warn({ logId, action: 'get_sent_detail', error: 'unauthorized', userId: uid, sentId });
        return new Response('未登录', { status: 401 });
      }
      
      logger.info({ logId, action: 'get_sent_detail', params: { userId: uid, sentId } });
      
      // 查询发件详情：严格管理员可见任意记录；普通用户仅可见自己的记录
      let sent;
      if (isStrictAdmin()) {
        sent = await db.prepare('SELECT * FROM sent_emails WHERE id = ?').bind(sentId).first();
      } else {
        sent = await db.prepare('SELECT * FROM sent_emails WHERE id = ? AND user_id = ?').bind(sentId, uid).first();
      }

      if (!sent) {
        logger.warn({ logId, action: 'get_sent_detail', error: 'not_found', userId: uid, sentId });
        return new Response('发件记录不存在', { status: 404 });
      }
      
      logger.info({ logId, action: 'get_sent_detail', result: { found: true, sentId } });
      return Response.json(sent);
    } catch (e) { 
      logger.error({ logId, action: 'get_sent_detail', error: e.message, stack: e.stack, sentId });
      return new Response('查询失败', { status: 500 }); 
    }
  }

  // 检查发件权限的辅助函数
  async function checkSendPermission() {
    const payload = getJwtPayload();
    if (!payload) {return false;}
    
    // 管理员默认允许
    if (payload.role === 'admin') {return true;}
    
    // 普通用户检查 can_send 权限（使用缓存）
    if (payload.userId) {
      const { getCachedSystemStat } = await import('./cacheHelper.js');
      const cacheKey = `user_can_send_${payload.userId}`;
      
      const canSend = await getCachedSystemStat(db, cacheKey, async(db) => {
        const { results } = await db.prepare('SELECT can_send FROM users WHERE id = ?').bind(payload.userId).all();
        return results?.[0]?.can_send ? 1 : 0;
      });
      
      return canSend === 1;
    }
    
    return false;
  }
  
  // 历史收发人地址自动补全（供发信弹窗使用）
  if (path === '/api/addresses' && request.method === 'GET') {
    try {
      const qRaw = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const qq = qRaw.replace(/[^a-z0-9@._-]/g, '');
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '12', 10), 1), 30);
      const payloadUser = getJwtPayload();
      const uid = Number(payloadUser?.userId || 0);
      const strictAdmin = isStrictAdmin();
      const like = '%' + qq + '%';

      // 非管理员：仅从这个用户关联的邮箱收发历史里取；管理员可见全局
      let mailboxAddrs = null;
      if (!strictAdmin && uid) {
        const boxes = await getUserMailboxes(db, uid);
        mailboxAddrs = (boxes || []).map(b => b.address).filter(Boolean);
      }

      const candidates = new Map();
      function addCand(raw) {
        const email = extractEmail(String(raw || '')).toLowerCase();
        if (!email) { return; }
        const nameM = /^([^<]+)</.exec(String(raw || ''));
        const name = nameM ? nameM[1].trim().replace(/^["']+|["']+$/g, '') : '';
        const existing = candidates.get(email);
        if (existing) {
          existing.cnt += 1;
          if (!existing.label || existing.label === email) { existing.label = name || email; }
        } else {
          candidates.set(email, { email, label: name || email, cnt: 1, lastAt: '' });
        }
      }

      // 收到的邮件：发件人即潜在收件人
      let senderRows = [];
      try {
        if (mailboxAddrs && mailboxAddrs.length) {
          const placeholders = mailboxAddrs.map(() => '?').join(',');
          senderRows = (await db.prepare(
            `SELECT sender AS raw, COUNT(*) AS cnt, MAX(received_at) AS lastAt FROM messages
              WHERE sender LIKE ? AND mailbox_id IN (${placeholders})
              GROUP BY sender ORDER BY cnt DESC LIMIT ?`
          ).bind(like, ...mailboxAddrs, limit).all()).results || [];
        } else {
          senderRows = (await db.prepare(
            `SELECT sender AS raw, COUNT(*) AS cnt, MAX(received_at) AS lastAt FROM messages
              WHERE sender LIKE ? GROUP BY sender ORDER BY cnt DESC LIMIT ?`
          ).bind(like, limit).all()).results || [];
        }
        for (const r of senderRows) { addCand(r.raw); }
      } catch (e) { void e; }

      // 我们主动发过的邮件：收件人
      try {
        const sentRows = (await db.prepare(
          `SELECT to_addrs AS raw, COUNT(*) AS cnt, MAX(created_at) AS lastAt FROM sent_emails
            WHERE to_addrs LIKE ? GROUP BY to_addrs ORDER BY cnt DESC LIMIT 60`
        ).bind(like).all()).results || [];
        for (const r of sentRows) {
          String(r.raw || '').split(',').forEach(part => addCand(part));
        }
      } catch (e) { void e; }

      const sorted = Array.from(candidates.values())
        .sort((a, b) => (b.cnt - a.cnt) || String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
        .slice(0, limit);

      logger.info({ logId, action: 'address_autocomplete', query: qRaw, returned: sorted.length, status: 200 });
      return Response.json({ list: sorted });
    } catch (e) {
      logger.error({ logId, action: 'address_autocomplete', error: e.message, status: 500 });
      return Response.json({ list: [] });
    }
  }

  // 发送单封邮件
  if (path === '/api/send' && request.method === 'POST') {
    // 空值守卫：检查 RESEND_API_KEY 配置
    if (!RESEND_API_KEY) {
      logger.error({ logId, action: 'send_email', error: 'resend_api_key_missing', status: 501 });
      return new Response('Resend not configured', { status: 501 });
    }
    
    let sendPayload;
    try {
      
      // 校验是否允许发件
      const allowed = await checkSendPermission();
      if (!allowed) {
        logger.warn({ logId, action: 'send_email', error: 'permission_denied', status: 403 });
        return new Response('未授权发件或该用户未被授予发件权限', { status: 403 });
      }
      
      sendPayload = await request.json();
      logger.info({ logId, action: 'send_email', params: { from: sendPayload.from, to: sendPayload.to, subject: sendPayload.subject } });
      const payloadUser = getJwtPayload();
      const uidForSend = Number(payloadUser?.userId || 0);
      if (uidForSend) {
        const userRateLimit = checkCustomRateLimit(`send_user:${uidForSend}`, 'send:user');
        if (userRateLimit && userRateLimit.status) {
          logger.warn({ logId, action: 'send_email', error: 'rate_limited_user', userId: uidForSend, status: userRateLimit.status });
          return new Response(userRateLimit.body, { status: userRateLimit.status, headers: userRateLimit.headers });
        }
      }
      const fromAddr = String(sendPayload.from || '').trim().toLowerCase();
      if (fromAddr) {
        const fromRateLimit = checkCustomRateLimit(`send_from:${fromAddr}`, 'send:from');
        if (fromRateLimit && fromRateLimit.status) {
          logger.warn({ logId, action: 'send_email', error: 'rate_limited_from', from: fromAddr, status: fromRateLimit.status });
          return new Response(fromRateLimit.body, { status: fromRateLimit.status, headers: fromRateLimit.headers });
        }
      }
      
      // 使用智能发送，根据发件人域名自动选择API密钥
      const archiveForwardTo = await resolveArchiveForwardTo(db, options.env);
      // 归档副本：若配置了转发邮箱且不在收件人/抄送/密送中，追加到 bcc（from 为临时域地址时可被私人邮箱收到）
      if (archiveForwardTo && !isRecipientListed(sendPayload, archiveForwardTo)) {
        sendPayload = { ...sendPayload, bcc: [archiveForwardTo].concat(sendPayload.bcc || []) };
      }
      const result = await sendEmailWithAutoResend(RESEND_API_KEY, sendPayload);
      await recordSentEmail(db, {
        resendId: result.id || null,
        fromName: sendPayload.fromName || null,
        from: sendPayload.from,
        to: sendPayload.to,
        subject: sendPayload.subject,
        // 发件箱预览：把 cid 内嵌图还原成 data URI，前端无需公网即可显示图片
        html: resolveCidAttachments(sendPayload.html, sendPayload.attachments),
        text: sendPayload.text,
        status: 'delivered',
        scheduledAt: sendPayload.scheduledAt || null,
        userId: uidForSend || null
      });

      // 发送成功通知到默认 Telegram 群聊
      if (result?.id) {
        try {
          await notifyTelegramSend(options.env, sendPayload, result.id, { baseUrl: url.origin });
        } catch (tgErr) {
          logger.warn({ logId, action: 'send_email', error: 'telegram_notify_failed', errorMessage: tgErr.message });
        }
      }

      logger.info({ logId, action: 'send_email', result: { sendId: result.id, status: 'delivered', archivedTo: archiveForwardTo || '' } });
      return Response.json({ success: true, id: result.id });
    } catch (e) {
      logger.error({ logId, action: 'send_email', error: e.message, from: sendPayload?.from, to: sendPayload?.to });
      return new Response('发送失败: ' + e.message, { status: 500 });
    }
  }

  // 批量发送
  if (path === '/api/send/batch' && request.method === 'POST') {
    // 空值守卫：检查 RESEND_API_KEY 配置
    if (!RESEND_API_KEY) {
      logger.error({ logId, action: 'send_batch', error: 'resend_api_key_missing', status: 501 });
      return new Response('Resend not configured', { status: 501 });
    }
    
    let items;
    try {
      
      // 校验是否允许发件
      const allowed = await checkSendPermission();
      if (!allowed) {
        logger.warn({ logId, action: 'send_batch', error: 'permission_denied', status: 403 });
        return new Response('未授权发件或该用户未被授予发件权限', { status: 403 });
      }
      
      items = await request.json();
      logger.info({ logId, action: 'send_batch', params: { batchSize: items.length, firstFrom: items[0]?.from, firstTo: items[0]?.to } });
      const payloadUser = getJwtPayload();
      const uidForBatch = Number(payloadUser?.userId || 0);
      if (uidForBatch) {
        const userBatchRateLimit = checkCustomRateLimit(`send_user:${uidForBatch}`, 'send:user');
        if (userBatchRateLimit && userBatchRateLimit.status) {
          logger.warn({ logId, action: 'send_batch', error: 'rate_limited_user', userId: uidForBatch, status: userBatchRateLimit.status });
          return new Response(userBatchRateLimit.body, { status: userBatchRateLimit.status, headers: userBatchRateLimit.headers });
        }
      }
      const firstFrom = String(items[0]?.from || '').trim().toLowerCase();
      if (firstFrom) {
        const fromBatchRateLimit = checkCustomRateLimit(`send_from:${firstFrom}`, 'send:from');
        if (fromBatchRateLimit && fromBatchRateLimit.status) {
          logger.warn({ logId, action: 'send_batch', error: 'rate_limited_from', from: firstFrom, status: fromBatchRateLimit.status });
          return new Response(fromBatchRateLimit.body, { status: fromBatchRateLimit.status, headers: fromBatchRateLimit.headers });
        }
      }
      
      // 使用智能批量发送，自动按域名分组并使用对应的API密钥
      const result = await sendBatchWithAutoResend(RESEND_API_KEY, items);
      
      let recordedCount = 0;
      try {
        // 尝试记录（如果返回结构包含 id 列表）
        const arr = Array.isArray(result) ? result : [];
        for (let i = 0; i < arr.length; i++) {
          const id = arr[i]?.id;
          const payload = items[i] || {};
          const batchPayloadUser = getJwtPayload();
          const batchUid = Number(batchPayloadUser?.userId || 0);
          await recordSentEmail(db, {
            resendId: id || null,
            fromName: payload.fromName || null,
            from: payload.from,
            to: payload.to,
            subject: payload.subject,
            html: resolveCidAttachments(payload.html, payload.attachments),
            text: payload.text,
            status: 'delivered',
            scheduledAt: payload.scheduledAt || null,
            userId: batchUid || null
          });
          recordedCount++;
        }
      } catch (e) {
        logger.warn({ logId, action: 'send_batch', error: 'record_failed', recordedCount, errorMessage: e.message });
      }

      // 发送成功通知到默认 Telegram 群聊
      try {
        await notifyTelegramSend(options.env, items[0] || {}, Array.isArray(result) ? result[0]?.id || '' : '', { batchSize: items.length, baseUrl: url.origin });
      } catch (tgErr) {
        logger.warn({ logId, action: 'send_batch', error: 'telegram_notify_failed', errorMessage: tgErr.message });
      }

      logger.info({ logId, action: 'send_batch', result: { batchSize: items.length, recordedCount, resultSize: Array.isArray(result) ? result.length : 0 } });
      return Response.json({ success: true, result });
    } catch (e) {
      logger.error({ logId, action: 'send_batch', error: e.message, batchSize: items?.length });
      return new Response('批量发送失败: ' + e.message, { status: 500 });
    }
  }

  // 查询归档转发邮箱配置（严格管理员）
  if (path === '/api/config/forward' && request.method === 'GET') {
    if (!isStrictAdmin()) {
      return new Response('Unauthorized', { status: 403 });
    }
    const stored = await getAppConfig(db, 'ARCHIVE_FORWARD_TO');
    const forwardTo = String((stored && stored.value) ? stored.value : '').trim()
      || String(options.env?.ARCHIVE_FORWARD_TO || '').trim();
    logger.info({ logId, action: 'get_config_forward', status: 200 });
    return Response.json({ forwardTo });
  }

  // 更新归档转发邮箱配置（严格管理员，空值即关闭）
  if (path === '/api/config/forward' && request.method === 'PUT') {
    if (!isStrictAdmin()) {
      return new Response('Unauthorized', { status: 403 });
    }
    let body;
    try { body = await request.json(); } catch (e) { return new Response('Bad Request', { status: 400 }); }
    const forwardTo = String(body.forwardTo || '').trim();
    await setAppConfig(db, 'ARCHIVE_FORWARD_TO', forwardTo || '');
    logger.info({ logId, action: 'update_config_forward', forwardTo: forwardTo || '(已关闭)', status: 200 });
    return Response.json({ success: true, forwardTo });
  }

  // 查询发送结果
  if (path.startsWith('/api/send/') && request.method === 'GET') {
    // 空值守卫：检查 RESEND_API_KEY 配置
    if (!RESEND_API_KEY) {
      logger.error({ logId, action: 'get_send_result', error: 'resend_api_key_missing', status: 501 });
      return new Response('Resend not configured', { status: 501 });
    }
    
    const id = path.split('/')[3];
    logger.info({ logId, action: 'get_send_result', sendId: id });
    try {
      const data = await getEmailFromResend(RESEND_API_KEY, id);
      logger.info({ logId, action: 'get_send_result', result: { sendId: id, status: data?.status || 'unknown' } });
      return Response.json(data);
    } catch (e) {
      logger.error({ logId, action: 'get_send_result', error: e.message, sendId: id });
      return new Response('查询失败: ' + e.message, { status: 500 });
    }
  }

  // 更新（修改定时/状态等）
  if (path.startsWith('/api/send/') && request.method === 'PATCH') {
    // 空值守卫：检查 RESEND_API_KEY 配置
    if (!RESEND_API_KEY) {
      logger.error({ logId, action: 'update_send', error: 'resend_api_key_missing', status: 501 });
      return new Response('Resend not configured', { status: 501 });
    }
    
    const id = path.split('/')[3];
    logger.info({ logId, action: 'update_send', sendId: id });
    try {
      const body = await request.json();
      logger.info({ logId, action: 'update_send', params: { sendId: id, updateType: body.status ? 'status' : body.scheduledAt ? 'schedule' : 'unknown' } });
      let data = { ok: true };
      // 如果只是更新本地状态，不必请求 Resend
      if (body && typeof body.status === 'string') {
        await updateSentEmail(db, id, { status: body.status });
        logger.info({ logId, action: 'update_send', result: { sendId: id, statusUpdated: true, newStatus: body.status } });
      }
      // 更新定时设置时需要触达 Resend
      if (body && body.scheduledAt) {
        data = await updateEmailInResend(RESEND_API_KEY, { id, scheduledAt: body.scheduledAt });
        await updateSentEmail(db, id, { scheduled_at: body.scheduledAt });
        logger.info({ logId, action: 'update_send', result: { sendId: id, scheduleUpdated: true, scheduledAt: body.scheduledAt } });
      }
      return Response.json(data || { ok: true });
    } catch (e) {
      logger.error({ logId, action: 'update_send', error: e.message, sendId: id });
      return new Response('更新失败: ' + e.message, { status: 500 });
    }
  }

  // 取消发送
  if (path.startsWith('/api/send/') && path.endsWith('/cancel') && request.method === 'POST') {
    // 空值守卫：检查 RESEND_API_KEY 配置
    if (!RESEND_API_KEY) {
      logger.error({ logId, action: 'cancel_send', error: 'resend_api_key_missing', status: 501 });
      return new Response('Resend not configured', { status: 501 });
    }
    
    const id = path.split('/')[3];
    logger.info({ logId, action: 'cancel_send', sendId: id });
    try {
      const data = await cancelEmailInResend(RESEND_API_KEY, id);
      await updateSentEmail(db, id, { status: 'canceled' });
      logger.info({ logId, action: 'cancel_send', result: { sendId: id, canceled: true } });
      return Response.json(data);
    } catch (e) {
      logger.error({ logId, action: 'cancel_send', error: e.message, sendId: id });
      return new Response('取消失败: ' + e.message, { status: 500 });
    }
  }

  // 删除发件记录
  if (request.method === 'DELETE' && path.startsWith('/api/sent/')) {
    const id = path.split('/')[3];
    logger.info({ logId, action: 'delete_sent_record', sentId: id });
    try {
      const delPayload = getJwtPayload();
      const delUid = Number(delPayload?.userId || 0);
      const isAdmin = delPayload?.role === 'admin';
      const result = isAdmin
        ? await db.prepare('DELETE FROM sent_emails WHERE id = ?').bind(id).run()
        : await db.prepare('DELETE FROM sent_emails WHERE id = ? AND user_id = ?').bind(id, delUid).run();
      const deleted = (result?.meta?.changes || 0) > 0;
      if (deleted) {
        logger.info({ logId, action: 'delete_sent_record', result: { sentId: id, deleted: true } });
      } else {
        logger.warn({ logId, action: 'delete_sent_record', error: 'not_found', sentId: id });
      }
      return Response.json({ success: true, deleted });
    } catch (e) {
      logger.error({ logId, action: 'delete_sent_record', error: e.message, sentId: id });
      return new Response('删除发件记录失败: ' + e.message, { status: 500 });
    }
  }

  if (path === '/api/emails' && request.method === 'GET') {
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) {
      logger.warn({ logId, action: 'get_emails', error: 'missing_mailbox_param' });
      return new Response('缺少 mailbox 参数', { status: 400 });
    }
    try {
      const normalized = extractEmail(mailbox).trim().toLowerCase();
      
      logger.info({ logId, action: 'get_emails', params: { mailbox: normalized } });
      const mailboxKey = normalized || '';
      const mailboxRateLimit = checkCustomRateLimit(`mailbox_read:${mailboxKey}`, 'mailbox:read');
      if (mailboxRateLimit && mailboxRateLimit.status) {
        logger.warn({ logId, action: 'get_emails', error: 'rate_limited_mailbox', mailbox: normalized, status: mailboxRateLimit.status });
        return new Response(mailboxRateLimit.body, { status: mailboxRateLimit.status, headers: mailboxRateLimit.headers });
      }
      
      // 纯读：不存在则返回空数组，不创建
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) {
        logger.info({ logId, action: 'get_emails', result: { mailbox: normalized, found: false, count: 0 } });
        return Response.json([]);
      }
      
      // 邮箱用户只能查看近24小时的邮件
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      // 优化：减少默认查询数量，降低行读取
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      
      try {
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read, preview, verification_code
          FROM messages 
          WHERE mailbox_id = ?${timeFilter}
          ORDER BY received_at DESC 
          LIMIT ?
        `).bind(mailboxId, ...timeParam, limit).all();
        logger.info({ logId, action: 'get_emails', result: { mailbox: normalized, count: results?.length || 0 } });
        return Response.json(results);
      } catch (e) {
        void e;
        // 旧结构降级查询：从 content/html_content 计算 preview
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read,
                 CASE WHEN content IS NOT NULL AND content <> ''
                      THEN SUBSTR(content, 1, 120)
                      ELSE SUBSTR(COALESCE(html_content, ''), 1, 120)
                 END AS preview
          FROM messages 
          WHERE mailbox_id = ?${timeFilter}
          ORDER BY received_at DESC 
          LIMIT ?
        `).bind(mailboxId, ...timeParam, limit).all();
        logger.info({ logId, action: 'get_emails', result: { mailbox: normalized, count: results?.length || 0, fallback: true } });
        return Response.json(results);
      }
    } catch (e) {
      logger.error({ logId, action: 'get_emails', error: e.message, stack: e.stack, mailbox });
      return new Response('查询邮件失败', { status: 500 });
    }
  }

  // 批量查询邮件详情，减少前端 N+1 请求
  if (path === '/api/emails/batch' && request.method === 'GET') {
    try {
      const idsParam = String(url.searchParams.get('ids') || '').trim();
      if (!idsParam) {return Response.json([]);} 
      const ids = idsParam.split(',').map(s=>parseInt(s,10)).filter(n=>Number.isInteger(n) && n > 0);
      if (!ids.length) {return Response.json([]);} 
      
      // 优化：限制批量查询数量，避免单次查询过多行
      if (ids.length > 50) {
        return new Response('单次最多查询50封邮件', { status: 400 });
      }
      
      // 邮箱用户只能查看近24小时的邮件
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      const placeholders = ids.map(()=>'?').join(',');
      try {
        const { results } = await db.prepare(`
          SELECT id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, received_at, is_read
          FROM messages WHERE id IN (${placeholders})${timeFilter}
        `).bind(...ids, ...timeParam).all();
        return Response.json(results || []);
      } catch (err) {
        void err;
        const { results } = await db.prepare(`
          SELECT id, sender, subject, content, html_content, received_at, is_read
                 FROM messages WHERE id IN (${placeholders})${timeFilter}
        `).bind(...ids, ...timeParam).all();
        return Response.json(results || []);
      }
    } catch (err) {
      void err;
      return new Response('批量查询失败', { status: 500 });
    }
  }

  // 历史邮箱列表（按创建时间倒序）支持分页
  if (path === '/api/mailboxes' && request.method === 'GET') {
    // 优化：默认查询更少的数据
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const domain = String(url.searchParams.get('domain') || '').trim().toLowerCase();
    const canLoginParam = String(url.searchParams.get('can_login') || '').trim();
    // 超级管理员（严格管理员）可查看全部；其他仅查看自身绑定
    try {
      if (isStrictAdmin()) {
        // 严格管理员：查看所有邮箱，并用自己在 user_mailboxes 中的置顶状态覆盖；未置顶则为 0
        const payload = getJwtPayload();
        const adminUid = Number(payload?.userId || 0);
        const like = `%${q.replace(/%/g,'').replace(/_/g,'')}%`;
        
        // 构建筛选条件
        const whereConditions = [];
        const bindParams = [adminUid || 0];
        
        // 搜索条件
        if (q) {
          whereConditions.push('LOWER(m.address) LIKE LOWER(?)');
          bindParams.push(like);
        }
        
        // 域名筛选
        if (domain) {
          whereConditions.push('LOWER(m.address) LIKE LOWER(?)');
          bindParams.push(`%@${domain}`);
        }
        
        // 登录权限筛选
        if (canLoginParam === 'true') {
          whereConditions.push('m.can_login = 1');
        } else if (canLoginParam === 'false') {
          whereConditions.push('m.can_login = 0');
        }
        
        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
        bindParams.push(limit, offset);
        
        const { results } = await db.prepare(`
          SELECT m.address, m.created_at, COALESCE(um.is_pinned, 0) AS is_pinned,
                 CASE WHEN (m.password_hash IS NULL OR m.password_hash = '') THEN 1 ELSE 0 END AS password_is_default,
                 COALESCE(m.can_login, 0) AS can_login
          FROM mailboxes m
          LEFT JOIN user_mailboxes um ON um.mailbox_id = m.id AND um.user_id = ?
          ${whereClause}
          ORDER BY is_pinned DESC, m.created_at DESC
          LIMIT ? OFFSET ?
        `).bind(...bindParams).all();
        return Response.json(results || []);
      }
      const payload = getJwtPayload();
      const uid = Number(payload?.userId || 0);
      if (!uid) {return Response.json([]);}
      const like = `%${q.replace(/%/g,'').replace(/_/g,'')}%`;
      
      // 构建筛选条件
      const whereConditions = ['um.user_id = ?'];
      const bindParams = [uid];
      
      // 搜索条件
      if (q) {
        whereConditions.push('LOWER(m.address) LIKE LOWER(?)');
        bindParams.push(like);
      }
      
      // 域名筛选
      if (domain) {
        whereConditions.push('LOWER(m.address) LIKE LOWER(?)');
        bindParams.push(`%@${domain}`);
      }
      
      // 登录权限筛选
      if (canLoginParam === 'true') {
        whereConditions.push('m.can_login = 1');
      } else if (canLoginParam === 'false') {
        whereConditions.push('m.can_login = 0');
      }
      
      const whereClause = 'WHERE ' + whereConditions.join(' AND ');
      bindParams.push(limit, offset);
      
      const { results } = await db.prepare(`
        SELECT m.address, m.created_at, um.is_pinned,
               CASE WHEN (m.password_hash IS NULL OR m.password_hash = '') THEN 1 ELSE 0 END AS password_is_default,
               COALESCE(m.can_login, 0) AS can_login
        FROM user_mailboxes um
        JOIN mailboxes m ON m.id = um.mailbox_id
        ${whereClause}
        ORDER BY um.is_pinned DESC, m.created_at DESC
        LIMIT ? OFFSET ?
      `).bind(...bindParams).all();
      return Response.json(results || []);
    } catch (e) {
      void e;
      return Response.json([]);
    }
  }

  // 管理员获取域名统计
  if (path === '/api/admin/stats/domains' && request.method === 'GET') {
    if (!isStrictAdmin()) { return new Response('Forbidden', { status: 403 }); }
    try {
      const { getDomainStats, getDomainUsageStats } = await import('./database.js');
      const stats = await getDomainStats(db);
      const list = await getDomainUsageStats(db);
      return Response.json({ ...stats, list });
    } catch (e) {
      logger.error({ logId, action: 'get_domain_stats', error: e.message });
      return new Response('查询失败', { status: 500 });
    }
  }

  if (path === '/api/admin/blocked-senders' && request.method === 'GET') {
    if (!isStrictAdmin()) { return new Response('Forbidden', { status: 403 }); }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    try {
      const list = await listBlockedSenders(db, limit, offset);
      return Response.json(list || []);
    } catch (e) {
      logger.error({ logId, action: 'list_blocked_senders', error: e.message, stack: e.stack });
      return new Response('查询失败', { status: 500 });
    }
  }

  if (path === '/api/admin/blocked-senders' && request.method === 'POST') {
    if (!isStrictAdmin()) { return new Response('Forbidden', { status: 403 }); }
    try {
      const body = await request.json();
      const pattern = String(body.pattern || '').trim().toLowerCase();
      const type = body.type === 'domain' ? 'domain' : 'email';
      const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null;
      if (!pattern) {
        return new Response('缺少 pattern 参数', { status: 400 });
      }
      const row = await addBlockedSender(db, pattern, type, reason);
      return Response.json(row || { success: true });
    } catch (e) {
      logger.error({ logId, action: 'add_blocked_sender', error: e.message, stack: e.stack });
      return new Response('创建失败', { status: 500 });
    }
  }

  if (path.startsWith('/api/admin/blocked-senders/') && request.method === 'DELETE') {
    if (!isStrictAdmin()) { return new Response('Forbidden', { status: 403 }); }
    const idStr = path.split('/')[4];
    const id = Number(idStr || 0);
    if (!id) {
      return new Response('无效ID', { status: 400 });
    }
    try {
      const deleted = await deleteBlockedSender(db, id);
      return Response.json({ success: true, deleted });
    } catch (e) {
      logger.error({ logId, action: 'delete_blocked_sender', error: e.message, stack: e.stack, id });
      return new Response('删除失败', { status: 500 });
    }
  }

  // 重置某个邮箱的密码为默认（邮箱本身）——仅严格管理员
  if (path === '/api/mailboxes/reset-password' && request.method === 'POST') {
    try {
      if (!isStrictAdmin()) {return new Response('Forbidden', { status: 403 });}
      const address = String(url.searchParams.get('address') || '').trim().toLowerCase();
      if (!address) {return new Response('缺少 address 参数', { status: 400 });}
      await db.prepare('UPDATE mailboxes SET password_hash = NULL WHERE address = ?').bind(address).run();
      return Response.json({ success: true });
    } catch (err) { void err; return new Response('重置失败', { status: 500 }); }
  }

  // 切换邮箱置顶状态
  if (path === '/api/mailboxes/pin' && request.method === 'POST') {
    const address = url.searchParams.get('address');
    if (!address) {return new Response('缺少 address 参数', { status: 400 });}
    const payload = getJwtPayload();
    let uid = Number(payload?.userId || 0);
    // 兼容旧会话：严格管理员旧 Token 可能没有 userId，这里兜底保障可置顶
    // 优先归属到当前管理员（使 chuancey 等 role=admin 账号也能正确置顶），回退到 ADMIN_NAME
    if (!uid && isStrictAdmin()) {
      try {
        const uname = String(getJwtPayload()?.username || options?.adminName || 'admin').toLowerCase();
        const { results } = await db.prepare('SELECT id FROM users WHERE username = ?').bind(uname).all();
        if (results && results.length) {
          uid = Number(results[0].id);
        } else {
          await db.prepare('INSERT INTO users (username, role, can_send, mailbox_limit) VALUES (?, \'admin\', 1, 9999)').bind(uname).run();
          const again = await db.prepare('SELECT id FROM users WHERE username = ?').bind(uname).all();
          uid = Number(again?.results?.[0]?.id || 0);
        }
      } catch (err) { void err; uid = 0; }
    }
    if (!uid) {return new Response('未登录', { status: 401 });}
    try {
      const result = await toggleMailboxPin(db, address, uid);
      return Response.json({ success: true, ...result });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 切换邮箱登录权限（仅严格管理员可用）
  if (path === '/api/mailboxes/toggle-login' && request.method === 'POST') {
    if (!isStrictAdmin()) {return new Response('Forbidden', { status: 403 });}
    try {
      const body = await request.json();
      const address = String(body.address || '').trim().toLowerCase();
      const canLogin = Boolean(body.can_login);
      
      if (!address) {return new Response('缺少 address 参数', { status: 400 });}
      
      // 检查邮箱是否存在
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) {
        return new Response('邮箱不存在', { status: 404 });
      }
      
      // 更新登录权限
      await db.prepare('UPDATE mailboxes SET can_login = ? WHERE address = ?')
        .bind(canLogin ? 1 : 0, address).run();
      
      return Response.json({ success: true, can_login: canLogin });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 修改邮箱密码（仅严格管理员可用）
  if (path === '/api/mailboxes/change-password' && request.method === 'POST') {
    if (!isStrictAdmin()) {return new Response('Forbidden', { status: 403 });}
    try {
      const body = await request.json();
      const address = String(body.address || '').trim().toLowerCase();
      const newPassword = String(body.new_password || '').trim();
      
      if (!address) {return new Response('缺少 address 参数', { status: 400 });}
      if (!newPassword || newPassword.length < 6) {return new Response('密码长度至少6位', { status: 400 });}
      
      // 检查邮箱是否存在
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) {
        return new Response('邮箱不存在', { status: 404 });
      }
      
      // 生成密码哈希
      const newPasswordHash = await sha256Hex(newPassword);
      
      // 更新密码
      await db.prepare('UPDATE mailboxes SET password_hash = ? WHERE address = ?')
        .bind(newPasswordHash, address).run();
      
      return Response.json({ success: true });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 批量切换邮箱登录权限（仅严格管理员可用）
  if (path === '/api/mailboxes/batch-toggle-login' && request.method === 'POST') {
    if (!isStrictAdmin()) {return new Response('Forbidden', { status: 403 });}
    try {
      const body = await request.json();
      const addresses = body.addresses || [];
      const canLogin = Boolean(body.can_login);
      
      if (!Array.isArray(addresses) || addresses.length === 0) {
        return new Response('缺少 addresses 参数或地址列表为空', { status: 400 });
      }
      
      // 限制批量操作数量，防止性能问题
      if (addresses.length > 100) {
        return new Response('单次最多处理100个邮箱', { status: 400 });
      }
      
      let successCount = 0;
      let failCount = 0;
      const results = [];
      
      // 规范化地址并过滤空地址
      const addressMap = new Map(); // 存储规范化后的地址映射
      
      for (const address of addresses) {
        const normalizedAddress = String(address || '').trim().toLowerCase();
        if (!normalizedAddress) {
          failCount++;
          results.push({ address, success: false, error: '地址为空' });
          continue;
        }
        addressMap.set(normalizedAddress, address);
      }
      
      // 优化：使用 IN 查询批量检查邮箱是否存在，减少数据库查询次数
      const existingMailboxes = new Set();
      if (addressMap.size > 0) {
        try {
          const addressList = Array.from(addressMap.keys());
          const placeholders = addressList.map(() => '?').join(',');
          const checkResult = await db.prepare(
            `SELECT address FROM mailboxes WHERE address IN (${placeholders})`
          ).bind(...addressList).all();
          
          for (const row of (checkResult.results || [])) {
            existingMailboxes.add(row.address);
          }
        } catch (e) {
          logger.error({ logId, action: 'batch_check_mailboxes_failed', error: e.message, stack: e.stack });
        }
      }
      
      // 准备批量操作语句
      const batchStatements = [];
      
      for (const normalizedAddress of addressMap.keys()) {
        if (existingMailboxes.has(normalizedAddress)) {
          // 邮箱存在，更新登录权限
          batchStatements.push({
            stmt: db.prepare('UPDATE mailboxes SET can_login = ? WHERE address = ?')
              .bind(canLogin ? 1 : 0, normalizedAddress),
            address: normalizedAddress,
            type: 'update'
          });
        } else {
          // 邮箱不存在，创建新邮箱（需包含 local_part 和 domain）
          const atIdx = normalizedAddress.indexOf('@');
          if (atIdx > 0 && atIdx < normalizedAddress.length - 1) {
            const localPart = normalizedAddress.slice(0, atIdx);
            const domainPart = normalizedAddress.slice(atIdx + 1);
            batchStatements.push({
              stmt: db.prepare('INSERT INTO mailboxes (address, local_part, domain, can_login) VALUES (?, ?, ?, ?)')
                .bind(normalizedAddress, localPart, domainPart, canLogin ? 1 : 0),
              address: normalizedAddress,
              type: 'insert'
            });
          } else {
            failCount++;
            results.push({ address: normalizedAddress, success: false, error: '无效的邮箱格式' });
          }
        }
      }
      
      // 使用 D1 的 batch API 批量执行
      if (batchStatements.length > 0) {
        try {
          const batchResults = await db.batch(batchStatements.map(s => s.stmt));
          
          // 处理每个操作的结果
          for (let i = 0; i < batchResults.length; i++) {
            const result = batchResults[i];
            const operation = batchStatements[i];
            
            if (result.success !== false) {
              successCount++;
              results.push({
                address: operation.address,
                success: true,
                [operation.type === 'insert' ? 'created' : 'updated']: true
              });
            } else {
              failCount++;
              results.push({
                address: operation.address,
                success: false,
                error: result.error || '操作失败'
              });
            }
          }
        } catch (e) {
          logger.error({ logId, action: 'batch_execute_failed', error: e.message, stack: e.stack });
          return new Response('批量操作失败: ' + e.message, { status: 500 });
        }
      }
      
      return Response.json({ 
        success: true, 
        success_count: successCount, 
        fail_count: failCount,
        total: addresses.length,
        results 
      });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 删除邮箱（及其所有邮件）
  if (path === '/api/mailboxes' && request.method === 'DELETE') {
    const raw = url.searchParams.get('address');
    if (!raw) {return new Response('缺少 address 参数', { status: 400 });}
    const normalized = String(raw || '').trim().toLowerCase();
    try {
      const { invalidateMailboxCache } = await import('./cacheHelper.js');
      
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      // 未找到则明确返回 404，避免前端误判为成功
      if (!mailboxId) {
        logger.warn('邮箱删除失败: 邮箱不存在', { logId, action: 'delete_mailbox', address: normalized, status: 404 });
        return new Response(JSON.stringify({ success: false, message: '邮箱不存在' }), { status: 404 });
      }
      
      if (!isStrictAdmin()) {
        // 二级管理员（数据库中的 admin 角色）仅能删除自己绑定的邮箱
        const payload = getJwtPayload();
        if (!payload || payload.role !== 'admin' || !payload.userId) {
          logger.warn('邮箱删除失败: 权限不足', { logId, action: 'delete_mailbox', address: normalized, status: 403 });
          return new Response('Forbidden', { status: 403 });
        }
        const own = await db.prepare('SELECT 1 FROM user_mailboxes WHERE user_id = ? AND mailbox_id = ? LIMIT 1')
          .bind(Number(payload.userId), mailboxId).all();
        if (!own?.results?.length) {
          logger.warn('邮箱删除失败: 无权删除他人邮箱', { logId, action: 'delete_mailbox', address: normalized, mailboxId, userId: payload.userId, status: 403 });
          return new Response('Forbidden', { status: 403 });
        }
      }
      
      logger.info('开始删除邮箱', { logId, action: 'delete_mailbox', address: normalized, mailboxId });
      
      // 简易事务，降低并发插入导致的外键失败概率
      try { await db.exec('BEGIN'); } catch (err) { void err; }
      await db.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mailboxId).run();
      const deleteResult = await db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mailboxId).run();
      try { await db.exec('COMMIT'); } catch (err) { void err; }

      // 优化：通过 meta.changes 判断删除是否成功，减少 COUNT 查询
      const deleted = (deleteResult?.meta?.changes || 0) > 0;
      
      // 删除成功后使缓存失效
      if (deleted) {
        invalidateMailboxCache(normalized);
        // 使系统统计缓存失效
        const { invalidateSystemStatCache } = await import('./cacheHelper.js');
        invalidateSystemStatCache('total_mailboxes');
        logger.info('邮箱删除成功', { logId, action: 'delete_mailbox', address: normalized, mailboxId, deleted: true });
      } else {
        logger.warn('邮箱删除失败: 数据库操作未生效', { logId, action: 'delete_mailbox', address: normalized, mailboxId });
      }
      
      return Response.json({ success: deleted, deleted });
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch (err) { void err; }
      logger.error('邮箱删除异常', { logId, action: 'delete_mailbox', address: normalized, error: e.message });
      return new Response('删除失败', { status: 500 });
    }
  }

  // 下载 EML（从 R2 获取）- 必须在通用邮件详情处理器之前
  if (request.method === 'GET' && path.startsWith('/api/email/') && path.endsWith('/download')) {
    const id = path.split('/')[3];
    const { results } = await db.prepare('SELECT r2_bucket, r2_object_key FROM messages WHERE id = ?').bind(id).all();
    const row = (results || [])[0];
    if (!row || !row.r2_object_key) {
      logger.warn('邮件下载失败: 未找到邮件或对象', { logId, action: 'download_email', emailId: id, status: 404 });
      return new Response('未找到对象', { status: 404 });
    }
    
    logger.info('开始下载邮件', { logId, action: 'download_email', emailId: id, objectKey: row.r2_object_key });
    
    try {
      const r2 = options.r2;
      if (!r2) {
        logger.error('邮件下载失败: R2未绑定', { logId, action: 'download_email', emailId: id, status: 500 });
        return new Response('R2 未绑定', { status: 500 });
      }
      
      const obj = await r2.get(row.r2_object_key);
      if (!obj) {
        logger.warn('邮件下载失败: 对象不存在', { logId, action: 'download_email', emailId: id, objectKey: row.r2_object_key, status: 404 });
        return new Response('对象不存在', { status: 404 });
      }
      
      const headers = new Headers({ 'Content-Type': 'message/rfc822' });
      headers.set('Content-Disposition', `attachment; filename="${String(row.r2_object_key).split('/').pop()}"`);
      
      logger.info('邮件下载成功', { logId, action: 'download_email', emailId: id, objectKey: row.r2_object_key, size: obj.size });
      return new Response(obj.body, { headers });
    } catch (e) {
      logger.error('邮件下载异常', { logId, action: 'download_email', emailId: id, error: e.message });
      return new Response('下载失败', { status: 500 });
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/email/')) {
    const emailId = path.split('/')[3];
    
    logger.info({ logId, action: 'get_email_detail', params: { emailId, isMailboxOnly } });
    
    try {
      // 邮箱用户需要验证邮件是否在24小时内
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      const { results } = await db.prepare(`
        SELECT id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, received_at, is_read
        FROM messages WHERE id = ?${timeFilter}
      `).bind(emailId, ...timeParam).all();
      
      if (!results || !results.length) {
        logger.warn({ logId, action: 'get_email_detail', error: 'not_found', emailId, status: 404 });
        return new Response('未找到邮件', { status: 404 });
      }
      const row = results[0];
      
      // 尝试从 R2 获取完整内容
      let content = row.content || '';
      let html_content = row.html_content || '';
      
      if (row.r2_object_key) {
        try {
          const r2 = options.r2;
          if (r2) {
            const obj = await r2.get(row.r2_object_key);
            if (obj) {
              const eml = await obj.text();
              const parsed = parseEmailBody(eml);
              content = parsed.text || '';
              html_content = parsed.html || '';
              // 将内嵌图片（cid:）替换为 data URI，使富文本邮件中的图片可显示
              if (html_content) {
                html_content = resolveInlineImages(eml, html_content);
              }

              // 如果 R2 中有内容，更新数据库中的预览
              if (content && !row.preview) {
                const preview = String(content).substring(0, 120);
                await db.prepare('UPDATE messages SET preview = ? WHERE id = ?').bind(preview, emailId).run();
              }
            }
          }
        } catch (e) {
          // R2 读取失败时使用数据库中的内容
          logger.warn({ logId, action: 'get_email_detail', error: 'r2_read_failed', emailId, r2Key: row.r2_object_key, errorMessage: e.message });
        }
      }
      
      // 标记为已读
      await db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(emailId).run();
      
      logger.info({ logId, action: 'get_email_detail', result: { emailId, found: true, hasR2: !!row.r2_object_key } });
      
      return Response.json({ ...row, content, html_content, download: row.r2_object_key ? `/api/email/${emailId}/download` : '' });
    } catch (e) {
      void e;
      const { results } = await db.prepare(`
        SELECT id, sender, subject, content, html_content, received_at, is_read
        FROM messages WHERE id = ?
      `).bind(emailId).all();
      if (!results || !results.length) {
        logger.warn({ logId, action: 'get_email_detail', error: 'not_found_fallback', emailId, status: 404 });
        return new Response('未找到邮件', { status: 404 });
      }
      await db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(emailId).run();
      logger.info({ logId, action: 'get_email_detail', result: { emailId, found: true, fallback: true } });
      return Response.json(results[0]);
    }
  }

  if (request.method === 'DELETE' && path.startsWith('/api/email/')) {
    const emailId = path.split('/')[3];
    
    if (!emailId || !Number.isInteger(parseInt(emailId))) {
      logger.warn('邮件删除失败: 无效的邮件ID', { logId, action: 'delete_email', emailId, status: 400 });
      return new Response('无效的邮件ID', { status: 400 });
    }
    
    logger.info('开始删除邮件', { logId, action: 'delete_email', emailId });
    
    try {
      // 优化：直接删除，通过 D1 的 changes 判断是否成功，减少 COUNT 查询
      const result = await db.prepare('DELETE FROM messages WHERE id = ?').bind(emailId).run();
      
      // D1 的 run() 返回对象中包含 meta.changes 表示受影响的行数
      const deleted = (result?.meta?.changes || 0) > 0;
      
      if (deleted) {
        logger.info('邮件删除成功', { logId, action: 'delete_email', emailId, deleted: true });
      } else {
        logger.warn('邮件删除失败: 邮件不存在或已被删除', { logId, action: 'delete_email', emailId });
      }
      
      return Response.json({ 
        success: true, 
        deleted,
        message: deleted ? '邮件已删除' : '邮件不存在或已被删除'
      });
    } catch (e) {
      logger.error('邮件删除异常', { logId, action: 'delete_email', emailId, error: e.message });
      return new Response('删除邮件时发生错误: ' + e.message, { status: 500 });
    }
  }

  if (request.method === 'DELETE' && path === '/api/emails') {
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) {
      logger.warn('清空邮件失败: 缺少mailbox参数', { logId, action: 'clear_emails', status: 400 });
      return new Response('缺少 mailbox 参数', { status: 400 });
    }
    
    const normalized = extractEmail(mailbox).trim().toLowerCase();
    logger.info('开始清空邮件', { logId, action: 'clear_emails', mailbox: normalized });
    
    try {
      // 仅当邮箱已存在时才执行清空操作；不存在则直接返回 0 删除
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) {
        logger.info('清空邮件: 邮箱不存在，无需清空', { logId, action: 'clear_emails', mailbox: normalized });
        return Response.json({ success: true, deletedCount: 0 });
      }
      
      // 优化：直接删除，通过 meta.changes 获取删除数量，减少 COUNT 查询
      const result = await db.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mailboxId).run();
      const deletedCount = result?.meta?.changes || 0;
      
      logger.info('清空邮件成功', { logId, action: 'clear_emails', mailbox: normalized, mailboxId, deletedCount });
      
      return Response.json({ 
        success: true, 
        deletedCount
      });
    } catch (e) {
      logger.error('清空邮件异常', { logId, action: 'clear_emails', mailbox: normalized, error: e.message });
      return new Response('清空邮件失败', { status: 500 });
    }
  }

  // Toggle message pin status
  if (path.startsWith('/api/emails/') && path.endsWith('/pin') && request.method === 'POST') {
    
    // Extract ID: /api/emails/123/pin
    const parts = path.split('/');
    const messageId = parseInt(parts[3], 10);
    
    if (!messageId) {
      return new Response('Invalid message ID', { status: 400 });
    }
    
    try {
      const body = await request.json();
      const isPinned = !!body.is_pinned;
      
      const payload = getJwtPayload();
      
      // Auth check
      if (!isStrictAdmin()) {
        // Mailbox user check
        const mailboxId = payload?.mailboxId;
        if (!mailboxId) {
          return new Response('Unauthorized', { status: 401 });
        }
        
        // Verify ownership
        const msg = await db.prepare('SELECT mailbox_id FROM messages WHERE id = ?').bind(messageId).first();
        if (!msg) {
          return new Response('Message not found', { status: 404 });
        }
        if (msg.mailbox_id !== mailboxId) {
          return new Response('Forbidden', { status: 403 });
        }
      }
      
      const success = await setMessagePinned(db, messageId, isPinned);
      return Response.json({ success, is_pinned: isPinned });
      
    } catch (e) {
      logger.error('Pin message failed', { error: e.message });
      return new Response('Failed to pin message', { status: 500 });
    }
  }

  // ================= 邮箱密码管理 =================
  if (path === '/api/mailbox/password' && request.method === 'PUT') {
    
    try {
      const body = await request.json();
      const { currentPassword, newPassword } = body;
      
      if (!currentPassword || !newPassword) {
        logger.warn('密码修改失败: 密码参数为空', { logId, action: 'change_password', status: 400 });
        return new Response('当前密码和新密码不能为空', { status: 400 });
      }
      
      if (newPassword.length < 6) {
        logger.warn('密码修改失败: 新密码长度不足', { logId, action: 'change_password', passwordLength: newPassword.length, status: 400 });
        return new Response('新密码长度至少6位', { status: 400 });
      }
      
      const payload = getJwtPayload();
      const mailboxAddress = payload?.mailboxAddress;
      const mailboxId = payload?.mailboxId;
      
      if (!mailboxAddress || !mailboxId) {
        logger.warn('密码修改失败: 未找到邮箱信息', { logId, action: 'change_password', status: 401 });
        return new Response('未找到邮箱信息', { status: 401 });
      }
      
      logger.info('开始修改密码', { logId, action: 'change_password', mailboxAddress, mailboxId });
      
      // 验证当前密码
      const { results } = await db.prepare('SELECT password_hash FROM mailboxes WHERE id = ? AND address = ?')
        .bind(mailboxId, mailboxAddress).all();
      
      if (!results || results.length === 0) {
        logger.warn('密码修改失败: 邮箱不存在', { logId, action: 'change_password', mailboxAddress, mailboxId, status: 404 });
        return new Response('邮箱不存在', { status: 404 });
      }
      
      const mailbox = results[0];
      let currentPasswordValid = false;
      
      if (mailbox.password_hash) {
        // 如果有存储的密码哈希，验证哈希密码
        const { verifyPassword } = await import('./authentication.js');
        currentPasswordValid = await verifyPassword(currentPassword, mailbox.password_hash);
      } else {
        // 兼容性：如果没有密码哈希，使用邮箱地址作为默认密码
        currentPasswordValid = (currentPassword === mailboxAddress);
      }
      
      if (!currentPasswordValid) {
        logger.warn('密码修改失败: 当前密码错误', { logId, action: 'change_password', mailboxAddress, mailboxId, status: 400 });
        return new Response('当前密码错误', { status: 400 });
      }
      
      // 生成新密码哈希
      const { hashPassword } = await import('./authentication.js');
      const newPasswordHash = await hashPassword(newPassword);
      
      // 更新密码
      await db.prepare('UPDATE mailboxes SET password_hash = ? WHERE id = ?')
        .bind(newPasswordHash, mailboxId).run();
      
      logger.info('密码修改成功', { logId, action: 'change_password', mailboxAddress, mailboxId });
      
      return Response.json({ success: true, message: '密码修改成功' });
      
    } catch (error) {
      logger.error('密码修改异常', { logId, action: 'change_password', error: error.message });
      return new Response('修改密码失败', { status: 500 });
    }
  }

  return new Response('未找到 API 路径', { status: 404 });
}

export async function handleEmailReceive(requestOrData, db, env) {
  try {
    let emailData;
    // 支持直接传入数据对象或 Request 对象
    if (requestOrData && typeof requestOrData.json === 'function') {
      emailData = await requestOrData.json();
    } else {
      emailData = requestOrData;
    }

    const to = String(emailData?.to || '');
    const from = String(emailData?.from || '');
    const envelopeFrom = String(emailData?.envelope_from || from);
    const subject = String(emailData?.subject || '(无主题)');
    const text = String(emailData?.text || '');
    const html = String(emailData?.html || '');
    const raw = String(emailData?.raw || '');

    const mailbox = extractEmail(to);
    const sender = extractEmail(from || envelopeFrom);
    const blocked = await isSenderBlocked(db, sender);
    if (blocked) {
      return new Response('Blocked', { status: 204 });
    }
    const mailboxKey = String(mailbox || '').trim().toLowerCase();
    const receiveRateLimit = checkCustomRateLimit(`receive_mailbox:${mailboxKey}`, 'receive:mailbox');
    if (receiveRateLimit && receiveRateLimit.status) {
      return new Response(receiveRateLimit.body, { status: receiveRateLimit.status, headers: receiveRateLimit.headers });
    }
    const mailboxId = await getOrCreateMailboxId(db, mailbox);

    // 构造简易 EML 并写入 R2（即便没有原始 raw 也生成便于详情查看）
    const now = new Date();
    const dateStr = now.toUTCString();
    const boundary = 'mf-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    let eml = '';
    if (html) {
      eml = [
        `From: <${sender}>`,
        `To: <${mailbox}>`,
        `Subject: ${subject}`,
        `Date: ${dateStr}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        `--${boundary}`,
        'Content-Type: text/html; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        html,
        `--${boundary}--`,
        ''
      ].join('\r\n');
    } else {
      eml = [
        `From: <${sender}>`,
        `To: <${mailbox}>`,
        `Subject: ${subject}`,
        `Date: ${dateStr}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        ''
      ].join('\r\n');
    }

    let objectKey = '';
    try {
      const r2 = env?.MAIL_EML;
      if (r2) {
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        const d = String(now.getUTCDate()).padStart(2, '0');
        const hh = String(now.getUTCHours()).padStart(2, '0');
        const mm = String(now.getUTCMinutes()).padStart(2, '0');
        const ss = String(now.getUTCSeconds()).padStart(2, '0');
        const keyId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const safeMailbox = (mailbox || 'unknown').toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
        objectKey = `${y}/${m}/${d}/${safeMailbox}/${hh}${mm}${ss}-${keyId}.eml`;
        // 优先保存原始全量邮件（含内嵌图片/附件），保证详情可回放；否则回退到重建的 eml
        let archiveBody = eml;
        if (raw.trim() && /^[A-Za-z-]+:/m.test(raw)) {
          archiveBody = raw;
        }
        await r2.put(objectKey, archiveBody, { httpMetadata: { contentType: 'message/rfc822' } });
      }
    } catch (err) { void err; objectKey = ''; }

    // 预览文本：优先用纯文本；若只有 HTML，则剔除 style/script 内容后再去标签，避免把整段 CSS（如 @media）残留进 Telegram 预览
    let previewBaseRaw = '';
    if (text) {
      previewBaseRaw = text;
    } else {
      const safeHtml = String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ');
      previewBaseRaw = safeHtml.replace(/<[^>]+>/g, ' ');
    }
    const previewBase = String(previewBaseRaw || '')
      // 剔除 Gmail 等对内嵌图片的占位符 "[image: xxx]"，图片已另行发送
      .replace(/\[image:[^\]]*\]/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    // 纯图片/富文本但无可提取文字时，给出中性占位，避免 Telegram 显示空或残留文件名
    const effectivePreview = previewBase || (/(<img\b)/i.test(html) ? '📎 含图片' : (html ? '📧 富文本内容' : ''));
    const preview = String(effectivePreview || '').slice(0, 120);
    let verificationCode = '';
    let loginLink = '';
    try {
      verificationCode = extractVerificationCode({ subject, text, html });
      loginLink = extractLoginLink({ text, html });
      if (!verificationCode && loginLink) {
        verificationCode = loginLink;
        loginLink = '';
      }
    } catch (err) { void err; }

    // 直接使用标准列名插入（表结构已在初始化时固定）
    // Use full 'from' string if available to preserve sender name, fallback to extracted sender email
    const displayFrom = from || sender;
    await db.prepare(`
      INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mailboxId,
      displayFrom,
      String(to || ''),
      subject || '(无主题)',
      verificationCode || null,
      preview || null,
      'temp-mail-eml',
      objectKey || ''
    ).run();

    try {
      const globalRetentionDays = Number(env?.EMAIL_RETENTION_DAYS || 60);
      await cleanupOldMessages(db, globalRetentionDays);
    } catch (err) { void err; }

    try {
      // 收集需要通知的 Telegram Chat：绑定该邮箱的用户 + 配置的默认接收 Chat
      // 默认 Chat 始终加入，确保即使邮箱未绑定 Telegram 用户也能收到通知
      const targetChatIds = [];
      const seen = new Set();
      try {
        const { results } = await db.prepare(
          'SELECT u.telegram_chat_id FROM users u JOIN user_mailboxes um ON um.user_id = u.id JOIN mailboxes m ON m.id = um.mailbox_id WHERE m.id = ? AND u.telegram_chat_id IS NOT NULL'
        ).bind(mailboxId).all();
        (results || []).forEach(function(row) {
          const cid = String(row.telegram_chat_id || '').trim();
          if (cid && !seen.has(cid)) { seen.add(cid); targetChatIds.push(cid); }
        });
      } catch (e) {
        logger.error('查询用户 Telegram 绑定失败', e);
      }

      const defaultChat = String(env.TELEGRAM_CHAT_ID || '').trim();
      if (defaultChat && !seen.has(defaultChat)) {
        seen.add(defaultChat);
        targetChatIds.push(defaultChat);
      }

      const botToken = String(env.TELEGRAM_BOT_TOKEN || '').trim();
      if (botToken && targetChatIds.length) {
        const previewText = String(effectivePreview || '').slice(0, 200);
        const shouldEllipsis = String(effectivePreview || '').length > previewText.length;
        const verificationCodeStr = String(verificationCode || '');
        const isVerificationCodeLink = /^https?:\/\//i.test(verificationCodeStr);
        let verificationBlock = '';
        if (verificationCode) {
          if (isVerificationCodeLink) {
            verificationBlock = '<b>🔗 登录链接:</b> <a href="' + escapeHtml(verificationCodeStr) + '">点击登录</a>\n';
          } else {
            verificationBlock = '<b>🔑 验证码:</b> <code>' + escapeHtml(verificationCodeStr) + '</code>\n';
          }
        }

        const baseMsg =
          '<b>📬 新邮件 ' + escapeHtml(mailbox) + '</b>\n\n' +
          '<b>📤 发件人:</b> ' + escapeHtml(displayFrom) + '\n' +
          '<b>📥 收件人:</b> ' + escapeHtml(to) + '\n' +
          '<b>📋 主题:</b> ' + escapeHtml(subject) + '\n' +
          verificationBlock +
          (loginLink ? '<b>🔗 登录链接:</b> <a href="' + escapeHtml(loginLink) + '">点击登录</a>\n' : '') +
          '\n' + escapeHtml(previewText) + (shouldEllipsis ? '...' : '');

        // 若邮件含内嵌图片，则以图片方式发送（caption 为通知文本，支持 HTML 富文本），Telegram 才能显示图片
        // 多张图片用媒体组（相册）一次发送，避免只显示第一张
        const inlineImages = raw ? extractInlineImages(raw) : [];
        for (const cid of targetChatIds) {
          const chatEnv = { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_CHAT_ID: cid };
          try {
            if (inlineImages.length > 1) {
              await sendTelegramMediaGroup(chatEnv, baseMsg, inlineImages);
            } else if (inlineImages.length === 1) {
              await sendTelegramPhoto(chatEnv, baseMsg, inlineImages[0].data, inlineImages[0].mimeType);
            } else {
              await sendTelegramMessage(chatEnv, baseMsg);
            }
          } catch (e) {
            logger.error('Telegram notification failed', e);
          }
        }
      }
    } catch (notifyErr) {
      logger.error('Telegram notification wrapper failed', notifyErr);
    }

    return Response.json({ success: true });
  } catch (error) {
    logger.error('处理邮件时出错', error);
    return new Response('处理邮件失败', { status: 500 });
  }
}

/**
 * 解析归档转发目标：优先取 D1 配置表，其次回退 env.ARCHIVE_FORWARD_TO
 */
async function resolveArchiveForwardTo(db, env) {
  try {
    const stored = await getAppConfig(db, 'ARCHIVE_FORWARD_TO');
    if (stored && stored.value) {
      const v = String(stored.value).trim();
      if (v) { return v; }
    }
  } catch (e) { void e; }
  return String((env && env.ARCHIVE_FORWARD_TO) || '').trim() || null;
}

/**
 * 判断归档目标是否已出现在 to/cc/bcc 中，避免重复投递副本
 */
function isRecipientListed(payload, target) {
  if (!target) { return true; }
  const t = String(target).trim().toLowerCase();
  const list = [payload.to, payload.cc, payload.bcc].flat().filter(Boolean);
  return list.some(item => String(item).trim().toLowerCase() === t);
}

/**
 * 将 base64 字符串解码为 Uint8Array（同时兼容多行/带 data: 前缀的 base64）
 * @param {string} b64 可能是纯 base64，也可能带 "data:image/png;base64," 前缀
 */
function base64DataToBytes(b64) {
  try {
    const cleaned = String(b64)
      .replace(/^data:[^,]+;base64,/i, '')
      .replace(/\s+/g, '');
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
    return out;
  } catch (e) {
    void e;
    return null;
  }
}

/**
 * 依据文件名后缀猜测 MIME 类型，用于 Telegram sendPhoto。
 * @param {string} filename
 * @returns {string} 如 image/png、image/jpeg、image/gif、image/webp
 */
function mimeFromFilename(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp'
  };
  return map[ext] || 'image/png';
}

/**
 * 将内嵌图片写入 R2，返回公网 URL（供 Telegram 链接预览抓取）
 * @param {object} env 环境变量（含 MAIL_EML R2 绑定）
 * @param {Uint8Array} bytes 图片字节
 * @param {string} mimeType 图片 MIME 类型
 * @param {string} baseUrl Worker 公网源（如 https://tmp-mail.214599.xyz）
 * @returns {Promise<string|null>} 公网 URL，失败返回 null
 */
async function storeInlineImageToR2(env, bytes, mimeType, baseUrl) {
  try {
    const r2 = env && env.MAIL_EML;
    if (!r2 || !baseUrl || !bytes || !bytes.length) { return null; }
    const ext = String(mimeType || 'image/png').split('/')[1] || 'png';
    const keyId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const objectKey = `media/inline-${keyId}.${ext}`;
    await r2.put(objectKey, bytes, { httpMetadata: { contentType: mimeType || 'image/png' } });
    return `${String(baseUrl).replace(/\/+$/, '')}/media/${objectKey.slice('media/'.length)}`;
  } catch (e) {
    logger.warn('内嵌图片写 R2 失败，回退 sendPhoto', e);
    return null;
  }
}

/**
 * 发送成功后推送 "📤 已发送" 摘要到默认 Telegram 群聊
 * @param {object} env 环境变量（含 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / MAIL_EML）
 * @param {object} payload 发送载荷（from/subject/to/text/html/attachments）
 * @param {string} sendId Resend 返回的发送 ID
 * @param {object} extra 附加信息（如 batchSize、baseUrl）
 */
async function notifyTelegramSend(env, payload, sendId, extra = {}) {
  const token = String((env && env.TELEGRAM_BOT_TOKEN) || '').trim();
  const chatId = String((env && env.TELEGRAM_CHAT_ID) || '').trim();
  if (!token || !chatId) { return; }
  const from = String(payload.from || '').trim().toLowerCase();
  const to = String(payload.to || '').trim();
  const subject = String(payload.subject || '').trim();
  let text = '<b>📤 已发送</b>';
  if (extra.batchSize) { text += `（批量 ${extra.batchSize} 封）`; }
  text += '\n';
  if (from) { text += `发件人：<code>${escapeHtml(from)}</code>\n`; }
  if (to) { text += `收件人：<code>${escapeHtml(to)}</code>\n`; }
  if (subject) { text += `主题：${escapeHtml(subject)}\n`; }
  text += `ID：<code>${encodeURIComponent(sendId || '')}</code>`;
  // 附加正文本内容（纯文本优先，其次从 HTML 剥离标签），让 Bot 里也能看到正文
  let bodyText = String(payload.text || '').trim();
  if (!bodyText) {
    bodyText = String(payload.html || '')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (bodyText) {
    // sendMessage 上限 4096，正文最多截 3000，确保正文完整不被 caption 的 1024 限制吞掉
    text += '\n\n<b>📄 正文:</b>\n' + escapeHtml(bodyText.substring(0, 3000));
  }
  const attachList = Array.isArray(payload.attachments) ? payload.attachments : [];
  const inlineImgs = attachList.filter(a => a && (((a.disposition && String(a.disposition).toLowerCase()) !== 'attachment') || a.content_id) && String(a.filename || '').match(/\.(png|jpe?g|gif|webp|bmp)$/i));
  if (inlineImgs.length) {
    // 每张内嵌图都写入 R2 并附上独立的可点击链接（Telegram 只对整条消息里的第一个 URL 生成预览缩略图）
    const links = [];
    const fallbackPhotos = [];
    for (let i = 0; i < inlineImgs.length; i++) {
      const img = inlineImgs[i];
      const bytes = (img && img.content) ? base64DataToBytes(String(img.content)) : null;
      if (!bytes || !bytes.length) { continue; }
      const mime = mimeFromFilename(img.filename);
      const imgUrl = await storeInlineImageToR2(env, bytes, mime, extra.baseUrl);
      if (imgUrl) {
        links.push(`🖼 图片${i + 1}：<a href="${imgUrl}">查看</a>`);
      } else {
        fallbackPhotos.push({ bytes, mime });
      }
    }
    if (links.length) {
      text += '\n\n' + links.join('\n');
      await sendTelegramMessage(env, text, 'HTML', { disableWebPagePreview: false });
    } else {
      await sendTelegramMessage(env, text, 'HTML');
    }
    // R2 写失败的图用 sendPhoto 兜底，确保不丢图
    for (const p of fallbackPhotos) {
      await sendTelegramPhoto(env, '<b>📎 内嵌图片</b>', p.bytes, p.mime);
    }
    return;
  }
  await sendTelegramMessage(env, text, 'HTML');
}
