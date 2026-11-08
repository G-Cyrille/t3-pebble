'use strict';
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
for (const name of fs.readdirSync(path.join(__dirname, '../src/pkjs'))) {
  if (name.endsWith('.js')) acorn.parse(fs.readFileSync(path.join(__dirname, '../src/pkjs', name), 'utf8'), {ecmaVersion: 5});
}
console.log('Compagnon compatible ES5.');

const config = require('../src/pkjs/config-page').replace('__INITIAL_CONFIG__', '{}');
acorn.parse(config.match(/<script>([\s\S]*)<\/script>/)[1], {ecmaVersion: 5});
