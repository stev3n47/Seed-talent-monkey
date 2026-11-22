const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/seed_helper_v9.user.js`, 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const page = (...ids) => JSON.stringify([{ courses: ids.map(n => ({ id: id(n) })) }]);
function context() {
    const messages = [];
    const ctx = vm.createContext({ window: { postMessage: m => messages.push(m) }, location: { origin: 'https://app.seedtalent.com' } });
    vm.runInContext(source.slice(source.indexOf('    const courseApiCache ='), source.indexOf('    function courseEntriesFromCache()')) + '\nthis.paging = catalogPaging; this.cache = courseApiCache;', ctx);
    return { ctx, messages, run: code => vm.runInContext(code, ctx) };
}
test('failed and incomplete at 100% are not completed; explicit completed at 90% is', () => {
    const { run } = context();
    for (const status of ['Failed', 'Incomplete', 'Not Completed', 'In Progress']) {
        assert.equal(run(`courseIsComplete({progress:100,status:${JSON.stringify(status)}})`), false);
    }
    assert.equal(run('courseIsComplete({progress:90,status:"Completed"})'), true);
    assert.equal(run('courseIsComplete({progress:100,status:""})'), true);
});
test('requests 0, 8, 16 and exhausts only after an empty page', () => {
    const { ctx, messages, run } = context();
    for (const [offset, body] of [[0, page(1, 2)], [8, page(3)], [16, page()]]) {
        assert.equal(run('requestCatalogPage(1000)'), true);
        assert.equal(messages.at(-1).offset, offset);
        ctx.acceptCatalogPage({ offset, body });
    }
    assert.equal(ctx.paging.exhausted, true);
    assert.equal(ctx.paging.seen.length, 3);
    assert.equal(run('requestCatalogPage(2000)'), false);
    assert.equal(Object.keys(ctx.cache).length, 2);
});
test('repeated pages, malformed bodies and HTTP errors stop without claiming exhaustion', () => {
    for (const data of [{ body: '{}' }, { body: 'not JSON' }, { body: '[{"courses":[{}]}]' }, { error: 'Catalog HTTP 401' }]) {
        const { ctx, run } = context();
        run('requestCatalogPage(1000)');
        ctx.acceptCatalogPage({ offset: 0, ...data });
        assert.ok(ctx.paging.error);
        assert.equal(ctx.paging.exhausted, false);
    }
    const { ctx, run } = context();
    run('requestCatalogPage(1000)');
    ctx.acceptCatalogPage({ offset: 0, body: page(1) });
    run('requestCatalogPage(2000)');
    ctx.acceptCatalogPage({ offset: 8, body: page(1) });
    assert.match(ctx.paging.error, /repeated/);
    assert.equal(ctx.paging.exhausted, false);
});
test('pending requests are deduplicated and timeouts are not completion', () => {
    const { ctx, messages, run } = context();
    run('requestCatalogPage(1000)');
    run('requestCatalogPage(2000)');
    assert.equal(messages.length, 1);
    ctx.acceptCatalogPage({ offset: 8, body: page() });
    assert.equal(ctx.paging.pending, true);
    assert.equal(run('requestCatalogPage(22000)'), false);
    assert.match(ctx.paging.error, /timed out/);
    assert.equal(ctx.paging.exhausted, false);
});
test('picker discovers a failed course from a later API page without DOM controls', () => {
    const { ctx, run } = context();
    ctx.document = { querySelector: () => null, querySelectorAll: () => [] };
    const start = source.indexOf('    function courseEntriesFromCache()');
    run(source.slice(start, source.indexOf('    function advanceCatalogPage()', start)));
    ctx.cache['by-category?offset=0&limit=8'] = JSON.stringify([{ courses: [{ id: id(1), name: 'Completed course', progress: 100, status: 'Completed' }] }]);
    ctx.cache['by-category?offset=8&limit=8'] = JSON.stringify([{ courses: [{ id: id(2), name: 'Failed course', progress: 100, status: 'Failed' }] }]);
    assert.equal(run('pickNextCourse({tried:{}}).id'), id(2));
    ctx.tried = { [id(2)]: true };
    assert.equal(run('pickNextCourse({tried})'), null);
});
test('page bridge reuses fetch or XHR authentication without relaying headers', async () => {
    for (const transport of ['fetch', 'xhr']) {
        const listeners = [], messages = [], calls = [];
        const window = { addEventListener: (_, fn) => listeners.push(fn), postMessage: m => messages.push(m) };
        window.top = window;
        window.fetch = async (...args) => {
            calls.push(args);
            return new Response(page(1), { headers: { 'content-type': 'application/json' } });
        };
        class XHR {
            open() {}
            send() {}
            setRequestHeader() {}
            addEventListener() {}
        }
        const ctx = vm.createContext({ window, location: { href: 'https://app.seedtalent.com/courses', origin: 'https://app.seedtalent.com' }, URL, Headers, Request, AbortController, XMLHttpRequest: XHR, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
        const start = source.indexOf('    function __seedSnifferPage()');
        const end = source.indexOf('\n    // Inject hooks', start);
        vm.runInContext(source.slice(start, end) + '\n__seedSnifferPage();', ctx);
        const url = 'https://api.seedtalent.com/api/v1/courses/by-category?offset=0&limit=8';
        if (transport === 'fetch') {
            await window.fetch(url, { headers: { Authorization: 'Bearer test-only' }, credentials: 'include' });
        } else {
            const xhr = new XHR();
            xhr.open('GET', url);
            xhr.setRequestHeader('Authorization', 'Bearer test-only');
            xhr.withCredentials = true;
            xhr.send();
        }
        await listeners[0]({ source: window, origin: 'https://app.seedtalent.com', data: { type: 'SEED_CATALOG_PAGE', offset: 8 } });
        const [requested, options] = calls.at(-1);
        assert.equal(new URL(requested).searchParams.get('offset'), '8');
        assert.equal(options.headers.get('Authorization'), 'Bearer test-only');
        assert.equal(options.credentials, 'include');
        assert.ok(messages.some(m => m.type === 'SEED_CATALOG_RESULT' && m.body));
        // Synthesized requests must be journaled like app-made ones so
        // DIAG's recentNetwork and SNIFF dumps include the queue's paging.
        const sniff = messages.find(m => m.type === 'SEED_SNIFF_ENTRY' && /offset=8/.test(m.entry.url));
        assert.ok(sniff, 'catalog page request must emit a SEED_SNIFF_ENTRY');
        assert.match(sniff.entry.url, /offset=8/);
        assert.equal(sniff.entry.status, 200);
        assert.equal(sniff.entry.method, 'GET');
        assert.ok(sniff.entry.respBody);
        assert.equal(JSON.stringify(messages).includes('test-only'), false);
        const count = calls.length;
        await listeners[0]({ source: {}, origin: 'https://app.seedtalent.com', data: { type: 'SEED_CATALOG_PAGE', offset: 16 } });
        assert.equal(calls.length, count);
    }
});
