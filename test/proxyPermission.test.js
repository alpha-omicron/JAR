'use strict';

const assert = require('assert');
const {
  allowsProxy, isProxyForbiddenResponse, proxyForbiddenError,
} = require('../src/proxyPermission');

assert.strictEqual(allowsProxy(null), true);
assert.strictEqual(allowsProxy({}), true);
assert.strictEqual(allowsProxy({ allow_proxy: true }), true);
assert.strictEqual(allowsProxy({ allow_proxy: false }), false);

assert.strictEqual(isProxyForbiddenResponse(403, 'Proxies are forbidden for this character'), true);
assert.strictEqual(isProxyForbiddenResponse(403, 'proxy generation is forbidden'), true);
assert.strictEqual(isProxyForbiddenResponse(403, 'forbidden response'), false);
assert.strictEqual(isProxyForbiddenResponse(500, 'Proxies are forbidden for this character'), false);
assert.match(proxyForbiddenError().message, /forbids proxy generation/i);

console.log('proxy permission tests passed');
