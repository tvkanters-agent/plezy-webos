// SPDX-License-Identifier: GPL-3.0-only
// Dart can read an unfollowed Location; browser fetch returns an opaque redirect.
// Keep Plezy's HTTP flow, using the packaged Luna service on the TV.
export function simklCatalogRequest(url, options) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || typeof window.PalmServiceBridge !== 'function') {
      reject(new Error('Simkl catalog lookup requires the packaged webOS service.'));
      return;
    }
    const target = new URL(url);
    if (target.origin !== 'https://api.simkl.com') {
      reject(new Error('Invalid Simkl catalog host.')); return;
    }
    const bridge = new window.PalmServiceBridge();
    const timer = setTimeout(() => {
      bridge.cancel(); reject(new Error('Simkl catalog request timed out.'));
    }, 20000);
    bridge.onservicecallback = reply => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(reply);
        if (!result.returnValue) throw new Error('Simkl catalog service unavailable.');
        resolve({status:result.status, ok:result.status>=200&&result.status<300,
          headers:{get:name => result.headers[String(name).toLowerCase()] || null},
          json:async() => JSON.parse(result.body)});
      } catch (error) { reject(error); }
    };
    try {
      bridge.call('luna://com.tvkdevelopment.plezy.catalog/request', JSON.stringify({
        path:target.pathname+target.search, authorization:options.headers.Authorization
      }));
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
