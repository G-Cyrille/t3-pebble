'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parse} = require('../src/pkjs/pairing-input');
const {origin} = require('../src/pkjs/client');

test('direct and hosted T3 links extract the server and one-time code', () => {
  for (const link of [
    'https://t3.example.org/pair#token=PAIRCODE',
    'https://t3.example.org/#token=PAIRCODE',
    'https://t3.example.org/pair?token=PAIRCODE',
    'https://app.t3.codes/pair?host=https%3A%2F%2Ft3.example.org%2F&label=My+server#token=PAIRCODE',
    't3code://pair?pairingUrl=' + encodeURIComponent('https://t3.example.org/pair#token=PAIRCODE')
  ]) assert.deepEqual(parse(link), {url: 'https://t3.example.org', code: 'PAIRCODE'});
  assert.deepEqual(parse('  http://100.100.100.100:7777/pair#token=CODE  '), {url: 'http://100.100.100.100:7777', code: 'CODE'});
});

test('manual origins remain available; fragment tokens take precedence like T3', () => {
  assert.deepEqual(parse('https://T3.example.org/'), {url: 'https://t3.example.org', code: ''});
  assert.deepEqual(parse('http://[::1]:7777'), {url: 'http://[::1]:7777', code: ''});
  assert.equal(parse('https://t3.example.org/pair?token=OLD#token=A%2BB').code, 'A+B');
});

test('malformed and ambiguous links are rejected without guessing a target', () => {
  for (const link of [
    '', 'javascript:alert(1)', 'https://user:password@t3.example.org/pair#token=X',
    'https://t3.example.org:65536/pair#token=X', 'https://t3.example.org/pair#token=',
    'https://t3.example.org/pair#token=%xx', 'https://t3.example.org/pair#token=A&token=B',
    'https://app.t3.codes/pair?host=#token=X',
    'https://app.t3.codes/pair?host=https%3A%2F%2Ft3.example.org%2Fprivate#token=X',
    'https://app.t3.codes/pair?host=https%3A%2F%2Ft3.example.org%3Ftoken%3DOTHER#token=X',
    'https://app.t3.codes/pair?host=https%3A%2F%2Ft3.example.org',
    'https://t3.example.org/private#token=X', 'https://t3.example.org?unrelated=1',
    't3code://pair?pairingUrl=' + encodeURIComponent('t3code://pair?pairingUrl=wrong')
  ]) assert.equal(parse(link), null, link);
});

test('extracting a pairing link does not bypass HTTPS and VPN restrictions', () => {
  const target = parse('https://app.t3.codes/pair?host=http%3A%2F%2Fpublic.example.org#token=CODE');
  assert.throws(() => origin(target.url));
});
