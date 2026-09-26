// Chromium для браузерных тестов: с трассой Playwright на случай провала.
//
// Если задан TEST_ARTIFACTS (его ставит run-all-tests.sh), каждый контекст
// пишет трассу: снимки DOM, скриншоты, сеть, консоль. Провалился набор —
// трассы и скриншоты открытых страниц остаются в TEST_ARTIFACTS, их
// открывает `npx playwright show-trace <файл>`. Прошёл — всё стирается.
//
//   const browser = await launch();
//   ...
//   await finish(browser, fails);

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.TEST_ARTIFACTS || null;
const tracing = new Set();
const written = [];
const browsers = new Set();
let counter = 0;

const nextFile = (prefix, ext) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${prefix}-${++counter}.${ext}`);
    written.push(file);
    return file;
};

async function stopTrace(context) {
    if (!tracing.delete(context)) return;
    await context.tracing.stop({ path: nextFile('trace', 'zip') }).catch(() => {});
}

async function track(context) {
    if (!dir) return context;
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracing.add(context);
    // Контекст, закрытый посреди набора, сохраняет трассу сразу: к концу
    // набора её было бы уже не достать.
    const close = context.close.bind(context);
    context.close = async (...args) => { await stopTrace(context); return close(...args); };
    return context;
}

export async function launch(options = {}) {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, ...options });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => track(await newContext(...args));
    browsers.add(browser);
    return browser;
}

export async function launchPersistentContext(userDataDir, options = {}) {
    return track(await chromium.launchPersistentContext(userDataDir,
        { executablePath: process.env.CHROMIUM_PATH, ...options }));
}

export async function finish(browser, failed) {
    if (dir && failed) {
        for (const context of tracing) {
            for (const page of context.pages()) {
                await page.screenshot({ path: nextFile('screen', 'png'), fullPage: true }).catch(() => {});
            }
        }
    }
    for (const context of [...tracing]) await stopTrace(context);
    browsers.delete(browser);
    await browser.close();
    if (!dir) return;
    if (failed) {
        console.log(`\nтрассы и скриншоты: ${dir} (открыть трассу: npx playwright show-trace <файл>)`);
    } else {
        for (const file of written) fs.rmSync(file, { force: true });
    }
}

// Набор упал с исключением, не дойдя до finish, — трассы тоже нужны.
process.on('uncaughtException', async error => {
    console.error(error);
    for (const browser of [...browsers]) await finish(browser, true).catch(() => {});
    process.exit(1);
});
