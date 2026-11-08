'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const base = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json')));
const ids = ['en', ...fs.readdirSync(path.join(root, 'locales')).filter(n => n.endsWith('.json') && n !== 'en.json').map(n => n.slice(0, -5)).sort()];
const catalogs = {}, keys = Object.keys(base.strings);
if (keys.some(k => !/^[a-z][a-z0-9_]*$/.test(k))) throw new Error('Catalog keys must be snake_case identifiers.');
function placeholders(s) {return (s.match(/%(?:\d+\$)?[ds]|\{[a-z_]+\}/g) || []).join('|');}
for (const id of ids) {
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(id)) throw new Error('Invalid locale: ' + id);
  const value = JSON.parse(fs.readFileSync(path.join(root, 'locales', id + '.json')));
  if (!value.language || !value.strings) throw new Error('Missing language/strings: ' + id);
  for (const [key, text] of Object.entries(value.strings)) {
    if (!keys.includes(key)) throw new Error('Unknown key: ' + id + '/' + key);
    if (typeof text !== 'string' || placeholders(text) !== placeholders(base.strings[key])) throw new Error('Invalid text/placeholders: ' + id + '/' + key);
    if (key.startsWith('prompt_') && Buffer.byteLength(text) > 900) throw new Error('Prompt exceeds Bluetooth limit: ' + id + '/' + key);
  }
  catalogs[id] = {language: value.language, strings: {...base.strings, ...value.strings}};
}
const quoted = v => JSON.stringify(v);
const header = '// Generated from locales/*.json. Do not edit.\n#pragma once\n' +
  'typedef enum {\n' + keys.map(k => '  T_' + k.toUpperCase()).join(',\n') + '\n} TextId;\n' +
  'static const char *const i18n_languages[] = {' + ids.map(quoted).join(',') + '};\n' +
  'static const char *const i18n_strings[' + ids.length + '][' + keys.length + '] = {\n' + ids.map(id => '  {' + keys.map(k => quoted(catalogs[id].strings[k])).join(',\n   ') + '}').join(',\n') + '\n};\n' +
  'static int i18n_language(const char *code) { for (int i = 0; i < ' + ids.length + '; i++) if (!strcmp(code, i18n_languages[i])) return i; return 0; }\n' +
  'static const char *i18n_text(int language, TextId id) { return i18n_strings[language][id]; }\n';
function write(file, contents) {const p = path.join(root, file); if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== contents) fs.writeFileSync(p, contents);}
write('src/c/i18n-generated.h', header);
write('src/pkjs/catalogs.json', JSON.stringify({version: require('../package.json').version, catalogs}) + '\n');
console.log('Locales: ' + ids.join(', ') + '. English fallback validated.');
