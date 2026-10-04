#!/usr/bin/env node

/**
 * 部署前检查脚本
 * 确保数据库状态正常，避免部署失败
 */

const { execSync } = require('child_process');

async function preDeployCheck() {
    console.log('🔍 开始部署前检查...\n');
    
    try {
        // 1. 检查数据库是否存在
        console.log('📋 检查数据库状态...');
        const dbList = execSync('npx wrangler d1 list', { encoding: 'utf8' });
        
        if (!dbList.includes('temp_mail_db')) {
            console.log('❌ 数据库 temp_mail_db 不存在');
            console.log('💡 建议运行: npx wrangler d1 execute temp_mail_db --file=./d1-init.sql');
            process.exit(1);
        }
        
        console.log('✅ 数据库存在');
        
        // 2. 检查表结构
        console.log('🗃️  检查数据库表结构...');
        // 注意 1：SQL 字符串字面量用单引号，避免与外层 cmd 双引号在 Windows 上冲突
        // 注意 2：必须加 --remote 检查远端数据库，否则查到的是空的本地 D1
        const tableCheck = execSync(`npx wrangler d1 execute temp_mail_db --remote --json --command="SELECT name FROM sqlite_master WHERE type='table';"`, { encoding: 'utf8' });

        const requiredTables = ['mailboxes', 'messages', 'domains'];
        // wrangler v4 --json 输出格式：[{ results: [{name: '...'}, ...], ... }]
        let existingTables = [];
        try {
          const parsed = JSON.parse(tableCheck);
          existingTables = (parsed[0]?.results || []).map(r => r.name);
        } catch (_) {
          // 兼容旧版 ASCII 表格输出
          existingTables = tableCheck.match(/\| ([a-z_]+) \|/g)?.map(t => t.replace(/\| ([a-z_]+) \|/, '$1')) || [];
        }
        
        const missingTables = requiredTables.filter(table => !existingTables.includes(table));
        
        if (missingTables.length > 0) {
            console.log('❌ 缺少必要的表:', missingTables.join(', '));
            console.log('💡 建议运行: npx wrangler d1 execute temp_mail_db --file=./d1-init.sql');
            process.exit(1);
        }
        
        console.log('✅ 表结构完整');
        
        // 3. 检查环境变量
        console.log('🔧 检查环境变量配置...');
        try {
            const envCheck = execSync('npx wrangler secret list', { encoding: 'utf8' });
            if (!envCheck.includes('D1_DATABASE_ID')) {
                console.log('⚠️  环境变量 D1_DATABASE_ID 未设置，但数据库存在，可以继续部署');
            } else {
                console.log('✅ 环境变量已配置');
            }
        } catch (error) {
            console.log('⚠️  无法检查环境变量，但可以继续部署');
        }
        
        console.log('\n🎉 所有检查通过！可以安全部署');
        
    } catch (error) {
        console.error('❌ 检查失败:', error.message);
        process.exit(1);
    }
}

/**
 * 检查 wrangler.toml 配置
 */
function checkWranglerConfig() {
    console.log('📋 检查 wrangler.toml 配置...');
    
    try {
        const fs = require('fs');
        const tomlContent = fs.readFileSync('wrangler.toml', 'utf8');
        
        // 检查 binding 必须为 temp_mail_db
        const bindingMatch = tomlContent.match(/binding\s*=\s*"([^"]+)"/);
        if (!bindingMatch || bindingMatch[1] !== 'temp_mail_db') {
            console.error('❌ wrangler.toml 中 D1 数据库 binding 必须为 "temp_mail_db"');
            console.error('💡 请修改 wrangler.toml 中的 [[d1_databases]] binding 配置');
            process.exit(1);
        }
        
        console.log('✅ D1 数据库 binding 配置正确');
        
        // 检查 database_id 配置
        const databaseIdMatch = tomlContent.match(/database_id\s*=\s*"([^"]+)"/);
        if (!databaseIdMatch) {
            console.error('❌ wrangler.toml 中缺少 database_id 配置');
            process.exit(1);
        }
        
        const databaseId = databaseIdMatch[1];
        
        // 检查 database_id 是否为无效值
        if (databaseId === '' || databaseId === 'undefined') {
            console.error('❌ wrangler.toml 中 database_id 不能为空或 "undefined"');
            console.error('💡 请设置有效的 database_id');
            process.exit(1);
        }
        
        // 检查是否为形如 "${...}" 的占位符且未提供环境变量
        const placeholderRegex = /^\$\{([^}]+)\}$/;
        const placeholderMatch = databaseId.match(placeholderRegex);
        
        if (placeholderMatch) {
            const envVarName = placeholderMatch[1];
            if (!process.env[envVarName]) {
                console.error(`❌ wrangler.toml 中 database_id 为占位符 "${databaseId}"，但未提供环境变量 ${envVarName}`);
                console.error('💡 请在部署前设置环境变量或使用实际的 database_id');
                process.exit(1);
            }
        }
        
        console.log('✅ database_id 配置有效');
        
    } catch (error) {
        console.error('❌ 读取 wrangler.toml 失败:', error.message);
        process.exit(1);
    }
}

/**
 * 检查 server.js 的 logger 导入
 */
function checkServerLoggerImport() {
    console.log('📋 检查 server.js logger 导入...');
    
    try {
        const fs = require('fs');
        const serverContent = fs.readFileSync('src/server.js', 'utf8');
        
        // 检查是否包含 logger 导入语句
        const loggerImportRegex = /import\s+(?:\*\s+as\s+)?logger\s+from\s+['"]\.\/logger(?:\.js)?['"]/;
        const hasLoggerImport = loggerImportRegex.test(serverContent);
        
        if (!hasLoggerImport) {
            console.log('⚠️  WARNING: server.js 中未检测到显式的 logger 导入');
            console.log('💡 建议添加: import * as logger from \'./logger.js\'');
        } else {
            console.log('✅ logger 导入正确');
        }
        
    } catch (error) {
        console.error('❌ 读取 server.js 失败:', error.message);
        process.exit(1);
    }
}

async function enhancedPreDeployCheck() {
    console.log('🔍 开始部署前检查...\n');
    
    // 新增检查项
    checkWranglerConfig();
    checkServerLoggerImport();
    
    // 原有检查逻辑
    await preDeployCheck();
}

if (require.main === module) {
    enhancedPreDeployCheck();
}

module.exports = { preDeployCheck, enhancedPreDeployCheck };