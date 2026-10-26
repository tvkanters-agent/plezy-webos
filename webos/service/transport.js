// SPDX-License-Identifier: GPL-3.0-only
// Narrow, read-only transport for SimklClient.getRedirectLocation/getDetail.
// Never follows redirects or stores/logs credentials; TLS verification stays on.
var https = require('https');
exports.request = function (payload, respond, http) {
  var path = payload && payload.path;
  var auth = payload && payload.authorization;
  if (typeof path !== 'string' || path.length > 4096 ||
      !/^\/(redirect|(?:movies|tv|anime)\/[1-9][0-9]*)(?:\?[^\s#]*)?$/.test(path) ||
      typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]+$/.test(auth)) {
    respond({returnValue:false, errorText:'Invalid catalog request.'}); return;
  }
  var done = false, timer;
  function finish(result) {
    if (done) return;
    done = true; clearTimeout(timer); respond(result);
  }
  var req = (http || https).get({hostname:'api.simkl.com', port:443, path:path,
    headers:{Accept:'application/json', Authorization:auth}}, function (res) {
    var body = '', size = 0;
    res.setEncoding('utf8');
    res.on('data', function (chunk) {
      size += chunk.length;
      if (size > 1048576) { finish({returnValue:false}); req.abort(); return; }
      body += chunk;
    });
    res.on('error', function () { finish({returnValue:false}); });
    res.on('end', function () {
      finish({returnValue:true, status:res.statusCode, body:body,
        headers:{location:res.headers.location || '', 'retry-after':res.headers['retry-after'] || ''}});
    });
  });
  req.on('error', function () { finish({returnValue:false}); });
  timer = setTimeout(function () { finish({returnValue:false}); req.abort(); }, 15000);
};
