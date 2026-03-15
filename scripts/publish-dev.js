#!/usr/bin/env node

const { execSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const path = require('path');

/**
 * 发布开发版本到 npm
 * 使用 -dev tag，版本号自动递增 dev 后缀
 * 不涉及 git 操作，专注于 npm 发布
 */
async function publishDev() {
  try {
    console.log('🚀 Starting dev version publish process...\n');

    // 1. 读取当前版本
    const packagePath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const baseVersion = packageJson.version;

    console.log(`📦 Current base version: ${baseVersion}`);

    // 2. 生成开发版本号
    let devVersion;
    try {
      // 获取当前 dev tag 的最新版本
      const npmResult = execSync(`npm view @claude-paper/cli@dev version`, { encoding: 'utf8' }).trim();
      const currentDevVersion = npmResult;
      
      if (currentDevVersion.startsWith(baseVersion + '-dev.')) {
        const devNumber = parseInt(currentDevVersion.split('-dev.')[1]) + 1;
        devVersion = `${baseVersion}-dev.${devNumber}`;
      } else {
        devVersion = `${baseVersion}-dev.1`;
      }
    } catch {
      // 如果没有找到现有的 dev 版本，从 1 开始
      devVersion = `${baseVersion}-dev.1`;
    }

    console.log(`📦 Publishing version: ${devVersion} with tag 'dev'`);

    // 3. 临时更新 package.json 版本号
    const originalPackageJson = { ...packageJson };
    packageJson.version = devVersion;
    writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));

    // 4. 构建项目
    console.log('🔨 Building project...');
    execSync('npm run build', { stdio: 'inherit' });

    // 5. 运行预发布检查
    console.log('🔍 Running pre-publish checks...');
    execSync('bun run scripts/prepublish-check.js', { stdio: 'inherit' });

    // 6. 发布到 npm 的 dev tag
    console.log('📤 Publishing to npm...');
    execSync(`npm publish --tag dev --access public`, { stdio: 'inherit' });

    // 7. 恢复原始 package.json
    writeFileSync(packagePath, JSON.stringify(originalPackageJson, null, 2));

    console.log('\n✅ Dev version published successfully!');
    console.log(`📦 Version: ${devVersion}`);
    console.log(`🔗 Install with: npm install -g @claude-paper/cli@dev`);
    console.log(`🔗 Or: npm install -g @claude-paper/cli@${devVersion}`);
    console.log(`📊 View on npm: https://www.npmjs.com/package/@claude-paper/cli/v/${devVersion}`);

  } catch (error) {
    console.error('❌ Dev publish failed:', error.message);
    
    // 尝试恢复 package.json
    try {
      const packagePath = path.join(process.cwd(), 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (packageJson.version.includes('-dev.')) {
        // 恢复到基础版本
        const baseVersion = packageJson.version.split('-dev.')[0];
        packageJson.version = baseVersion;
        writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
        console.log('🔄 Restored package.json version');
      }
    } catch {}
    
    process.exit(1);
  }
}

publishDev();
