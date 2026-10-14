// Pure parsing helpers for Tiendanube / Nuvemshop storefronts. No network access in here.
//
// Two storefront engines exist in the wild (both verified with live pages, see test/fixtures):
//   "classic": server-rendered theme with `LS.variants = [...]`, `LS.product`, `LS.store` and schema.org JSON-LD.
//   "next":    newer Next.js storefront; the product API object is embedded in the RSC flight data
//              (`self.__next_f.push([1,"..."])`) next to the store object (which carries the public contact data).
import * as cheerio from 'cheerio';
import zlib from 'node:zlib';

export const PRODUCT_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:productos|produtos|products)\/([^/?#]+)\/?$/i;
const LISTING_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:productos|produtos|products)\/?$/i;
const PLATFORM_EMAIL_DOMAINS = /(^|\.)(tiendanube|mitiendanube|nuvemshop|lojavirtualnuvem|sentry|wixpress|example|cloudfront|facebook|instagram|google|schema)\.[a-z.]+$/i;

// ---------------------------------------------------------------- generic helpers

const ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
    if (typeof s !== 'string') return s;
    return s
        .replace(/&(quot|amp|lt|gt|apos|nbsp|#39);/g, (_, e) => ENTITIES[e])
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function unescapeJs(s) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, c) => {
        if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
        if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
        if (c === 'n') return '\n';
        if (c === 't') return '\t';
        if (c === 'r') return '';
        return c;
    });
}

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : s);
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** Index of the bracket that closes the one at `start` (string aware), or -1. */
export function matchBracket(text, start) {
    const open = text[start];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i += 1) {
        const c = text[i];
        if (inStr) {
            if (c === '\\') i += 1;
            else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === open) depth += 1;
        else if (c === close) {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function parseJsonLoose(text) {
    try {
        return JSON.parse(text);
    } catch {
        try {
            return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
        } catch {
            return null;
        }
    }
}

export function maybeGunzip(buf) {
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try {
            return zlib.gunzipSync(buf);
        } catch {
            return buf;
        }
    }
    return buf;
}

// ---------------------------------------------------------------- input

/**
 * Turn what the user typed into something we can crawl.
 * Returns { origin, host, kind: 'store'|'product'|'listing', url } or null when it is not a usable URL/domain.
 */
export function normalizeInput(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    let u;
    try {
        u = new URL(s);
    } catch {
        return null;
    }
    const host = u.hostname.toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
    const path = u.pathname || '/';
    let kind = 'listing';
    if (path === '/' || path === '') kind = 'store';
    else if (LISTING_PATH_RE.test(path)) kind = 'store';
    else if (PRODUCT_PATH_RE.test(path)) kind = 'product';
    return { origin: `https://${host}`, host, kind, url: `https://${host}${path}${u.search}` };
}

/** Parse `since`: an ISO date/time or "7 days", "12 hours", "2 weeks". Returns epoch ms or null. */
export function parseSince(value, now = Date.now()) {
    if (!value) return null;
    const s = String(value).trim().toLowerCase();
    const rel = s.match(/^(\d+)\s*(h|hour|hours|d|day|days|w|week|weeks)$/);
    if (rel) {
        const n = Number(rel[1]);
        const unit = rel[2][0];
        return now - n * (unit === 'h' ? 3600e3 : unit === 'd' ? 86400e3 : 7 * 86400e3);
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------- robots / sitemaps

export function parseRobots(text) {
    const sitemaps = [...text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
    const isTiendanube = /we use (tiendanube|nuvemshop|nuvem shop) as our ecommerce platform/i.test(text);
    return { sitemaps, isTiendanube };
}

/** Parse a sitemap or sitemap index. Entries: { loc, lastmod (ms or null), images } */
export function parseSitemap(xml) {
    const isIndex = /<sitemapindex/i.test(xml);
    const tag = isIndex ? 'sitemap' : 'url';
    const entries = [];
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
    let m;
    while ((m = re.exec(xml))) {
        const block = m[1];
        const loc = (block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i) || [])[1];
        if (!loc) continue;
        const lm = (block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i) || [])[1];
        const images = [...block.matchAll(/<image:loc>\s*([^<]+?)\s*<\/image:loc>/gi)].map((x) => decodeEntities(x[1]));
        entries.push({ loc: decodeEntities(loc), lastmod: lm && !Number.isNaN(Date.parse(lm)) ? Date.parse(lm) : null, images });
    }
    return { isIndex, entries };
}

/** Slug of a product URL (language prefix and trailing slash ignored) or null when it is not a product page. */
export function productSlug(url) {
    try {
        const m = new URL(url).pathname.match(PRODUCT_PATH_RE);
        return m ? decodeURIComponent(m[1]).toLowerCase() : null;
    } catch {
        return null;
    }
}

/** Keep only product entries, one per slug (stores list every language variant). */
export function productEntries(entries) {
    const seen = new Map();
    for (const e of entries) {
        const slug = productSlug(e.loc);
        if (!slug) continue;
        if (!seen.has(slug)) seen.set(slug, e);
    }
    return [...seen.values()];
}

/** Product links found on a listing page (category or /productos/). */
export function parseListingLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const out = new Map();
    $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        let abs;
        try {
            abs = new URL(href, baseUrl);
        } catch {
            return;
        }
        const slug = productSlug(abs.href);
        if (slug && !out.has(slug)) out.set(slug, `${abs.origin}${abs.pathname}`);
    });
    return [...out.values()];
}

