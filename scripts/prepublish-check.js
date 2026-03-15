#!/usr/bin/env bun

const fs = require('fs');
const path = require('path');

console.log('📦 Pre-publish checks...\n');

// Check required files
const requiredFiles = [
  'cli.js',
  'cli-acp.js',
  'package.json',
  'yoga.wasm',
  '.npmrc',
  path.join('scripts', 'binary-utils.cjs'),
  path.join('dist', 'index.js'),
  path.join('dist', 'package.json'),
  path.join('dist', 'yoga.wasm'),
];
const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));

if (missingFiles.length > 0) {
  console.error('❌ Missing required files:', missingFiles.join(', '));
  console.error('   Run "bun run build" first');
  process.exit(1);
}

// Check cli.js is executable
const cliStats = fs.statSync('cli.js');
if (!(cliStats.mode & 0o100)) {
  console.error('❌ cli.js is not executable');
  process.exit(1);
}

// Check cli-acp.js is executable
const acpStats = fs.statSync('cli-acp.js');
if (!(acpStats.mode & 0o100)) {
  console.error('❌ cli-acp.js is not executable');
  process.exit(1);
}

// Check package.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

if (!pkg.bin || !pkg.bin.cpaper) {
  console.error('❌ Missing bin field in package.json');
  process.exit(1);
}

// Bundled dependencies check removed - not needed for this package structure

console.log('✅ All checks passed!');
console.log('\n📋 Package info:');
console.log(`   Name: ${pkg.name}`);
console.log(`   Version: ${pkg.version}`);
console.log(`   Main: ${pkg.main}`);
console.log(`   Bin: cpaper -> ${pkg.bin.cpaper}`);
console.log('\n🚀 Ready to publish!');
console.log('   Run: npm publish');
