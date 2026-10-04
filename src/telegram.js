import logger from './logger.js';
import { getUserByTelegramId, createUser, assignMailboxToUser, getUserMailboxes, getAdminMailboxes, getLatestMessage, getMailboxIdByAddress, getActiveDomains, getDomainStats, getDomainUsageStats, recordSentEmail } from './database.js';
import { generateRandomId } from './commonUtils.js';
import { sendEmailWithAutoResend } from './emailSender.js';

/**
 * 发送 Telegram 消息
 * @param {object} env - 环境变量
 * @param {string} text - 消息内容
 * @param {string} [parseMode='HTML'] - 解析模式
 */
export async function sendTelegramMessage(env, text, parseMode = 'HTML') {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return;
  }
  
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: text,
    parse_mode: parseMode,
    disable_web_page_preview: true
  };
  
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!resp.ok) {
      const errorText = await resp.text();
      logger.error('Telegram API Error', errorText);
    }
  } catch (e) {
    logger.error('Telegram Request Failed', e);
  }
}

/**
 * 处理 Telegram Webhook 请求
 * @param {Request} request - HTTP 请求
 * @param {object} env - 环境变量
 * @param {object} db - 数据库连接
 * @returns {Promise<Response>}
 */
export async function handleTelegramWebhook(request, env, db) {
  const logId = `tg-${Date.now()}`;
  try {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return new Response('Telegram Bot Token not configured');
    }

    let update;
    try {
      update = await request.json();
    } catch (err) {
      logger.error('Telegram Webhook JSON Parse Error', err, { contentType: request.headers.get('content-type') || '' }, logId);
      return new Response('OK');
    }

    logger.info('Telegram Update', update, logId);

    if (!update.message || !update.message.text) {
      return new Response('OK');
    }

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const username = msg.from.username || '';

    // 安全检查：如果配置了 TELEGRAM_CHAT_ID，则只允许该 ID 操作
    if (env.TELEGRAM_CHAT_ID && String(env.TELEGRAM_CHAT_ID) !== String(chatId)) {
      logger.warn('Unauthorized Telegram Access', { chatId, expected: env.TELEGRAM_CHAT_ID }, logId);
      return new Response('OK');
    }

    // 获取或创建用户
    let user = await getUserByTelegramId(db, chatId);
    if (!user) {
      const adminName = env.ADMIN_NAME || 'admin';
      // 检查 admin 用户是否存在
      const { results } = await db.prepare('SELECT * FROM users WHERE username = ?').bind(adminName).all();
      if (results && results.length > 0) {
        user = results[0];
        await db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_username = ? WHERE id = ?')
          .bind(String(chatId), username, user.id).run();
      } else {
        user = await createUser(db, {
          username: `tg_${chatId}`,
          role: 'user',
          mailboxLimit: 20
        });
        await db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_username = ? WHERE id = ?')
          .bind(String(chatId), username, user.id).run();
      }
    }

    // 处理命令
    if (text.startsWith('/start')) {
      await replyTelegram(env, chatId, '👋 欢迎使用临时邮箱 Bot！\n\n可用命令：\n/new [域名|前缀|完整地址] - 创建新邮箱\n/list - 查看我的邮箱\n/latest [邮箱] - 查看最新邮件\n/code [邮箱] - 快速获取验证码\n/emails [邮箱] - 列出最近几封邮件\n/reply <邮箱> <内容> - 回复最新一封邮件\n/send <邮箱> <收件人> [主题|]<内容> - 发送邮件\n/domains - 查看当前可用域名\n/domainstats - 查看域名统计\n/id - 查看我的 Chat ID');
    } else if (text.startsWith('/id')) {
      await replyTelegram(env, chatId, `🆔 您的 Chat ID 是: <code>${chatId}</code>`, 'HTML');
    } else if (text.startsWith('/new')) {
      let domains = await getActiveDomains(db);
      if (!domains || !domains.length) {
        domains = (env.MAIL_DOMAIN || 'temp.example.com').split(/[,\s]+/).filter(Boolean);
      }
      if (!domains.length) {
        await replyTelegram(env, chatId, '当前没有可用域名，请检查后台配置。');
        return new Response('OK');
      }
      const parts = text.split(/\s+/);
      let domain;
      let localPart = '';
      const localPartRe = /^[a-z0-9][a-z0-9._-]{0,63}$/;

      if (parts[1]) {
        const arg = parts[1].trim().toLowerCase();
        if (arg.includes('@')) {
          // 完整地址：/new chuancey@214599.xyz
          const atIdx = arg.lastIndexOf('@');
          const lp = arg.slice(0, atIdx);
          const dom = arg.slice(atIdx + 1);
          const found = domains.find(d => d.toLowerCase() === dom);
          if (!found) {
            await replyTelegram(env, chatId, `❌ 域名不可用。可用域名:\n${domains.map(d => `<code>${d}</code>`).join('\n')}`, 'HTML');
            return new Response('OK');
          }
          if (!localPartRe.test(lp)) {
            await replyTelegram(env, chatId, '❌ 邮箱前缀不合法。仅支持小写字母、数字、点、下划线、连字符，须以字母或数字开头，最长 64 位。');
            return new Response('OK');
          }
          localPart = lp;
          domain = found;
        } else {
          const found = domains.find(d => d.toLowerCase() === arg);
          if (found) {
            // 指定域名，随机前缀：/new 214599.xyz
            domain = found;
          } else if (!arg.includes('.') && localPartRe.test(arg)) {
            // 自定义前缀，随机选域名：/new chuancey
            localPart = arg;
            domain = domains[Math.floor(Math.random() * domains.length)];
          } else {
            await replyTelegram(env, chatId, `❌ 域名不可用。可用域名:\n${domains.map(d => `<code>${d}</code>`).join('\n')}`, 'HTML');
            return new Response('OK');
          }
        }
      } else {
        domain = domains[Math.floor(Math.random() * domains.length)];
      }

      const minLenEnv = Number(env.MAIL_LOCALPART_MIN_LEN || 4);
      const maxLenEnv = Number(env.MAIL_LOCALPART_MAX_LEN || 16);
      const minLen = Math.max(4, Math.min(32, isNaN(minLenEnv) ? 4 : minLenEnv));
      const maxLen = Math.max(minLen, Math.min(32, isNaN(maxLenEnv) ? minLen : maxLenEnv));
      const randomLen = minLen === maxLen ? minLen : (minLen + Math.floor(Math.random() * (maxLen - minLen + 1)));

      const email = localPart ? `${localPart}@${domain}` : `${generateRandomId(randomLen)}@${domain}`;

      // 自定义前缀时检查地址是否已被他人占用
      if (localPart) {
        const existingId = await getMailboxIdByAddress(db, email);
        if (existingId) {
          const taken = await db.prepare('SELECT user_id FROM user_mailboxes WHERE mailbox_id = ? AND user_id != ? LIMIT 1')
            .bind(existingId, user.id).all();
          if (taken.results && taken.results.length) {
            await replyTelegram(env, chatId, `❌ 邮箱 <code>${email}</code> 已被占用，请换个前缀。`, 'HTML');
            return new Response('OK');
          }
        }
      }

      try {
        await assignMailboxToUser(db, { userId: user.id, address: email });
        await replyTelegram(env, chatId, `✅ 成功创建邮箱：\n<code>${email}</code>`, 'HTML');
      } catch (e) {
        await replyTelegram(env, chatId, `❌ 创建失败：${e.message}`);
      }
    } else if (text.startsWith('/list')) {
      let mailboxes;
      const role = String(user.role || '');
      if (role === 'admin') {
        const name = String(user.username || '');
        const adminName = env.ADMIN_NAME ? String(env.ADMIN_NAME) : null;
        const isRoot = name === '__root__';
        const isNamedAdmin = adminName ? name.toLowerCase() === adminName.toLowerCase() : true;
        const isStrictAdmin = isRoot || isNamedAdmin;
        if (isStrictAdmin) {
          mailboxes = await getAdminMailboxes(db, user.id);
        } else {
          mailboxes = await getUserMailboxes(db, user.id);
        }
      } else {
        mailboxes = await getUserMailboxes(db, user.id);
      }
      if (!mailboxes || mailboxes.length === 0) {
        await replyTelegram(env, chatId, '📭 您还没有创建任何邮箱。使用 /new 创建一个。');
      } else {
        let reply = '📬 <b>您的邮箱列表：</b>\n\n';
        mailboxes.slice(0, 10).forEach(m => {
          reply += `• <code>${m.address}</code>\n`;
        });
        if (mailboxes.length > 10) {reply += `\n...还有 ${mailboxes.length - 10} 个`;}
        await replyTelegram(env, chatId, reply, 'HTML');
      }
    } else if (text.startsWith('/latest')) {
      const parts = text.split(/\s+/);
      let targetEmail = parts[1];
      let mailboxId = null;

      if (targetEmail) {
        mailboxId = await getMailboxIdByAddress(db, targetEmail);
        if (!mailboxId) {
          await replyTelegram(env, chatId, '❌ 找不到该邮箱。');
          return new Response('OK');
        }
      } else {
        const mailboxes = await getUserMailboxes(db, user.id);
        if (mailboxes.length > 0) {
          // 取最近创建的一个（列表已按 pinned DESC, created_at DESC 排序）
          targetEmail = mailboxes[0].address;
          mailboxId = await getMailboxIdByAddress(db, targetEmail);
        } else {
          await replyTelegram(env, chatId, '📭 您没有邮箱。');
          return new Response('OK');
        }
      }

      const msg = await getLatestMessage(db, mailboxId);
      if (msg) {
        let reply = `📧 <b>最新邮件 (${targetEmail})</b>\n\n`;
        reply += `<b>发件人:</b> ${escapeHtml(msg.sender)}\n`;
        reply += `<b>主题:</b> ${escapeHtml(msg.subject)}\n`;
        if (msg.verification_code) {
          if (msg.verification_code.startsWith('http')) {
            reply += `<b>验证链接:</b> <a href="${escapeHtml(msg.verification_code)}">点击登录</a>\n`;
          } else {
            reply += `<b>验证码:</b> <code>${escapeHtml(msg.verification_code)}</code>\n`;
          }
        }
        reply += `<b>时间:</b> ${msg.received_at}\n\n`;
        reply += `<i>${escapeHtml((msg.preview || '').substring(0, 100))}...</i>`;
        await replyTelegram(env, chatId, reply, 'HTML');
      } else {
        await replyTelegram(env, chatId, `📭 邮箱 ${targetEmail} 暂无邮件。`);
      }
    } else if (text.startsWith('/code')) {
      const parts = text.split(/\s+/);
      let targetEmail = parts[1];
      let mailboxId = null;

      if (targetEmail) {
        mailboxId = await getMailboxIdByAddress(db, targetEmail);
        if (!mailboxId) {
          await replyTelegram(env, chatId, '❌ 找不到该邮箱。');
          return new Response('OK');
        }
      } else {
        const mailboxes = await getUserMailboxes(db, user.id);
        if (mailboxes.length > 0) {
          targetEmail = mailboxes[0].address;
          mailboxId = await getMailboxIdByAddress(db, targetEmail);
        } else {
          await replyTelegram(env, chatId, '📭 您没有邮箱。');
          return new Response('OK');
        }
      }

      const msg = await getLatestMessage(db, mailboxId);
      if (msg && msg.verification_code) {
        if (msg.verification_code.startsWith('http')) {
          await replyTelegram(env, chatId, `🔗 <b>登录链接:</b> <a href="${escapeHtml(msg.verification_code)}">点击登录</a>`, 'HTML');
        } else {
          await replyTelegram(env, chatId, `验证码: <code>${escapeHtml(msg.verification_code)}</code>`, 'HTML');
        }
      } else if (msg) {
        await replyTelegram(env, chatId, '找不到验证码字段，请使用 /latest 查看完整邮件。');
      } else {
        await replyTelegram(env, chatId, `📭 邮箱 ${targetEmail} 暂无邮件。`);
      }
    } else if (text.startsWith('/emails')) {
      const parts = text.split(/\s+/);
      let targetEmail = parts[1];
      let mailboxId = null;

      if (targetEmail) {
        mailboxId = await getMailboxIdByAddress(db, targetEmail);
        if (!mailboxId) {
          await replyTelegram(env, chatId, '❌ 找不到该邮箱。');
          return new Response('OK');
        }
      } else {
        const mailboxes = await getUserMailboxes(db, user.id);
        if (mailboxes.length > 0) {
          targetEmail = mailboxes[0].address;
          mailboxId = await getMailboxIdByAddress(db, targetEmail);
        } else {
          await replyTelegram(env, chatId, '📭 您没有邮箱。');
          return new Response('OK');
        }
      }

      const query = await db.prepare('SELECT id, sender, subject, received_at, preview, verification_code FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT ?').bind(mailboxId, 10).all();
      const list = query && Array.isArray(query.results) ? query.results : [];
      if (!list.length) {
        await replyTelegram(env, chatId, `📭 邮箱 ${targetEmail} 暂无邮件。`);
      } else {
        let reply = `📃 <b>最近邮件 (${targetEmail})</b>\n\n`;
        list.forEach(function(item, index) {
          reply += `${index + 1}. <b>${escapeHtml(item.subject || '(无主题)')}</b> - ${item.received_at}`;
          if (item.verification_code) {
            if (item.verification_code.startsWith('http')) {
              reply += ` (🔗 <a href="${escapeHtml(item.verification_code)}">登录</a>)`;
            } else {
              reply += ` (码: <code>${escapeHtml(item.verification_code)}</code>)`;
            }
          }
          reply += '\n';
        });
        await replyTelegram(env, chatId, reply, 'HTML');
      }
    } else if (text === '/domains') {
      const domains = await getActiveDomains(db);
      if (!domains || domains.length === 0) {
        await replyTelegram(env, chatId, '当前没有可用域名，请检查后台配置。');
      } else {
        let reply = '🌐 当前可用域名列表：\n\n';
        domains.forEach(function(d, i) {
          reply += `${i + 1}. <code>${d}</code>\n`;
        });
        reply += `\n共 ${domains.length} 个活跃域名。`;
        await replyTelegram(env, chatId, reply, 'HTML');
      }
    } else if (text === '/domainstats') {
      const stats = await getDomainStats(db);
      const usage = await getDomainUsageStats(db);
      const active = stats && typeof stats.active === 'number' ? stats.active : 0;
      const inactive = stats && typeof stats.inactive === 'number' ? stats.inactive : 0;
      const total = stats && typeof stats.total === 'number' ? stats.total : active + inactive;
      let reply = '📊 域名统计信息：\n\n';
      reply += `活跃域名：<b>${active}</b> 个\n`;
      reply += `已失效域名：<b>${inactive}</b> 个\n`;
      reply += `历史总数：<b>${total}</b> 个`;
      const list = Array.isArray(usage) ? usage : [];
      if (list.length) {
        reply += '\n\n📈 使用详情（前 10 个）：\n';
        list.slice(0, 10).forEach(function(item, index) {
          const d = item.domain || '';
          const mc = typeof item.mailbox_count === 'number' ? item.mailbox_count : 0;
          const msgc = typeof item.message_count === 'number' ? item.message_count : 0;
          reply += `${index + 1}. <code>${escapeHtml(d)}</code> - ${mc} 邮箱 / ${msgc} 封邮件\n`;
        });
      }
      await replyTelegram(env, chatId, reply, 'HTML');
    } else if (text.startsWith('/reply')) {
      // 回复指定邮箱的最新一封邮件：/reply <邮箱> <内容>（只有一个邮箱时可省略邮箱）
      const role = String(user.role || '');
      if (role !== 'admin' && !user.can_send) {
        await replyTelegram(env, chatId, '❌ 你没有发信权限。');
        return new Response('OK');
      }
      const resendConfig = env.RESEND_API_KEY || env.RESEND_TOKEN || env.RESEND || '';
      if (!resendConfig) {
        await replyTelegram(env, chatId, '❌ 未配置 Resend API Key，无法发信。');
        return new Response('OK');
      }

      const rest = text.replace(/^\/reply\s*/i, '').trim();
      if (!rest) {
        await replyTelegram(env, chatId, '用法：<code>/reply &lt;邮箱&gt; &lt;内容&gt;</code>', 'HTML');
        return new Response('OK');
      }
      const sp = rest.search(/\s/);
      let targetEmail = sp === -1 ? rest : rest.slice(0, sp);
      let content = sp === -1 ? '' : rest.slice(sp).trim();
      if (!targetEmail.includes('@')) {
        // 省略邮箱时，整个 rest 视为内容，取最近使用的邮箱
        content = rest;
        targetEmail = '';
      }
      if (!targetEmail) {
        const mailboxes = await getUserMailboxes(db, user.id);
        if (mailboxes && mailboxes.length > 0) {
          targetEmail = mailboxes[0].address;
        } else {
          await replyTelegram(env, chatId, '📭 您没有邮箱，请先 /new 创建。');
          return new Response('OK');
        }
      }
      if (!content) {
        await replyTelegram(env, chatId, '❌ 回复内容不能为空。用法：<code>/reply &lt;邮箱&gt; &lt;内容&gt;</code>', 'HTML');
        return new Response('OK');
      }

      const mailboxId = await getMailboxIdByAddress(db, targetEmail);
      if (!mailboxId) {
        await replyTelegram(env, chatId, '❌ 找不到该邮箱。');
        return new Response('OK');
      }
      const latestMsg = await getLatestMessage(db, mailboxId);
      if (!latestMsg) {
        await replyTelegram(env, chatId, `📭 邮箱 ${targetEmail} 暂无邮件，无法回复。`);
        return new Response('OK');
      }
      const to = extractEmailAddress(latestMsg.sender);
      if (!to) {
        await replyTelegram(env, chatId, '❌ 无法从最新邮件中解析出发件人地址。');
        return new Response('OK');
      }
      const subject = buildReplySubject(latestMsg.subject);
      try {
        const result = await sendAndRecord(db, resendConfig, user, {
          from: targetEmail,
          to,
          subject,
          content
        });
        await replyTelegram(env, chatId, `✅ 已回复 <b>${escapeHtml(to)}</b>\n主题: <code>${escapeHtml(subject)}</code>\n发件 ID: <code>${escapeHtml(result.id || '-')}</code>`, 'HTML');
      } catch (e) {
        await replyTelegram(env, chatId, `❌ 发送失败：${escapeHtml(e.message || String(e))}`, 'HTML');
      }
    } else if (text.startsWith('/send')) {
      // 自由发信：/send <邮箱> <收件人> [主题|]<内容>
      const role = String(user.role || '');
      if (role !== 'admin' && !user.can_send) {
        await replyTelegram(env, chatId, '❌ 你没有发信权限。');
        return new Response('OK');
      }
      const resendConfig = env.RESEND_API_KEY || env.RESEND_TOKEN || env.RESEND || '';
      if (!resendConfig) {
        await replyTelegram(env, chatId, '❌ 未配置 Resend API Key，无法发信。');
        return new Response('OK');
      }

      const rest = text.replace(/^\/send\s*/i, '').trim();
      const tokens = rest.split(/\s+/);
      const fromAddr = tokens[0] || '';
      const toAddr = tokens[1] || '';
      let body = '';
      if (fromAddr && toAddr) {
        body = rest.slice(rest.indexOf(toAddr) + toAddr.length).trim();
      }
      if (!fromAddr.includes('@') || !toAddr.includes('@') || !body) {
        await replyTelegram(env, chatId, '用法：<code>/send &lt;邮箱&gt; &lt;收件人&gt; [主题|]&lt;内容&gt;</code>\n例：<code>/send me@214599.xyz hi@example.com 你好|正文内容</code>', 'HTML');
        return new Response('OK');
      }
      const mailboxId = await getMailboxIdByAddress(db, fromAddr);
      if (!mailboxId) {
        await replyTelegram(env, chatId, `❌ 找不到邮箱 ${escapeHtml(fromAddr)}，请先创建。`, 'HTML');
        return new Response('OK');
      }
      let subject = '(无主题)';
      let content = body;
      const pipeIdx = content.indexOf('|');
      if (pipeIdx !== -1) {
        subject = content.slice(0, pipeIdx).trim() || subject;
        content = content.slice(pipeIdx + 1).trim();
      }
      if (!content) {
        await replyTelegram(env, chatId, '❌ 邮件内容不能为空。');
        return new Response('OK');
      }
      try {
        const result = await sendAndRecord(db, resendConfig, user, {
          from: fromAddr,
          to: toAddr,
          subject,
          content
        });
        await replyTelegram(env, chatId, `✅ 已发送给 <b>${escapeHtml(toAddr)}</b>\n主题: <code>${escapeHtml(subject)}</code>\n发件 ID: <code>${escapeHtml(result.id || '-')}</code>`, 'HTML');
      } catch (e) {
        await replyTelegram(env, chatId, `❌ 发送失败：${escapeHtml(e.message || String(e))}`, 'HTML');
      }
    } else {
      await replyTelegram(env, chatId, '❓ 未知命令。发送 /start 查看帮助。');
    }

    return new Response('OK');

  } catch (e) {
    logger.error('Telegram Webhook Error', e, {}, logId);
    return new Response('OK');
  }
}

