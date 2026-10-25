// SPDX-License-Identifier: GPL-3.0-only
// Compatibility primitives needed by the Chromium 53 engine in webOS TV 4.x.
// All shims are conditional; newer webOS versions keep their native APIs.
(function () {
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (length, padding) {
      var value = String(this), fill = padding === undefined ? ' ' : String(padding);
      if (fill.length === 0) return value;
      while (value.length < length) value = fill.slice(0, length - value.length) + value;
      return value;
    };
  }
  if (!Promise.prototype.finally) {
    Promise.prototype.finally = function (callback) {
      var C = this.constructor;
      return this.then(
        function (result) { return C.resolve(callback()).then(function () { return result; }); },
        function (error) { return C.resolve(callback()).then(function () { throw error; }); }
      );
    };
  }
  if (!Promise.allSettled) {
    Promise.allSettled = function (iterable) {
      return Promise.all(Array.from(iterable).map(function (entry) {
        return Promise.resolve(entry).then(
          function (value) { return {status: 'fulfilled', value: value}; },
          function (reason) { return {status: 'rejected', reason: reason}; }
        );
      }));
    };
  }
  function append() {
    for (var i = 0; i < arguments.length; ++i) {
      var item = arguments[i];
      this.appendChild(item && typeof item.nodeType === 'number'
        ? item : document.createTextNode(String(item)));
    }
  }
  if (typeof Element !== 'undefined' && !Element.prototype.append) Element.prototype.append = append;
  if (typeof DocumentFragment !== 'undefined' && !DocumentFragment.prototype.append) DocumentFragment.prototype.append = append;
  if (typeof Document !== 'undefined' && !Document.prototype.append) Document.prototype.append = append;

  // Chromium 53 lacks AbortController and fetch cancellation. Preserve the
  // same signal contract: aborting rejects the caller immediately. The native
  // network request may finish independently, but its result is ignored.
  if (typeof AbortController === 'undefined') {
    var AbortError = function () {
      var error = new Error('The request was aborted.');
      error.name = 'AbortError';
      return error;
    };
    window.AbortController = function () {
      var listeners = [];
      var signal = this.signal = {
        aborted: false,
        addEventListener: function (type, callback) {
          if (type === 'abort' && typeof callback === 'function') listeners.push(callback);
        },
        removeEventListener: function (type, callback) {
          if (type === 'abort') listeners = listeners.filter(function (entry) { return entry !== callback; });
        }
      };
      this.abort = function () {
        if (signal.aborted) return;
        signal.aborted = true;
        listeners.slice().forEach(function (listener) { listener(); });
        listeners = [];
      };
    };
    if (typeof window.fetch === 'function') {
      var nativeFetch = window.fetch;
      window.fetch = function (input, options) {
        var signal = options && options.signal;
        if (!signal || typeof signal.addEventListener !== 'function') {
          return nativeFetch.call(window, input, options);
        }
        return new Promise(function (resolve, reject) {
          if (signal.aborted) { reject(AbortError()); return; }
          var finished = false;
          var cancel = function () {
            if (finished) return;
            finished = true;
            signal.removeEventListener('abort', cancel);
            reject(AbortError());
          };
          signal.addEventListener('abort', cancel);
          try {
            nativeFetch.call(window, input, options).then(
              function (result) {
                if (finished) return;
                finished = true;
                signal.removeEventListener('abort', cancel);
                resolve(result);
              },
              function (error) {
                if (finished) return;
                finished = true;
                signal.removeEventListener('abort', cancel);
                reject(error);
              }
            );
          } catch (error) {
            if (!finished) {
              finished = true;
              signal.removeEventListener('abort', cancel);
              reject(error);
            }
          }
        });
      };
    }
  }
})();
