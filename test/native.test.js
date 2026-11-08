'use strict';
const {test} = require('node:test');
const {execFileSync} = require('node:child_process');
const {mkdtempSync, rmSync} = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');

test('la vraie liste C garde la sélection et les lignes valides pendant la pagination', () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-pebble-native-'));
  try {
    const binary = join(dir, 'list-test');
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-Isrc/c',
      'src/c/thread-list.c', 'test/thread-list.test.c', '-o', binary]);
    execFileSync(binary, {stdio: 'pipe'});
  } finally {rmSync(dir, {recursive: true, force: true});}
});
