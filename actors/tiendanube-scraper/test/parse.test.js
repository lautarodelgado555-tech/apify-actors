import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    buildProductItem,
    decodeEntities,
    extractContacts,
    fingerprint,
    isChallengePage,
    looksLikeTiendanube,
    maybeGunzip,
    normalizeInput,
    parseListingLinks,
    parseProductPage,
    parseRobots,
    parseSince,
    parseSitemap,
    parseStoreProfile,
    productEntries,
    productSlug,
    snapshotDecision,
    unescapeJs,
} from '../src/tiendanube.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const build = (parsed, url) => buildProductItem(parsed, { url, store: null, lastmod: null, scrapedAt: '2026-10-14T00:00:00.000Z' });

test('normalizeInput accepts domains, store URLs and product URLs', () => {
    assert.deepEqual(normalizeInput('tallertextildoscoyotes.mitiendanube.com'), {
        origin: 'https://tallertextildoscoyotes.mitiendanube.com',
        host: 'tallertextildoscoyotes.mitiendanube.com',
        kind: 'store',
        url: 'https://tallertextildoscoyotes.mitiendanube.com/',
    });
    assert.equal(normalizeInput('https://www.vegpet.com.br/produtos/').kind, 'store');
    assert.equal(normalizeInput('https://peek-store.com/productos/tisha-bendiceme/').kind, 'product');
    assert.equal(normalizeInput('https://x.mitiendanube.com/es/productos/algo/').kind, 'product');
    assert.equal(normalizeInput('https://x.mitiendanube.com/remeras/').kind, 'listing');
});

test('normalizeInput rejects things that are not domains', () => {
    for (const bad of ['', '   ', 'not a domain', 'localhost', '127.0.0.1', 'http://', null, undefined]) {
        assert.equal(normalizeInput(bad), null, String(bad));
    }
});

test('parseSince understands ISO dates and relative values', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    assert.equal(parseSince('2026-10-01', now), Date.parse('2026-10-01'));
    assert.equal(parseSince('7 days', now), now - 7 * 86400e3);
    assert.equal(parseSince('12h', now), now - 12 * 3600e3);
    assert.equal(parseSince('2 weeks', now), now - 14 * 86400e3);
    assert.equal(parseSince('', now), null);
    assert.equal(parseSince('banana', now), null);
});

test('text helpers', () => {
    assert.equal(decodeEntities('lana &quot;negra&quot; &amp; m&#225;s'), 'lana "negra" & más');
    assert.equal(unescapeJs('Pulsera\\u0020Baloon\\u0020Mini'), 'Pulsera Baloon Mini');
    const gz = zlib.gzipSync(Buffer.from('hola'));
    assert.equal(maybeGunzip(gz).toString(), 'hola');
    assert.equal(maybeGunzip(Buffer.from('plain')).toString(), 'plain');
});

test('robots.txt identifies the platform and lists the gzipped sitemap', () => {
    const r = parseRobots(fx('robots.txt'));
    assert.equal(r.isTiendanube, true);
    assert.deepEqual(r.sitemaps, ['https://dcdn-us.mitiendanube.com/stores/002/364/194/themes/common/sitemap.xml.gz']);
    assert.equal(parseRobots('User-agent: *\nDisallow: /').isTiendanube, false);
});

test('sitemap: products, lastmod and images are extracted; non-product pages ignored', () => {
    const sm = parseSitemap(fx('sitemap-store.xml'));
    assert.equal(sm.isIndex, false);
    assert.equal(sm.entries.length, 29);
    const products = productEntries(sm.entries);
    assert.ok(products.length >= 15 && products.length < 29, `products=${products.length}`);
    assert.ok(products.every((p) => productSlug(p.loc)));
    assert.ok(!products.some((p) => /\/mx\/productos\/$/.test(p.loc)), 'the catalog root is not a product');
});