/**
 * 从 "Name <addr@example.com>" 或纯地址中提取邮箱地址
 * @param {string} sender - 发件人字符串
 * @returns {string} 邮箱地址，未找到返回空串
 */
function extractEmailAddress(sender) {
  const s = String(sender || '');
  const match = s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match ? match[0] : '';
}

/**
 * 构造回复主题：去除已有 Re: 前缀后重新拼接
 * @param {string} subject - 原主题
 * @returns {string} 回复主题
 */
function buildReplySubject(subject) {
  const base = String(subject || '').replace(/^(re:\s*)+/i, '').trim() || '(无主题)';
  return `Re: ${base}`;
}

/**
 * 发送邮件并写入发件记录
 * @param {object} db - 数据库连接
 * @param {string} resendConfig - Resend 配置（密钥或域名=密钥映射）
 * @param {object} user - 当前用户（用于记录 userId）
 * @param {object} opts - { from, to, subject, content }
 * @returns {Promise<object>} Resend 返回结果（含 id）
 */
async function sendAndRecord(db, resendConfig, user, { from, to, subject, content }) {
  const text = String(content || '');
  const html = `<div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  const result = await sendEmailWithAutoResend(resendConfig, {
    from,
    to,
    subject,
    text,
    html
  });
  try {
    await recordSentEmail(db, {
      resendId: result && result.id ? result.id : null,
      fromName: '',
      from,
      to,
      subject,
      html,
      text,
      status: 'queued',
      userId: user && user.id ? user.id : null
    });
  } catch (e) {
    logger.error('Telegram 发件记录写入失败', e);
  }
  return result;
}

async function replyTelegram(env, chatId, text, parseMode = null) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true
  };
  if (parseMode) {payload.parse_mode = parseMode;}
  
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    logger.error('Telegram Reply Failed', err);
  }
}

function escapeHtml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
