(function (global) {
  'use strict';

  function chromiumMajorVersion() {
    var ua = navigator.userAgent || '';
    var match = ua.match(/(?:Chrome|Chromium|CriOS)\/(\d+)/);
    return match ? Number(match[1]) : null;
  }

  function install() {
    var version = chromiumMajorVersion();

    // PDF.js 6 uses class static blocks and other syntax that cannot be
    // polyfilled. Chrome 94 is the first practical floor for this bundle.
    if (version !== null && version < 94) {
      return {
        supported: false,
        reason: '当前 Chrome 版本过低（需要 Chrome 94 或更高版本）',
      };
    }

    installPDFRuntimePolyfills(global);
    return { supported: true, chromiumVersion: version };
  }

  global.PDFCompat = { install: install };
})(window);