test('sitemap: a real store sitemap carries lastmod and image:loc', () => {
    const sm = parseSitemap(fx('sitemap-br.xml'));
    const products = productEntries(sm.entries);
    assert.ok(products.length > 100, `products=${products.length}`);
    assert.ok(products.some((p) => p.lastmod && p.lastmod > Date.parse('2020-01-01')));
    assert.ok(products.some((p) => p.images.length > 0));
    assert.ok(products.every((p) => /\/produtos\//.test(p.loc)));
});

test('sitemap: a truncated file still yields the complete entries and the blog link is not a product', () => {
    const sm = parseSitemap(fx('sitemap-urlset.xml'));
    assert.ok(sm.entries.length > 20);
    const slugs = productEntries(sm.entries).map((p) => productSlug(p.loc));
    assert.ok(!slugs.includes('blog'));
});

test('sitemap index (real tiendanube.com file) is recognised', () => {
    const sm = parseSitemap(fx('sitemapindex.xml'));
    assert.equal(sm.isIndex, true);
    assert.ok(sm.entries.length >= 5);
    assert.ok(sm.entries.every((e) => /^https:\/\//.test(e.loc)));
});

test('stores list every language: one entry per slug', () => {
    const entries = [
        { loc: 'https://s.mitiendanube.com/productos/a/' },
        { loc: 'https://s.mitiendanube.com/es/productos/a/' },
        { loc: 'https://s.mitiendanube.com/mx/productos/b' },
        { loc: 'https://s.mitiendanube.com/productos/' },
        { loc: 'https://s.mitiendanube.com/blog/' },
    ];
    assert.deepEqual(productEntries(entries).map((e) => productSlug(e.loc)), ['a', 'b']);
});

test('classic product with a single variant (Cocora, MX)', () => {
    const url = 'https://cocora.mitiendanube.com/productos/pulsera-baloon-mini/';
    const parsed = parseProductPage(fx('classic-simple.html'), url);
    assert.equal(parsed.engine, 'classic');
    const item = build(parsed, url);
    assert.equal(item.productId, 150739149);
    assert.equal(item.name, 'Pulsera Baloon Mini');
    assert.equal(item.price, 400);
    assert.equal(item.currency, 'MXN');
    assert.equal(item.country, 'MX');
    assert.equal(item.storeName, 'Cocora');
    assert.equal(item.availability, 'InStock');
    assert.equal(item.stockTotal, 4);
    assert.deepEqual(item.categories, ['Pulseras']);
    assert.equal(item.variantCount, 1);
    assert.equal(item.weightKg, 0.015);
    assert.equal(item.platform, 'tiendanube');
    assert.match(item.description, /^Pulsera de balines mini dorada/);
    assert.match(item.images[0], /^https:\/\/dcdn-us\.mitiendanube\.com\/stores\/002\/364\/194\/products\/.*-1024-1024\.webp$/);
});

test('classic product with option names and per-variant stock (Taller Textil, MX)', () => {
    const url = 'https://tallertextildoscoyotes.mitiendanube.com/productos/hilo-de-lana-50-gramos/';
    const item = build(parseProductPage(fx('classic-variants.html'), url), url);
    assert.equal(item.variantCount, 6);
    assert.deepEqual(item.variants[0].attributes, { 'Tipo de Hilo': '2-3 mm crudo' });
    assert.equal(item.variants[0].available, false);
    assert.equal(item.variants[1].stock, 5);
    assert.equal(item.priceMin, 30);
    assert.equal(item.priceMax, 35);
    assert.equal(item.stockTotal, 12);
    assert.deepEqual(item.categories, ['Materiales', 'Materiales para Crochet & Agujas']);
    assert.ok(item.images.length >= 5);
    assert.equal(new Set(item.images).size, item.images.length, 'images are deduplicated');
});

test('classic product under a language prefix keeps tags and drops the generic breadcrumb level (EUR store)', () => {
    const url = 'https://littleprincessbypaulinado.mitiendanube.com/es/productos/tutu-para-bebe-con-bandita-incluida/';
    const item = build(parseProductPage(fx('classic-langprefix.html'), url), url);
    assert.equal(item.currency, 'EUR');
    assert.equal(item.price, 13.15);
    assert.deepEqual(item.tags, ['bebe', 'tutu']);
    assert.deepEqual(item.categories, []);
    assert.equal(item.variants[0].attributes.Color, 'Rojo');
    assert.equal(item.variantCount, 6);
    assert.equal(productSlug(url), 'tutu-para-bebe-con-bandita-incluida');
});

test('Nuvemshop (Brazil) product: brand, SKU, installments', () => {
    const url = 'https://www.vegpet.com.br/produtos/gold-neem-suplemento-natural-para-caes-50g/';
    const item = build(parseProductPage(fx('classic-br.html'), url), url);
    assert.equal(item.platform, 'nuvemshop');
    assert.equal(item.country, 'BR');
    assert.equal(item.currency, 'BRL');
    assert.equal(item.brand, 'Gold Neem');
    assert.equal(item.sku, '789892313834');
    assert.equal(item.price, 49.9);
    assert.equal(item.storeDomain, 'vegpet.com.br');
    assert.deepEqual(item.tags, ['GoldNeem', 'cães', 'natural', 'suplemento', 'vegetal']);
    assert.equal(item.installments.maxInstallments, 12);
    assert.equal(item.installments.maxInterestFreeInstallments, 3);
    assert.equal(item.installments.interestFreeInstallmentValue, 16.63);
});

test('a deleted product answers 200 with the 404 template and is not returned as a product', () => {
    const url = 'https://dailyskincaremx.com/productos/locion-corporal-eucerin-urearepair-plus-10-de-urea-pad6e/';
    assert.equal(parseProductPage(fx('classic-ldcomma.html'), url), null);
});

test('next-generation storefront (Peek Store): product object comes from the RSC payload', () => {
    const url = 'https://peek-store.com/productos/tisha-bendiceme/';
    const parsed = parseProductPage(fx('next-product.html'), url);
    assert.equal(parsed.engine, 'next');
    const item = build(parsed, url);
    assert.equal(item.productId, 321284040);
    assert.equal(item.name, 'Tisha Bendíceme');
    assert.equal(item.price, 600);
    assert.equal(item.currency, 'MXN');
    assert.equal(item.country, 'MX');
    assert.equal(item.storeName, 'Peek Store');
    assert.equal(item.variantCount, 2);
    assert.deepEqual(item.variants.map((v) => v.attributes), [{ Color: 'NEGRA' }, { Color: 'BLANCA' }]);
    assert.deepEqual(item.variants.map((v) => v.stock), [0, 1]);
    assert.equal(item.availability, 'InStock');
    assert.equal(item.stockTotal, 1);
    assert.deepEqual(item.categories, ['By Charles Ans']);
    assert.equal(item.images.length, 4);
    assert.equal(item.lastModified, '2026-10-11T19:09:55.000Z');
});

test('pricing: compare-at price, discount and unlimited stock', () => {
    const parsed = {
        engine: 'classic', productId: 1, name: 'X', brand: null, description: null, categories: [], tags: [], images: [],
        weightKg: null, currency: 'ARS', country: 'AR', language: 'es_AR', storeName: 'S', ldSku: null,
        variants: [
            { id: 1, sku: 'A', price: 80, compareAtPrice: 100, promotionalPrice: null, stock: null, available: true, attributes: {}, image: null, _installments: null },
            { id: 2, sku: 'B', price: 90, compareAtPrice: null, promotionalPrice: null, stock: 3, available: true, attributes: {}, image: null, _installments: null },
        ],
    };
    const item = build(parsed, 'https://s.mitiendanube.com/productos/x/');
    assert.equal(item.price, 80);
    assert.equal(item.compareAtPrice, 100);
    assert.equal(item.onSale, true);
    assert.equal(item.discountPercent, 20);
    assert.equal(item.stockUnlimited, true);
    assert.equal(item.stockTotal, null);
    assert.equal(item.sku, 'A');
});

test('generic JSON-LD fallback tolerates trailing commas', () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Taza","offers":{"@type":"Offer","price":"10.5","priceCurrency":"USD","availability":"https://schema.org/InStock",},}</script></head></html>`;
    const parsed = parseProductPage(html, 'https://x.com/productos/taza/');
    assert.equal(parsed.engine, 'jsonld');
    assert.equal(build(parsed, 'https://x.com/productos/taza/').price, 10.5);
});

test('fingerprint changes when the price or stock changes, not otherwise', () => {
    const url = 'https://cocora.mitiendanube.com/productos/pulsera-baloon-mini/';
    const a = build(parseProductPage(fx('classic-simple.html'), url), url);
    const b = build(parseProductPage(fx('classic-simple.html'), url), url);
    assert.equal(fingerprint(a), fingerprint(b));
    b.variants[0].price = 450;
    b.price = 450;
    assert.notEqual(fingerprint(a), fingerprint(b));
    const c = build(parseProductPage(fx('classic-simple.html'), url), url);
    c.variants[0].stock = 3;
    assert.notEqual(fingerprint(a), fingerprint(c));
});

test('catalog listing page: product links, one per slug', () => {
    const links = parseListingLinks(fx('listing-classic.html'), 'https://tallertextildoscoyotes.mitiendanube.com/productos/');
    assert.equal(links.length, 12);
    assert.ok(links.every((l) => /^https:\/\/tallertextildoscoyotes\.mitiendanube\.com\/productos\/[^/]+\/$/.test(l)));
});

test('platform detection', () => {
    assert.equal(looksLikeTiendanube(fx('classic-simple.html')), true);
    assert.equal(looksLikeTiendanube(fx('next-product.html')), true);
    assert.equal(looksLikeTiendanube('<html><title>Example Domain</title></html>'), false);
    assert.equal(isChallengePage('<html><head><title>Just a moment...</title></head></html>'), true);
    assert.equal(isChallengePage(fx('classic-simple.html')), false);
});

test('store contacts from a classic storefront (home + contact page)', () => {
    const c = extractContacts(fx('home-classic-contacts.html'));
    assert.ok(c.whatsapp.includes('+527714253186'), JSON.stringify(c.whatsapp));
    assert.ok(c.phones.includes('7714253186'), JSON.stringify(c.phones));
    assert.match(c.socials.instagram, /instagram\.com\/dailyskincare\.mx$/);
    assert.match(c.socials.facebook, /facebook\.com\/Daily/);
    assert.ok(!c.emails.some((e) => /tiendanube|nuvemshop|sentry/.test(e)));
    const profile = parseStoreProfile(fx('home-classic-contacts.html'));
    assert.equal(profile.engine, 'classic');
    assert.equal(profile.country, 'MX');
    assert.equal(profile.currency, 'MXN');
    assert.ok(profile.name);
});

test('store profile from a next-generation storefront uses the embedded store object', () => {
    const p = parseStoreProfile(fx('next-product.html'));
    assert.equal(p.engine, 'next');
    assert.equal(p.name, 'Peek Store');
    assert.equal(p.country, 'MX');
    assert.equal(p.currency, 'MXN');
    assert.deepEqual(p.contacts.emails, ['peekstoremx@gmail.com']);
    assert.ok(p.contacts.whatsapp.includes('+523315301476'));
    assert.equal(p.contacts.socials.instagram, 'https://instagram.com/peekstoremx');
    assert.match(p.createdAt, /^2023-10-01/);
});

test('incremental snapshot: new, unchanged and changed products', () => {
    const url = 'https://cocora.mitiendanube.com/productos/pulsera-baloon-mini/';
    const item = build(parseProductPage(fx('classic-simple.html'), url), url);
    const hash = (x) => `h${x.length}:${x.slice(0, 20)}`;
    const snap = {};
    const first = snapshotDecision(snap, 'pulsera', item, hash);
    assert.equal(first.skip, false);
    assert.equal(first.changeType, 'new');
    snap.pulsera = first.fp;
    assert.equal(snapshotDecision(snap, 'pulsera', item, hash).skip, true);
    const cheaper = { ...item, price: 350, variants: item.variants.map((v) => ({ ...v, price: 350 })) };
    const again = snapshotDecision(snap, 'pulsera', cheaper, hash);
    assert.equal(again.skip, false);
    assert.equal(again.changeType, 'changed');
});