// ---------------------------------------------------------------- platform detection

export function looksLikeTiendanube(html) {
    return (
        /LS\.store\s*=\s*\{/.test(html) ||
        /lightspeed-cdn\.mitiendanube\.com/.test(html) ||
        /\b[acd]cdn-[a-z]+\.mitiendanube\.com\/stores\//.test(html) ||
        /d1a9qnv764bsoo\.cloudfront\.net\/stores\//.test(html) ||
        /We use (Tiendanube|Nuvemshop)/i.test(html)
    );
}

/** Cloudflare / bot-check interstitials (small pages with a challenge marker). */
export function isChallengePage(html) {
    return /<title>\s*Just a moment/i.test(html) || (html.length < 60000 && /cf-browser-verification|challenge-platform|cf-chl-/.test(html));
}

// ---------------------------------------------------------------- JSON-LD

function jsonLdBlocks($) {
    const blocks = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        const data = parseJsonLoose($(el).contents().text());
        if (data) blocks.push(data);
    });
    return blocks;
}

function flattenLd(blocks) {
    const nodes = [];
    const visit = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(visit);
        nodes.push(n);
        if (n.mainEntity) visit(n.mainEntity);
        if (n['@graph']) visit(n['@graph']);
    };
    blocks.forEach(visit);
    return nodes;
}

const availabilityName = (v) => (typeof v === 'string' ? v.split('/').pop() : null);

// ---------------------------------------------------------------- classic engine

