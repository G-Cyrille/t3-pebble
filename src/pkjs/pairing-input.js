'use strict';
// Kept self-contained so the offline settings page can embed the same parser.
function parse(input) {
  function params(raw) {
    var values = Object.create(null);
    if (!raw) return values;
    raw.split('&').forEach(function (part) {
      var split = part.indexOf('='), key = decodeURIComponent((split < 0 ? part : part.slice(0, split)).replace(/\+/g, ' '));
      if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error('Duplicate parameter');
      values[key] = decodeURIComponent((split < 0 ? '' : part.slice(split + 1)).replace(/\+/g, ' '));
    });
    return values;
  }
  function origin(value) {
    var match = /^(https?):\/\/(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?\/?$/i.exec(value);
    if (!match || (match[3] && (+match[3] < 1 || +match[3] > 65535))) return null;
    return match[1].toLowerCase() + '://' + match[2].toLowerCase() + (match[3] ? ':' + match[3] : '');
  }
  try {
    var value = String(input || '').trim(), wrapper = /^t3code:\/\/pair\/?\?([^#]+)$/i.exec(value);
    if (wrapper) value = params(wrapper[1]).pairingUrl || '';
    var match = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
    if (!match || !origin(match[1])) return null;
    var query = params(match[3]), hash = params(match[4]);
    var code = (hash.token || '').trim() || (query.token || '').trim();
    if (!code) return !match[3] && !match[4] && (!match[2] || match[2] === '/') ? {url: origin(match[1]), code: ''} : null;
    if (match[2] && !/^\/(?:pair\/?)?$/.test(match[2])) return null;
    var target = query.host === undefined ? match[1] : query.host.trim();
    var url = origin(target);
    return url ? {url: url, code: code} : null;
  } catch (_) { return null; }
}
module.exports = {parse: parse};
