#!/usr/bin/env node
// Static dev server for manual checks: node tests/serve.js  -> prints the app URL
'use strict';
const { startServer } = require('./lib/harness');

startServer().then(({ url }) => {
    console.log(`Fluid Identity dev server: ${url}`);
});
