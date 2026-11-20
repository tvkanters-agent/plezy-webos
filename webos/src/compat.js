// SPDX-License-Identifier: GPL-3.0-only
// Compatibility primitives needed by the Chromium 53 engine in webOS TV 4.x.
// All shims are conditional; newer webOS versions keep their native APIs.
(function () {
  // Media Captions uses values when finishing SRT parsing and entries when
  // rendering markup. Both arrived in Chromium 54, after our TV's Chromium 53.
  // Without these, subtitles silently fall back to Plex burn-in and sync
  // adjustments cannot change the already-rendered video pixels.
  if (!Object.values) {
    Object.defineProperty(Object, 'values', {configurable: true, writable: true,
      value: function (object) {
        return Object.keys(object).map(function (key) { return object[key]; });
      }});
  }
  if (!Object.entries) {
    Object.defineProperty(Object, 'entries', {configurable: true, writable: true,
      value: function (object) {
        return Object.keys(object).map(function (key) { return [key, object[key]]; });
      }});
  }
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (length, padding) {
      var value = String(this), fill = padding === undefined ? ' ' : String(padding);
      if (fill.length === 0) return value;
      while (value.length < length) value = fill.slice(0, length - value.length) + value;
      return value;
    };
  }
  // Media Captions normalizes ASS centiseconds to milliseconds with padEnd.
  if (!String.prototype.padEnd) {
    String.prototype.padEnd = function (length, padding) {
      var value = String(this), fill = padding === undefined ? ' ' : String(padding);
      if (!fill) return value;
      while (value.length < length) value += fill.slice(0, length - value.length);
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

  // Media Captions observes overlay size. Chromium 53 predates ResizeObserver,
  // but the TV player changes size on window resize/fullscreen only.
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = function (callback) {
      var observed = null;
      var resize = function () {
        if (observed) callback([{target:observed,
          contentRect:observed.getBoundingClientRect()}]);
      };
      this.observe = function (element) {
        observed = element;
        window.addEventListener('resize', resize);
        setTimeout(resize, 0);
      };
      this.unobserve = function (element) {
        if (observed === element) {
          observed = null;
          window.removeEventListener('resize', resize);
        }
      };
      this.disconnect = function () {
        observed = null;
        window.removeEventListener('resize', resize);
      };
    };
  }

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