function classicLs(html) {
    const out = {};
    const vi = html.search(/LS\.variants\s*=\s*\[/);
    if (vi >= 0) {
        const start = html.indexOf('[', vi);
        const end = matchBracket(html, start);
        if (end > 0) out.variants = parseJsonLoose(html.slice(start, end + 1));
    }
    const pm = html.match(/LS\.product\s*=\s*\{([\s\S]*?)\n\s*\};/);
    if (pm) {
        const body = pm[1];
        const str = (re) => {
            const x = body.match(re);
            return x ? unescapeJs(x[1]) : null;
        };
        const tagsBody = (body.match(/tags\s*:\s*\[([\s\S]*?)\]/) || [])[1] || '';
        out.product = {
            id: num((body.match(/\bid\s*:\s*(\d+)/) || [])[1]),
            name: str(/\bname\s*:\s*'((?:[^'\\]|\\.)*)'/),
            brand: str(/\bbrand\s*:\s*'((?:[^'\\]|\\.)*)'/),
            tags: [...tagsBody.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => unescapeJs(x[1])),
        };
    }
    const sm = html.match(/LS\.store\s*=\s*\{([\s\S]*?)\n\s*\};/);
    if (sm) {
        const x = sm[1].match(/\bname\s*:\s*"((?:[^"\\]|\\.)*)"/);
        out.storeName = x ? unescapeJs(x[1]) : null;
        const cu = sm[1].match(/\bcustom_url\s*:\s*"([^"]*)"/);
        out.customUrl = cu ? cu[1] : null;
    }
    out.country = (html.match(/LS\.country\s*=\s*"([A-Z]{2})"/) || [])[1] || null;
    out.currency = (html.match(/LS\.currency\s*=\s*\{\s*code\s*:\s*"([A-Z]{3})"/) || [])[1] || null;
    out.lang = (html.match(/LS\.lang\s*=\s*"([a-z]{2}_[A-Z]{2})"/) || [])[1] || null;
    out.template = (html.match(/\bLS\.template\s*=\s*"([a-z0-9_-]+)"/) || [])[1] || null;
    return out;
}

const absImg = (u) => (u ? (u.startsWith('//') ? `https:${u}` : u) : null);
const bigImg = (u) => (u ? u.replace(/-(\d+)-(\d+)\.(webp|jpe?g|png|gif)(\?.*)?$/i, '-1024-1024.$3') : u);
const imgKey = (u) => u.replace(/-\d+-\d+\.(webp|jpe?g|png|gif)(\?.*)?$/i, '');

/** Names of the option groups ("Color", "Talle") in order, read from the variant selectors. */
function classicOptionNames($) {
    const names = [];
    $('select[name^="variation["]').each((_, el) => {
        const sel = $(el);
        const idx = Number((sel.attr('name').match(/variation\[(\d+)\]/) || [])[1]);
        const id = sel.attr('id') || sel.attr('data-variant-id');
        let label = id ? $(`label[for="${id}"]`).first().text() : '';
        if (!clean(label)) label = sel.closest('.variant-container, .form-group, .desktop-product-variation').find('label').first().text();
        label = clean(label).split(':')[0].trim();
        if (label) names[idx] = label;
    });
    return names;
}

function parseInstallments(raw) {
    if (!raw) return null;
    let data = raw;
    if (typeof raw === 'string') data = parseJsonLoose(raw);
    if (!data || typeof data !== 'object') return null;
    let maxCount = 0;
    let free = null;
    for (const [processor, options] of Object.entries(data)) {
        for (const [n, o] of Object.entries(options || {})) {
            const count = Number(n);
            if (count > maxCount) maxCount = count;
            if (o && o.without_interests && count > 1 && (!free || count > free.count)) {
                free = { count, value: num(o.installment_value), processor };
            }
        }
    }
    if (!maxCount) return null;
    return {
        maxInstallments: maxCount,
        maxInterestFreeInstallments: free ? free.count : 1,
        interestFreeInstallmentValue: free ? free.value : null,
        processor: free ? free.processor : null,
    };
}

function classicVariants(ls, optionNames) {
    return (ls.variants || []).map((v) => {
        const attributes = {};
        [v.option0, v.option1, v.option2].forEach((val, i) => {
            if (val !== null && val !== undefined && val !== '') attributes[optionNames[i] || `Option ${i + 1}`] = val;
        });
        const contact = Boolean(v.contact);
        return {
            id: v.id ?? null,
            sku: v.sku ?? null,
            price: contact ? null : num(v.price_number),
            compareAtPrice: num(v.compare_at_price_number),
            promotionalPrice: num(v.promotional_price_number),
            stock: v.stock === null || v.stock === undefined ? null : num(v.stock),
            available: Boolean(v.available),
            attributes,
            image: bigImg(absImg(v.image_url)),
            _installments: v.installments_data,
        };
    });
}

