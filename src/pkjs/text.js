'use strict';
var i18n = require('./i18n');
function bytes(text) { return unescape(encodeURIComponent(text)).length; }
function clip(text, limit) {
  text = String(text || '');
  var result = '', i, ch;
  for (i = 0; i < text.length; i++) {
    ch = text.charAt(i);
    if (ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdbff && i + 1 < text.length) ch += text.charAt(++i);
    if (bytes(result + ch) > limit) break;
    result += ch;
  }
  return result;
}
function readable(text) {
  return String(text || '').replace(/\r\n?/g, '\n')
    .replace(/^\s*```[^\n]*\n/gm, '').replace(/^\s*```\s*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '').replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '[' + i18n.t('image') + ': $1]')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
    .replace(/\*\*([^\n]+?)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').trim();
}
function chunks(text, limit) {
  var result = [], part, cut;
  text = readable(text);
  if (!text) return [''];
  while (text.length) {
    part = clip(text, limit);
    if (part.length < text.length) {
      cut = Math.max(part.lastIndexOf('\n'), part.lastIndexOf(' '));
      if (cut > part.length * 0.55) part = part.slice(0, cut + 1);
    }
    result.push(part);
    text = text.slice(part.length);
  }
  return result;
}
module.exports = {bytes: bytes, clip: clip, readable: readable, chunks: chunks};
