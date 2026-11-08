'use strict';
var catalogs = require('./catalogs.json').catalogs;
var language = 'en';
function set(code) { language = Object.prototype.hasOwnProperty.call(catalogs, code) ? code : 'en'; return language; }
function t(key) { return catalogs[language].strings[key] === undefined ? catalogs.en.strings[key] || key : catalogs[language].strings[key]; }
module.exports = {set: set, t: t, language: function () { return language; }, catalogs: catalogs};
