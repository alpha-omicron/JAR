'use strict';

const assert = require('assert');
const http = require('http');
const { chromium } = require('playwright');
const { downloadAvatar } = require('../src/capture');

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

(async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXkAAAAASUVORK5CYII=', 'base64');
  const origin = await listen((_req, res) => res.end('page'));
  const cdn = await listen((req, res) => {
    if (req.url === '/error') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('blocked');
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(image);
    }
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${origin.address().port}/`);
    const cdnUrl = `http://127.0.0.1:${cdn.address().port}`;
    assert.strictEqual(await downloadAvatar(page, `${cdnUrl}/avatar`), `data:image/png;base64,${image.toString('base64')}`);
    assert.strictEqual(await downloadAvatar(page, `${cdnUrl}/error`), '');
    assert.strictEqual(context.pages().length, 1, 'temporary image tabs are closed');
    await context.close();
    console.log('avatar download tests passed');
  } finally {
    await browser.close();
    await Promise.all([origin, cdn].map((server) => new Promise((resolve) => server.close(resolve))));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
