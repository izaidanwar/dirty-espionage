#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const isWindows = os.platform() === 'win32';
function log(msg) { console.error(msg); }
function main() {
  log('');
  log('Starting Vercel deployment...');
  log('');
  const projectPath = path.resolve('frontend');
  log(`Deploying: ${projectPath}`);
  const result = spawnSync('npx', ['vercel', '--yes', '--prod'], {
    cwd: projectPath,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: 300000,
    shell: isWindows
  });
  const output = (result.stdout || '') + (result.stderr || '');
  log(output);
  const aliasedMatch = output.match(/Aliased:\s*(https:\/\/[a-zA-Z0-9.-]+\.vercel\.app)/i);
  const deploymentMatch = output.match(/Production:\s*(https:\/\/[a-zA-Z0-9.-]+\.vercel\.app)/i);
  const finalUrl = aliasedMatch ? aliasedMatch[1] : (deploymentMatch ? deploymentMatch[1] : null);
  if (result.status === 0 && finalUrl) {
    log('');
    log('Deployment successful!');
    console.log(JSON.stringify({ status: 'success', url: finalUrl }));
  } else if (result.status === 0) {
    console.log(JSON.stringify({ status: 'success', message: 'Deployed' }));
  } else {
    log('Deployment failed');
    process.exit(1);
  }
}
main();