function classicDescription($) {
    const el = $('.product-description.user-content, [data-store^="product-description"]')
        .filter((_, e) => !$(e).find('.product-description.user-content').length)
        .first();
    if (!el.length) return { text: null, html: null };
    const html = clean(el.html() || '') ? el.html().trim() : null;
    const text = clean(el.text());
    return { text: text || null, html };
}

function classicImages($, ldImage) {
    const found = [];
    $('[data-desktop-zoom]').each((_, el) => found.push($(el).attr('data-desktop-zoom')));
    if (!found.length) $('img.js-product-slide-img, .product-slider-image[src]').each((_, el) => found.push($(el).attr('src')));
    if (!found.length && ldImage) found.push(...[].concat(ldImage));
    const seen = new Set();
    const out = [];
    for (const f of found) {
        const u = bigImg(absImg(f));
        if (!u) continue;
        const k = imgKey(u);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(u);
    }
    return out;
}

function breadcrumbCategories(nodes) {
    const bc = nodes.find((n) => n['@type'] === 'BreadcrumbList');
    const items = bc?.itemListElement || nodes.find((n) => n.breadcrumb)?.breadcrumb?.itemListElement;
    if (!Array.isArray(items) || items.length < 3) return [];
    return items
        .slice(1, -1)
        .filter((i) => {
            // the generic "Productos" level is the catalog root, not a category
            const href = typeof i.item === 'string' ? i.item : i.item?.['@id'];
            try {
                return !LISTING_PATH_RE.test(new URL(href).pathname);
            } catch {
                return true;
            }
        })
        .map((i) => clean(decodeEntities(i.name ?? i.item?.name ?? '')))
        .filter(Boolean);
}

function parseClassic(html, pageUrl) {
    const ls = classicLs(html);
    if (!ls.variants || !ls.variants.length) return null;
    // Deleted or hidden products answer HTTP 200 with the 404 template (still listing related products' variants).
    if (ls.template && ls.template !== 'product') return null;
    const $ = cheerio.load(html);
    const nodes = flattenLd(jsonLdBlocks($));
    const pageNode = nodes.find((n) => n['@type'] === 'WebPage' && n.mainEntity);
    const ld = (pageNode && pageNode.mainEntity) || nodes.find((n) => n['@type'] === 'Product' && (n['@id'] || '').replace(/\/$/, '') === pageUrl.replace(/\/$/, '')) || null;
    const optionNames = classicOptionNames($);
    const variants = classicVariants(ls, optionNames);
    const desc = classicDescription($);
    const ogDesc = $('meta[property="og:description"]').attr('content');
    const name = ls.product?.name || ld?.name || clean($('h1').first().text()) || null;
    const brandLd = ld?.brand?.name || (typeof ld?.brand === 'string' ? ld.brand : null);
    return {
        engine: 'classic',
        productId: ls.product?.id ?? ls.variants[0].product_id ?? null,
        name,
        brand: ls.product?.brand || brandLd || null,
        description: desc.text || clean(decodeEntities(ld?.description || ogDesc || '')) || null,
        descriptionHtml: desc.html,
        categories: breadcrumbCategories(nodes),
        tags: ls.product?.tags || [],
        variants,
        images: classicImages($, ld?.image),
        weightKg: num(ld?.weight?.value),
        ldAvailability: availabilityName(ld?.offers?.availability),
        ldSku: ld?.sku ?? null,
        currency: ls.currency || ld?.offers?.priceCurrency || null,
        country: ls.country,
        language: ls.lang,
        storeName: ls.storeName || clean(decodeEntities(ld?.offers?.seller?.name || '')) || null,
        lastModified: null,
        canonicalUrl: ld?.['@id'] || ld?.offers?.url || null,
    };
}

// ---------------------------------------------------------------- next engine (RSC flight data)

export function decodeFlight(html) {
    const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    let m;
    let all = '';
    while ((m = re.exec(html))) {
        try {
            all += JSON.parse(m[1]);
        } catch {
            // ignore a broken chunk
        }
    }
    return all;
}

