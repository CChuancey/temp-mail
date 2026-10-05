#!/usr/bin/env node

// GitHub Actions 专用部署脚本
// 这个脚本确保在 GitHub Actions 环境中正确部署

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';

console.log('🚀 开始 GitHub Actions 部署流程...');

// 数据库配置
const DATABASE_NAME = 'temp_mail_db';
const DATABASE_BINDING = 'temp_mail_db';

async function updateWranglerConfig(databaseId) {
  // 检查是否存在 wrangler.toml 文件
  try {
    const wranglerContent = readFileSync('wrangler.toml', 'utf8');
    
    // 更新数据库绑定信息 - 处理多种可能的格式
    let updatedContent = wranglerContent;
    
    // 情况1: 替换具体的数据库ID
    updatedContent = updatedContent.replace(
      new RegExp(`database_id = \"[a-f0-9-]+\"`, 'g'),
      `database_id = "${databaseId}"`
    );
    
    // 情况2: 替换环境变量格式
    updatedContent = updatedContent.replace(
      new RegExp(`database_id = \"\\\${D1_DATABASE_ID}\"`, 'g'),
      `database_id = "${databaseId}"`
    );
    
    // 情况3: 确保数据库配置存在
    if (!updatedContent.includes(`name = "${DATABASE_NAME}"`)) {
      // 如果数据库配置不存在，添加完整的配置
      const dbConfig = `\n\n[[d1_databases]]\nname = "${DATABASE_NAME}"\ndatabase_id = "${databaseId}"\nbinding = "${DATABASE_BINDING}"`;
      updatedContent += dbConfig;
    }
    
    writeFileSync('wrangler.toml', updatedContent);
    console.log(`✅ 已更新 wrangler.toml 中的数据库绑定: ${databaseId}`);
  } catch (error) {
    console.log('ℹ️ 未找到 wrangler.toml 文件，创建新的配置文件');
    
    // 创建新的 wrangler.toml 文件
    const wranglerConfig = `name = "temp-mail"
main = "worker.js"
compatibility_date = "2024-01-01"

# D1 数据库配置
[[d1_databases]]
name = "${DATABASE_NAME}"
database_id = "${databaseId}"
binding = "${DATABASE_BINDING}"

# 生产环境配置
[env.production]
name = "temp-mail"

# 生产环境D1数据库配置
[[env.production.d1_databases]]
name = "${DATABASE_NAME}"
database_id = "${databaseId}"
binding = "${DATABASE_BINDING}"`;
    
    writeFileSync('wrangler.toml', wranglerConfig);
    console.log(`✅ 已创建 wrangler.toml 文件并设置数据库绑定: ${databaseId}`);
  }
}

async function getDatabaseId() {
  try {
    // 移除 --remote 参数，使用默认的本地/远程自动检测
    const dbList = execSync('npx wrangler d1 list --json', { encoding: 'utf8' });
    const databases = JSON.parse(dbList);
    
    const db = databases.find(d => d.name === DATABASE_NAME);
    if (db) {
      return db.uuid;
    }
  } catch (error) {
    console.log('⚠️ 无法获取数据库列表:', error.message);
  }
  return null;
}

