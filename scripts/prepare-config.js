'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'config/index.html'), 'utf8').replace('__PAIRING_INPUT__', require('../src/pkjs/pairing-input').parse.toString()).replace('__CATALOGS__', JSON.stringify(require('../src/pkjs/catalogs.json').catalogs).replace(/</g, '\\u003c'));
fs.writeFileSync(path.join(root, 'src/pkjs/config-page.js'), "'use strict';\nmodule.exports = " + JSON.stringify(source) + ';\n');