function objectAround(text, anchorIdx, startToken) {
    const start = text.lastIndexOf(startToken, anchorIdx);
    if (start < 0) return null;
    const end = matchBracket(text, start);
    return end > start ? parseJsonLoose(text.slice(start, end + 1)) : null;
}

const loc = (v, lang) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
        if (lang && v[lang] != null) return v[lang];
        const first = Object.values(v).find((x) => x != null && x !== '');
        return first ?? null;
    }
    return String(v);
};

function menuNames(flight) {
    const names = new Map();
    const walk = (items) => {
        if (!Array.isArray(items)) return;
        for (const it of items) {
            if (it && it.id) names.set(Number(it.id), clean(it.name));
            walk(it?.subitems);
        }
    };
    for (const key of ['"menu":[', '"headerSecondaryMenu":[', '"primaryMenu":[']) {
        const i = flight.indexOf(key);
        if (i < 0) continue;
        const start = flight.indexOf('[', i);
        const end = matchBracket(flight, start);
        if (end > 0) walk(parseJsonLoose(flight.slice(start, end + 1)));
    }
    return names;
}

export function extractNextStore(flight) {
    const i = flight.indexOf('"store":{"id":');
    if (i < 0) return null;
    const start = flight.indexOf('{', i + 8);
    const end = matchBracket(flight, start);
    return end > 0 ? parseJsonLoose(flight.slice(start, end + 1)) : null;
}

function parseNext(html, pageUrl) {
    const flight = decodeFlight(html);
    if (!flight) return null;
    const slug = productSlug(pageUrl);
    let product = null;
    let from = 0;
    for (;;) {
        const i = flight.indexOf('"variants":[{', from);
        if (i < 0) break;
        from = i + 5;
        const p = objectAround(flight, i, '{"id":');
        if (!p || !p.variants) continue;
        const handles = p.handle && typeof p.handle === 'object' ? Object.values(p.handle) : [p.handle];
        if (!product) product = p;
        if (slug && handles.some((h) => typeof h === 'string' && h.toLowerCase() === slug)) {
            product = p;
            break;
        }
    }
    if (!product) return null;
    const store = extractNextStore(flight) || {};
    const lang = store.main_language || null;
    const menu = menuNames(flight);
    const attrNames = (product.attributes || []).map((a) => clean(loc(a, lang)));
    const imageById = new Map((product.images || []).map((im) => [im.id, im.src]));
    const variants = (product.variants || []).map((v) => {
        const attributes = {};
        (v.values || []).forEach((val, i) => {
            const t = loc(val, lang);
            if (t !== null && t !== '') attributes[attrNames[i] || `Option ${i + 1}`] = t;
        });
        return {
            id: v.id ?? null,
            sku: v.sku ?? null,
            price: num(v.price),
            compareAtPrice: num(v.compare_at_price) !== null && num(v.compare_at_price) > (num(v.price) ?? 0) ? num(v.compare_at_price) : null,
            promotionalPrice: v.has_promotional_price ? num(v.promotional_price) : null,
            stock: v.stock === null || v.stock === undefined ? null : num(v.stock),
            available: v.stock === null || v.stock === undefined ? v.visible !== false : v.stock > 0,
            attributes,
            image: imageById.get(v.image_id) ?? null,
            _installments: null,
        };
    });
    const descHtml = loc(product.description, lang);
    const $d = descHtml ? cheerio.load(`<div id="d">${descHtml}</div>`) : null;
    const tags = typeof product.tags === 'string' ? product.tags.split(',').map(clean).filter(Boolean) : Array.isArray(product.tags) ? product.tags : [];
    return {
        engine: 'next',
        productId: product.id ?? null,
        name: clean(loc(product.name, lang)),
        brand: product.brand ? clean(typeof product.brand === 'object' ? loc(product.brand, lang) : product.brand) : null,
        description: $d ? clean($d('#d').text()) || null : null,
        descriptionHtml: descHtml || null,
        categories: (product.categories || []).map((c) => menu.get(Number(c))).filter(Boolean),
        tags,
        variants,
        images: (product.images || []).map((im) => im.src).filter(Boolean),
        weightKg: null,
        ldAvailability: null,
        ldSku: null,
        currency: store.main_currency || null,
        country: store.country || null,
        language: store.main_language || null,
        storeName: clean(loc(store.name, lang)),
        lastModified: product.updated_at && !Number.isNaN(Date.parse(product.updated_at)) ? Date.parse(product.updated_at) : null,
        canonicalUrl: product.canonical_url || null,
        published: product.published,
    };
}

