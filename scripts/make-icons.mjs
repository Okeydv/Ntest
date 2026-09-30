// PNG-значки приложения из знака: белый полумесяц на #0a0a0a.
//   public/icons/icon-192.png, icon-512.png — знак крупно;
//   public/icons/icon-maskable-512.png — знак в безопасной зоне (80% в
//   центре): Android обрезает maskable-значок кругом или «капсулой».
// Запуск: node scripts/make-icons.mjs

import { launch } from './lib/browser.mjs';

const OUT = new URL('../public/icons/', import.meta.url).pathname;
// Знак в квадрате 32×32: круг с вырезом и точка-спутник.
const mark = scale => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
  <rect width="32" height="32" fill="#0a0a0a"/>
  <g transform="translate(16 16) scale(${scale}) translate(-16 -16)">
    <defs><mask id="c"><rect width="32" height="32" fill="#fff"/><circle cx="25.5" cy="7" r="9.5" fill="#000"/></mask></defs>
    <circle fill="#fafafa" cx="15" cy="17" r="11" mask="url(#c)"/>
    <circle fill="#fafafa" cx="25.5" cy="7" r="3.25"/>
  </g>
</svg>`;

const browser = await launch();
const page = await browser.newPage();
for (const [file, size, scale] of [['icon-192.png', 192, 0.72], ['icon-512.png', 512, 0.72], ['icon-maskable-512.png', 512, 0.56]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:#0a0a0a}svg{display:block}</style>${mark(scale)}`);
    await page.screenshot({ path: OUT + file, omitBackground: false });
}
await browser.close();
console.log('значки:', OUT);
