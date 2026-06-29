(function (global) {
  'use strict';

  function define(target, name, value) {
    if (target && typeof target[name] === 'undefined') {
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: value,
      });
    }
  }

  define(Promise, 'withResolvers', function () {
    var resolve;
    var reject;
    var promise = new Promise(function (res, rej) {
      resolve = res;
      reject = rej;
    });
    return { promise: promise, resolve: resolve, reject: reject };
  });

  define(Promise, 'try', function (callback) {
    return new Promise(function (resolve) {
      resolve(callback());
    });
  });

  define(Promise, 'allSettled', function (values) {
    return Promise.all(Array.from(values, function (value) {
      return Promise.resolve(value).then(function (result) {
        return { status: 'fulfilled', value: result };
      }, function (reason) {
        return { status: 'rejected', reason: reason };
      });
    }));
  });

  define(Object, 'hasOwn', function (object, property) {
    return Object.prototype.hasOwnProperty.call(object, property);
  });

  define(URL, 'parse', function (url, base) {
    try {
      return base === undefined ? new URL(url) : new URL(url, base);
    } catch (_error) {
      return null;
    }
  });

  define(Array.prototype, 'at', function (index) {
    var length = this.length >>> 0;
    var offset = Number(index) || 0;
    if (offset < 0) offset += length;
    return offset < 0 || offset >= length ? undefined : this[offset];
  });

  define(Array.prototype, 'findLast', function (callback, thisArg) {
    for (var index = this.length - 1; index >= 0; index -= 1) {
      if (callback.call(thisArg, this[index], index, this)) return this[index];
    }
    return undefined;
  });

  define(Array.prototype, 'findLastIndex', function (callback, thisArg) {
    for (var index = this.length - 1; index >= 0; index -= 1) {
      if (callback.call(thisArg, this[index], index, this)) return index;
    }
    return -1;
  });

  define(String.prototype, 'replaceAll', function (search, replacement) {
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError('replaceAll requires a global RegExp');
      return this.replace(search, replacement);
    }
    return this.split(String(search)).join(String(replacement));
  });

  define(Uint8Array, 'fromBase64', function (value) {
    var binary = global.atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  });

  define(Uint8Array.prototype, 'toHex', function () {
    var output = '';
    for (var index = 0; index < this.length; index += 1) {
      output += this[index].toString(16).padStart(2, '0');
    }
    return output;
  });

  define(global, 'structuredClone', function (value) {
    var seen = new Map();

    function clone(input) {
      if (input === null || typeof input !== 'object') return input;
      if (seen.has(input)) return seen.get(input);
      if (input instanceof Date) return new Date(input.getTime());
      if (input instanceof RegExp) return new RegExp(input.source, input.flags);
      if (input instanceof ArrayBuffer) return input.slice(0);
      if (ArrayBuffer.isView(input)) {
        var buffer = input.buffer.slice(0);
        if (input instanceof DataView) {
          return new DataView(buffer, input.byteOffset, input.byteLength);
        }
        return new input.constructor(buffer, input.byteOffset, input.length);
      }

      var output;
      if (input instanceof Map) {
        output = new Map();
        seen.set(input, output);
        input.forEach(function (item, key) {
          output.set(clone(key), clone(item));
        });
        return output;
      }
      if (input instanceof Set) {
        output = new Set();
        seen.set(input, output);
        input.forEach(function (item) {
          output.add(clone(item));
        });
        return output;
      }

      output = Array.isArray(input) ? [] : Object.create(Object.getPrototypeOf(input));
      seen.set(input, output);
      Object.keys(input).forEach(function (key) {
        output[key] = clone(input[key]);
      });
      return output;
    }

    return clone(value);
  });

  if (global.Response) {
    define(Response.prototype, 'bytes', function () {
      return this.arrayBuffer().then(function (buffer) {
        return new Uint8Array(buffer);
      });
    });
  }

  if (global.Blob) {
    define(Blob.prototype, 'bytes', function () {
      return this.arrayBuffer().then(function (buffer) {
        return new Uint8Array(buffer);
      });
    });
  }

  if (global.AbortSignal) {
    define(AbortSignal, 'any', function (signals) {
      var controller = new AbortController();
      Array.from(signals).forEach(function (signal) {
        if (signal.aborted) {
          controller.abort(signal.reason);
        } else {
          signal.addEventListener('abort', function () {
            controller.abort(signal.reason);
          }, { once: true });
        }
      });
      return controller.signal;
    });
  }

  // Exposed for the page bootstrap; importing this file in the module worker
  // installs the same polyfills in the worker global.
  global.installPDFRuntimePolyfills = function () {};
})(globalThis);
