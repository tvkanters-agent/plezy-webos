const {defineConfig} = require('@playwright/test');
module.exports = defineConfig({testDir:'test',testMatch:'*.spec.cjs',fullyParallel:true,
  use:{baseURL:'http://127.0.0.1:8181',viewport:{width:1920,height:1080},headless:true},
  webServer:{command:'node scripts/serve.mjs',url:'http://127.0.0.1:8181',reuseExistingServer:false},
  reporter:'list'});