// ---------------------------------------------------------------- generic JSON-LD fallback

function parseJsonLdOnly(html, pageUrl) {
    const $ = cheerio.load(html);
    const nodes = flattenLd(jsonLdBlocks($));
    const ld = nodes.find((n) => n['@type'] === 'Product');
    if (!ld) return null;
    const offers = [].concat(ld.offers?.offers || ld.offers || []);
    const variants = offers.map((o, i) => ({
        id: null,
        sku: o.sku ?? null,
        price: num(o.price),
        compareAtPrice: null,
        promotionalPrice: null,
        stock: null,
        available: availabilityName(o.availability) !== 'OutOfStock',
        attributes: {},
        image: null,
        _installments: null,
        _i: i,
    }));
    if (!variants.length) return null;
    return {
        engine: 'jsonld',
        productId: null,
        name: clean(decodeEntities(ld.name || '')),
        brand: ld.brand?.name || null,
        description: clean(decodeEntities(ld.description || '')) || null,
        descriptionHtml: null,
        categories: breadcrumbCategories(nodes),
        tags: [],
        variants,
        images: [].concat(ld.image || []),
        weightKg: num(ld.weight?.value),
        ldAvailability: null,
        ldSku: ld.sku ?? null,
        currency: offers[0]?.priceCurrency || null,
        country: null,
        language: null,
        storeName: null,
        lastModified: null,
        canonicalUrl: ld['@id'] || pageUrl,
    };
}

// ---------------------------------------------------------------- product record

