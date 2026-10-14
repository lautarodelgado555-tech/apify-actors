import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedResponse } from '../src/http.js';

test('login wall redirect is detected as blocked', () => {
    assert.equal(isBlockedResponse({ status: 200, finalUrl: 'https://www.mercadolibre.com.ar/gz/account-verification?go=x', text: '' }), true);
    assert.equal(isBlockedResponse({ status: 200, finalUrl: 'https://www.mercadolibre.com.ar/tienda/bgh', text: '<html></html>' }), false);
});
