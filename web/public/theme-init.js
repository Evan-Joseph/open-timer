// 防闪白：在 React 加载前设置主题。
// 外置为独立文件（而非内联脚本），使 CSP script-src 'self' 无需 'unsafe-inline'。
(function () {
  var t = localStorage.getItem('clock-theme') || 'auto';
  var dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