try {
  console.log('📦 检查 Wrangler 可用性...');
  execSync('npx wrangler --version', { stdio: 'inherit' });
  console.log('🔐 设置 Cloudflare 认证...');
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
    console.log('✅ Cloudflare 认证已设置');
  } else {
    console.warn('⚠️ Cloudflare 认证信息未提供，可能无法访问远程资源');
  }
  console.log('🗄️ 配置 D1 数据库绑定...');
  const databaseId = process.env.D1_DATABASE_ID;
  if (databaseId) {
    await updateWranglerConfig(databaseId);
    console.log(`✅ 已使用环境变量 D1_DATABASE_ID 更新数据库绑定: ${databaseId}`);
  } else {
    console.log('ℹ️ 未提供 D1_DATABASE_ID，跳过数据库绑定更新');
  }
  console.log('🔧 设置环境变量...');
 
  const envVars = [
    // 必需环境变量
    { name: 'ADMIN_PASSWORD', value: process.env.ADMIN_PASSWORD },
    { name: 'GUEST_PASSWORD', value: process.env.GUEST_PASSWORD },
    { name: 'JWT_TOKEN', value: process.env.JWT_TOKEN },
    { name: 'JWT_SECRET', value: process.env.JWT_SECRET },
    { name: 'MAIL_DOMAIN', value: process.env.MAIL_DOMAIN },
    { name: 'D1_DATABASE_ID', value: process.env.D1_DATABASE_ID },
    
    // 可选环境变量（不填写不影响项目正常使用）
    { name: 'ADMIN_NAME', value: process.env.ADMIN_NAME },
    { name: 'ADMIN_USERNAME', value: process.env.ADMIN_USERNAME },
    { name: 'ADMIN_PASS', value: process.env.ADMIN_PASS },
    { name: 'RESEND_API_KEY', value: process.env.RESEND_API_KEY },
    { name: 'RESEND_TOKEN', value: process.env.RESEND_TOKEN },
    { name: 'RESEND', value: process.env.RESEND },
    { name: 'SITE_MODE', value: process.env.SITE_MODE },
    { name: 'SHOW_DEMO_BANNER', value: process.env.SHOW_DEMO_BANNER },
    { name: 'FORWARD_RULES', value: process.env.FORWARD_RULES },
    { name: 'CACHE_TTL', value: process.env.CACHE_TTL },
    { name: 'TELEGRAM_BOT_TOKEN', value: process.env.TELEGRAM_BOT_TOKEN },
    { name: 'TELEGRAM_CHAT_ID', value: process.env.TELEGRAM_CHAT_ID },
    { name: 'MAX_EMAIL_SIZE', value: process.env.MAX_EMAIL_SIZE },
    { name: 'EMAIL_RETENTION_DAYS', value: process.env.EMAIL_RETENTION_DAYS },
    { name: 'GUEST_ENABLED', value: process.env.GUEST_ENABLED }
  ];

  for (const envVar of envVars) {
    const raw = Object.prototype.hasOwnProperty.call(process.env, envVar.name) ? process.env[envVar.name] : undefined;
    // 去除首尾空白：避免换行符导致密码/Token 校验失败
    const value = String(raw ?? '').trim();
    if (value) {
      try {
        execSync(`npx wrangler secret put ${envVar.name} --env=""`, {
          input: value,
          stdio: ['pipe', 'inherit', 'inherit']
        });
        console.log(`✅ 已同步环境变量: ${envVar.name}`);
      } catch (error) {
        console.warn(`⚠️ 同步环境变量 ${envVar.name} 失败:`, error.message);
      }
    } else {
      // 值为空时跳过，避免把仓库中未配置的 Secret（GitHub 会注入为空串）刷成空，
      // 导致管理员登录、Telegram 通知等功能失效。如需删除请手动执行删除。
      console.log(`⏭️ 跳过空的环境变量: ${envVar.name}（保留 Cloudflare 中已有值；如需删除请手动运行 npx wrangler secret delete ${envVar.name} --env=""）`);
    }
  }

  // 5. 生成前端环境配置文件 public/env.js（仅包含非敏感开关）
  console.log('📝 生成前端环境配置 public/env.js...');
  const rawSiteMode = String(process.env.SITE_MODE || '').trim().toLowerCase();
  const siteMode = rawSiteMode === 'demo' ? 'demo' : 'selfhost';
  const rawGuestEnabled = String(process.env.GUEST_ENABLED || '').trim().toLowerCase();
  const guestEnabled = rawGuestEnabled === 'true' || rawGuestEnabled === '1' || rawGuestEnabled === 'yes';
  const envJsContent =
    `window.__SITE_MODE__ = "${siteMode}";\n` +
    `window.__GUEST_ENABLED__ = ${guestEnabled ? 'true' : 'false'};\n`;
  writeFileSync('public/env.js', envJsContent, 'utf8');
  console.log('✅ 已写入 public/env.js，内容如下（仅非敏感开关）：');
  console.log(envJsContent);

  // 6. 构建项目
  console.log('🔨 构建项目...');
  execSync('npm run build', { stdio: 'inherit' });

  // 7. 部署到 Cloudflare Workers
  console.log('☁️ 部署到 Cloudflare Workers...');
  execSync('npx wrangler deploy --env=""', { stdio: 'inherit' });
  
  console.log('✅ 部署完成！');
} catch (error) {
  console.error('❌ 部署失败:', error.message);
  process.exit(1);
}