/** Parse a product page into the raw product structure (or null when the page is not a product). */
export function parseProductPage(html, pageUrl) {
    if (/LS\.variants\s*=\s*\[/.test(html)) return parseClassic(html, pageUrl);
    if (/self\.__next_f\.push/.test(html)) return parseNext(html, pageUrl) || parseJsonLdOnly(html, pageUrl);
    return parseJsonLdOnly(html, pageUrl);
}

/** Final dataset row from the parsed page. */
export function buildProductItem(parsed, { url, store, lastmod, scrapedAt }) {
    const variants = parsed.variants;
    const main = variants.find((v) => v.available) || variants[0];
    const prices = variants.map((v) => v.price).filter((p) => p !== null);
    const stocks = variants.map((v) => v.stock);
    const unlimited = variants.some((v) => v.available && v.stock === null);
    const stockTotal = unlimited ? null : stocks.reduce((a, s) => a + (s || 0), 0);
    const inStock = variants.some((v) => v.available);
    const price = main.price;
    const compareAtPrice = main.compareAtPrice && price !== null && main.compareAtPrice > price ? main.compareAtPrice : null;
    const onSale = compareAtPrice !== null || main.promotionalPrice !== null;
    const installments = parseInstallments(main._installments);
    const host = new URL(url).hostname;
    const country = parsed.country || store?.country || null;
    const platform = /\.com\.br$/i.test(host) || country === 'BR' || /\/produtos\//.test(url) ? 'nuvemshop' : 'tiendanube';
    return {
        url,
        productId: parsed.productId,
        name: parsed.name,
        brand: parsed.brand,
        description: parsed.description,
        ...(parsed.descriptionHtml !== undefined ? { descriptionHtml: parsed.descriptionHtml } : {}),
        categories: parsed.categories,
        tags: parsed.tags,
        price,
        compareAtPrice,
        promotionalPrice: main.promotionalPrice,
        onSale,
        discountPercent: onSale && compareAtPrice ? Math.round((1 - price / compareAtPrice) * 1000) / 10 : null,
        priceMin: prices.length ? Math.min(...prices) : null,
        priceMax: prices.length ? Math.max(...prices) : null,
        currency: parsed.currency || store?.currency || null,
        installments,
        availability: inStock ? 'InStock' : 'OutOfStock',
        inStock,
        stockTotal,
        stockUnlimited: unlimited,
        sku: variants.find((v) => v.sku)?.sku ?? parsed.ldSku ?? null,
        variantCount: variants.length,
        variants: variants.map(({ _installments, _i, ...v }) => v),
        images: parsed.images,
        image: parsed.images[0] ?? null,
        weightKg: parsed.weightKg,
        storeName: parsed.storeName || store?.name || null,
        storeDomain: host.replace(/^www\./, ''),
        country,
        language: parsed.language || null,
        platform,
        engine: parsed.engine,
        lastModified: parsed.lastModified ? new Date(parsed.lastModified).toISOString() : lastmod ? new Date(lastmod).toISOString() : null,
        scrapedAt,
    };
}

/** Compact fingerprint used by incremental mode: changes whenever price, stock or availability change. */
export function fingerprint(item) {
    const v = item.variants.map((x) => `${x.id ?? x.sku ?? ''}:${x.price}:${x.compareAtPrice ?? ''}:${x.stock ?? 'u'}:${x.available ? 1 : 0}`).join('|');
    return `${item.price}|${item.compareAtPrice ?? ''}|${item.availability}|${v}|${item.name}`;
}

/**
 * Incremental mode: compare a product with the snapshot of the previous run.
 * Returns { skip: true } for unchanged products, otherwise { skip: false, changeType: 'new'|'changed', fp }.
 */
export function snapshotDecision(snapshot, slug, item, hash) {
    const fp = hash(fingerprint(item));
    const prev = snapshot[slug];
    if (prev === fp) return { skip: true, fp };
    return { skip: false, changeType: prev ? 'changed' : 'new', fp };
}

// ---------------------------------------------------------------- store profile

const SOCIALS = [
    ['instagram', /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i],
    ['facebook', /^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/(?!sharer|share|tr\b|plugins|dialog|2008|policies|login|legal)([A-Za-z0-9_.\-/]+)/i],
    ['tiktok', /^https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]+)/i],
    ['youtube', /^https?:\/\/(?:www\.)?youtube\.com\/(?!embed|watch)([A-Za-z0-9_.@\-/]+)/i],
    ['twitter', /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home)([A-Za-z0-9_]+)/i],
    ['pinterest', /^https?:\/\/(?:[a-z]+\.)?pinterest\.[a-z.]+\/(?!pin\/|pin$)([A-Za-z0-9_.\-]+)/i],
    ['linkedin', /^https?:\/\/(?:www\.)?linkedin\.com\/(company|in)\/([A-Za-z0-9_.\-]+)/i],
];

const PLACEHOLDER_EMAIL = /^(tuemail|tu-email|tucorreo|email|correo|seu-?email|nombre|name|ejemplo|exemplo|usuario|user|test|u00[0-9a-f]{2})/i;
const validEmail = (e) =>
    /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e) &&
    !PLATFORM_EMAIL_DOMAINS.test(e.split('@')[1]) &&
    !/^(email|example|dominio|domain|seudominio)\.[a-z.]+$/i.test(e.split('@')[1]) &&
    !PLACEHOLDER_EMAIL.test(e) &&
    !/\.(png|jpe?g|webp|gif|svg)$/i.test(e);

/** Public contact data visible on a storefront page (home, contact page or the embedded store object). */
export function extractContacts(html) {
    const $ = cheerio.load(html);
    const emails = new Set();
    const phones = new Set();
    const whatsapp = new Set();
    const socials = {};
    $('a[href]').each((_, a) => {
        const href = ($(a).attr('href') || '').trim();
        if (/^mailto:/i.test(href)) {
            const e = decodeURIComponent(href.slice(7).split('?')[0]).trim().toLowerCase();
            if (validEmail(e)) emails.add(e);
        } else if (/^tel:/i.test(href)) {
            const t = decodeURIComponent(href.slice(4)).replace(/[^\d+]/g, '');
            if (t.replace(/\D/g, '').length >= 7) phones.add(t);
        } else if (/(?:wa\.me|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send)/i.test(href)) {
            const m = href.match(/wa\.me\/(?:message\/)?\+?([A-Za-z0-9]+)/i) || href.match(/phone=\+?(\d+)/i);
            if (m && /^\d{7,}$/.test(m[1])) whatsapp.add(`+${m[1]}`);
        } else {
            for (const [key, re] of SOCIALS) {
                if (!socials[key] && re.test(href)) socials[key] = href.split('?')[0].replace(/\/$/, '');
            }
        }
    });
    // Tags become spaces so adjacent elements do not glue words onto an address.
    const bodyText = decodeEntities(
        html
            .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<[^>]+>/g, ' '),
    );
    for (const m of bodyText.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
        const e = m[0].toLowerCase();
        if (validEmail(e)) emails.add(e);
    }
    return { emails: [...emails], phones: [...phones], whatsapp: [...whatsapp], socials };
}

export function parseStoreProfile(html) {
    const engine = /LS\.store\s*=\s*\{/.test(html) ? 'classic' : /self\.__next_f\.push/.test(html) ? 'next' : null;
    const $ = cheerio.load(html);
    const contacts = extractContacts(html);
    const meta = (n) => clean(decodeEntities($(`meta[name="${n}"], meta[property="${n}"]`).attr('content') || '')) || null;
    let info = { engine, name: null, country: null, currency: null, language: null, description: meta('description') || meta('og:description'), logo: null, createdAt: null };
    if (engine === 'classic') {
        const ls = classicLs(html);
        const org = flattenLd(jsonLdBlocks($)).find((n) => n['@type'] === 'Organization');
        info = {
            ...info,
            name: ls.storeName || clean(decodeEntities(org?.name || '')) || meta('og:site_name'),
            country: ls.country,
            currency: ls.currency,
            language: ls.lang,
            logo: org?.logo || null,
        };
        for (const s of [].concat(org?.sameAs || [])) {
            for (const [key, re] of SOCIALS) if (!contacts.socials[key] && re.test(s)) contacts.socials[key] = s.split('?')[0].replace(/\/$/, '');
        }
    } else if (engine === 'next') {
        const store = extractNextStore(decodeFlight(html)) || {};
        const lang = store.main_language || null;
        info = {
            ...info,
            name: clean(loc(store.name, lang)) || meta('og:site_name'),
            country: store.country || null,
            currency: store.main_currency || null,
            language: store.main_language || null,
            logo: store.logo || null,
            createdAt: store.created_at && !Number.isNaN(Date.parse(store.created_at)) ? new Date(Date.parse(store.created_at)).toISOString() : null,
            description: clean(loc(store.description, lang)) || info.description,
        };
        for (const e of [store.email, store.contact_email]) if (e && validEmail(String(e).toLowerCase())) contacts.emails.unshift(String(e).toLowerCase());
        if (store.phone) contacts.phones.unshift(String(store.phone).replace(/[^\d+]/g, ''));
        if (store.whatsapp_phone_number) contacts.whatsapp.unshift(String(store.whatsapp_phone_number).replace(/[^\d+]/g, ''));
        for (const k of ['instagram', 'facebook', 'tiktok', 'youtube', 'twitter', 'pinterest']) {
            const v = store[k];
            if (v && /^https?:\/\/[^/]+\/.+/.test(v) && !/twitter\.com\/$/.test(v)) contacts.socials[k] = v.split('?')[0].replace(/\/$/, '');
        }
        info.business = { name: store.business_name || null, address: store.business_address || store.address || null };
    }
    contacts.emails = [...new Set(contacts.emails)];
    contacts.phones = [...new Set(contacts.phones)];
    contacts.whatsapp = [...new Set(contacts.whatsapp)];
    return { ...info, contacts };
}
