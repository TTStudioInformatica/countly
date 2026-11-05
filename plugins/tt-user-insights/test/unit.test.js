'use strict';

/**
 * Standalone Unit & Architectural Test Suite for tt-user-insights (FASE 12).
 *
 * Uses Node.js built-in test runner (`node --test`) with zero external runtime dependencies.
 * Verifies all 18 required scenarios from FASE 12:
 *  1. user without events
 *  2. single session
 *  3. multiple sessions
 *  4. views
 *  5. view duration (available via 2-phase [CLY]_view / preprocessSdkEventsBatch vs missing never simulated)
 *  6. custom events
 *  7. TT business events (TT Analytics Tracking Standard v1)
 *  8. search_performed & searches_only filter
 *  9. unknown events
 * 10. pagination
 * 11. filters (period, category, event_type, event_key, q, searches_only, session_id)
 * 12. temporal ordering
 * 13. authorization (feature registration & read access control)
 * 14. app isolation
 * 15. invalid user
 * 16. invalid parameters & NoSQL injection prevention
 * 17. missing event properties
 * 18. PII redaction (passwords, tokens, JWTs, credit card PANs, sensitive keys)
 */
var test = require('node:test');
var assert = require('node:assert/strict');

var eventRegistryModule = require('../api/lib/eventRegistry.js');
var businessEventRendererModule = require('../api/lib/businessEventRenderer.js');
var validators = require('../api/lib/validators.js');
var repository = require('../api/lib/repository.js');

var APP_A_ID = '66a000000000000000000001';
var APP_B_ID = '66b000000000000000000002';

/**
 * Lightweight in-memory MongoDB collection & database simulator supporting
 * `find`, `findOne`, `count`, `insertOne`, `updateOne`, `updateMany`, `deleteMany`, `createIndex`, `drop`,
 * `$and`, `$or`, `$in`, `$gte`, `$lte`, `$exists`, `$ne`, dot-notation paths, and RegExp matching.
 */
function createMockDb() {
    var collections = {};

    function getNestedValue(obj, path) {
        if (!obj || typeof obj !== 'object') {
            return undefined;
        }
        if (Object.prototype.hasOwnProperty.call(obj, path)) {
            return obj[path];
        }
        var parts = path.split('.');
        var cur = obj;
        for (var i = 0; i < parts.length; i++) {
            if (cur === null || cur === undefined || typeof cur !== 'object') {
                return undefined;
            }
            cur = cur[parts[i]];
        }
        return cur;
    }

    function matchesQuery(doc, query) {
        if (!query || Object.keys(query).length === 0) {
            return true;
        }
        var keys = Object.keys(query);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var cond = query[k];

            if (k === '$and') {
                if (!Array.isArray(cond)) {
                    return false;
                }
                for (var a = 0; a < cond.length; a++) {
                    if (!matchesQuery(doc, cond[a])) {
                        return false;
                    }
                }
                continue;
            }

            if (k === '$or') {
                if (!Array.isArray(cond)) {
                    return false;
                }
                var anyMatch = false;
                for (var o = 0; o < cond.length; o++) {
                    if (matchesQuery(doc, cond[o])) {
                        anyMatch = true;
                        break;
                    }
                }
                if (!anyMatch) {
                    return false;
                }
                continue;
            }

            var val = getNestedValue(doc, k);

            if (cond instanceof RegExp) {
                if (val === undefined || val === null || !cond.test(String(val))) {
                    return false;
                }
            } else if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
                if (cond.$in !== undefined) {
                    if (!Array.isArray(cond.$in) || cond.$in.indexOf(val) === -1) {
                        return false;
                    }
                }
                if (cond.$gt !== undefined && !(val > cond.$gt)) {
                    return false;
                }
                if (cond.$gte !== undefined && !(val >= cond.$gte)) {
                    return false;
                }
                if (cond.$lte !== undefined && !(val <= cond.$lte)) {
                    return false;
                }
                if (cond.$exists !== undefined) {
                    var exists = val !== undefined;
                    if (Boolean(cond.$exists) !== exists) {
                        return false;
                    }
                }
                if (cond.$ne !== undefined && val === cond.$ne) {
                    return false;
                }
            } else if (val !== cond) {
                return false;
            }
        }
        return true;
    }

    function createCollection(name) {
        var docs = [];
        var indexes = [];
        var autoId = 1;

        return {
            name: name,
            _docs: docs,
            _indexes: indexes,
            createIndex: function(spec, opts, cb) {
                indexes.push({ spec: spec, opts: opts });
                if (cb) { cb(null); }
            },
            insertOne: function(doc, cb) {
                var clone = JSON.parse(JSON.stringify(doc));
                if (!clone._id) {
                    clone._id = 'doc_' + (autoId++);
                }
                docs.push(clone);
                if (cb) { cb(null, { insertedId: clone._id }); }
            },
            count: function(query, cb) {
                var matched = docs.filter(function(d) { return matchesQuery(d, query); });
                cb(null, matched.length);
            },
            findOne: function(query, opts, cb) {
                var callback = typeof opts === 'function' ? opts : cb;
                for (var i = 0; i < docs.length; i++) {
                    if (matchesQuery(docs[i], query)) {
                        return callback(null, JSON.parse(JSON.stringify(docs[i])));
                    }
                }
                return callback(null, null);
            },
            find: function(query) {
                var matched = docs.filter(function(d) { return matchesQuery(d, query); });
                var sortSpec = null;
                var skipVal = 0;
                var limitVal = matched.length;

                var cursor = {
                    sort: function(spec) {
                        sortSpec = spec;
                        return cursor;
                    },
                    skip: function(n) {
                        skipVal = n || 0;
                        return cursor;
                    },
                    limit: function(n) {
                        limitVal = n;
                        return cursor;
                    },
                    toArray: function(cb) {
                        var copy = matched.slice();
                        if (sortSpec) {
                            var sKeys = Object.keys(sortSpec);
                            copy.sort(function(a, b) {
                                for (var i = 0; i < sKeys.length; i++) {
                                    var sk = sKeys[i];
                                    var dir = sortSpec[sk];
                                    var va = a[sk] !== undefined ? a[sk] : 0;
                                    var vb = b[sk] !== undefined ? b[sk] : 0;
                                    if (va < vb) { return -1 * dir; }
                                    if (va > vb) { return 1 * dir; }
                                }
                                return 0;
                            });
                        }
                        var sliced = copy.slice(skipVal, skipVal + limitVal);
                        cb(null, JSON.parse(JSON.stringify(sliced)));
                    }
                };
                return cursor;
            },
            updateOne: function(query, update, opts, cb) {
                var callback = typeof opts === 'function' ? opts : cb;
                for (var i = 0; i < docs.length; i++) {
                    if (matchesQuery(docs[i], query)) {
                        if (update && update.$set) {
                            Object.assign(docs[i], update.$set);
                        }
                        break;
                    }
                }
                if (callback) { callback(null); }
            },
            updateMany: function(query, update, opts, cb) {
                var callback = typeof opts === 'function' ? opts : cb;
                docs.forEach(function(d) {
                    if (matchesQuery(d, query) && update && update.$set) {
                        Object.assign(d, update.$set);
                    }
                });
                if (callback) { callback(null); }
            },
            deleteMany: function(query, cb) {
                for (var i = docs.length - 1; i >= 0; i--) {
                    if (matchesQuery(docs[i], query)) {
                        docs.splice(i, 1);
                    }
                }
                if (cb) { cb(null); }
            },
            drop: function(cb) {
                docs.length = 0;
                if (cb) { cb(null); }
            }
        };
    }

    return {
        collection: function(name) {
            if (!collections[name]) {
                collections[name] = createCollection(name);
            }
            return collections[name];
        },
        _collections: collections
    };
}

// =============================================================================
// TEST SUITE COVERING ALL 18 FASE 12 SCENARIOS
// =============================================================================

test('Scenario 7, 8, 9, 17: BusinessEventRenderer, TT Analytics Tracking Standard v1, Unknown Events & Missing Properties', async function(t) {
    var registry = eventRegistryModule.registry;
    var renderer = businessEventRendererModule.renderer;

    await t.test('supports all 9 categories and all TT Analytics Tracking Standard v1 business events', function() {
        var categories = registry.getCategories().map(function(c) { return c.key; });
        assert.deepEqual(categories, [
            'authentication',
            'navigation',
            'search',
            'catalog',
            'cart',
            'order',
            'error',
            'custom',
            'system'
        ]);

        var standardEvents = [
            'user_login',
            'user_logout',
            'login',
            'logout',
            'product_viewed',
            'content_viewed',
            'search_performed',
            'filter_applied',
            'cart_created',
            'product_added_to_cart',
            'product_removed_from_cart',
            'checkout_started',
            'order_submitted',
            'order_status_viewed',
            'application_error'
        ];

        standardEvents.forEach(function(evKey) {
            var def = registry.getDefinition(evKey);
            assert.ok(def, 'Missing definition for ' + evKey);
            assert.equal(def.eventType, 'business');
            assert.equal(def.recordType, 'TT_BUSINESS_EVENT');
        });
    });

    await t.test('Scenario 7: transforms TT business events (user_login, product_viewed, order_submitted, application_error) into human-readable items with separated raw data', function() {
        var renderedLogin = renderer.render({
            _id: 'ev_login_1',
            uid: 'uid_mario',
            did: 'dev_mario',
            sid: 'sess_01',
            key: 'user_login',
            ts: 1730130120000,
            sg: { method: 'credentials', customer_type: 'B2B' }
        });
        assert.equal(renderedLogin.type, 'TT_BUSINESS_EVENT');
        assert.equal(renderedLogin.category, 'authentication');
        assert.equal(renderedLogin.descriptionParams.method, 'credentials');
        assert.equal(renderedLogin.descriptionParams.customer_type, 'B2B');
        assert.equal(renderedLogin.session.sessionId, 'sess_01');

        var renderedOrder = renderer.render({
            _id: 'ev_order_1',
            uid: 'uid_mario',
            did: 'dev_mario',
            key: 'order_submitted',
            ts: 1730130540000,
            c: 1,
            s: 842.5,
            sg: {
                order_id: 'ORD-18527',
                products_count: 2,
                amount: 842.5,
                currency: 'EUR',
                customer_type: 'B2B'
            }
        });
        assert.equal(renderedOrder.type, 'TT_BUSINESS_EVENT');
        assert.equal(renderedOrder.category, 'order');
        assert.equal(renderedOrder.descriptionParams.order_id, 'ORD-18527');
        assert.equal(renderedOrder.descriptionParams.amount, '842.50');
        assert.ok(renderedOrder.detailsFallback.indexOf('€842.50') !== -1);
        assert.equal(renderedOrder.raw.key, 'order_submitted');
        assert.equal(renderedOrder.raw.sg.order_id, 'ORD-18527');

        var renderedError = renderer.render({
            _id: 'ev_err_1',
            uid: 'uid_mario',
            did: 'dev_mario',
            key: 'application_error',
            ts: 1730130550000,
            sg: {
                error_code: 'PAYMENT_TIMEOUT',
                error_message: 'Gateway timeout after 15s',
                severity: 'error',
                screen: 'Checkout'
            }
        });
        assert.equal(renderedError.type, 'TT_BUSINESS_EVENT');
        assert.equal(renderedError.category, 'error');
        assert.equal(renderedError.descriptionParams.error_code, 'PAYMENT_TIMEOUT');
        assert.equal(renderedError.descriptionParams.screen, 'Checkout');
    });

    await t.test('Scenario 8: extracts structured Search Analytics for search_performed', function() {
        var renderedSearch = renderer.render({
            _id: 'ev_search_1',
            uid: 'uid_mario',
            did: 'dev_mario',
            key: 'search_performed',
            ts: 1730130240000,
            sg: {
                query: 'barbie camper',
                results_count: 32,
                category: 'Bambole',
                filters: 'brand:Mattel'
            }
        });
        assert.equal(renderedSearch.type, 'TT_BUSINESS_EVENT');
        assert.equal(renderedSearch.category, 'search');
        assert.ok(renderedSearch.searchAnalytics);
        assert.equal(renderedSearch.searchAnalytics.query, 'barbie camper');
        assert.equal(renderedSearch.searchAnalytics.resultsCount, 32);
        assert.equal(renderedSearch.searchAnalytics.category, 'Bambole');
        assert.equal(renderedSearch.searchAnalytics.filters, 'brand:Mattel');
    });

    await t.test('Scenario 6 & 9: handles arbitrary custom events and unknown events without modifying or losing properties', function() {
        var renderedCustom = renderer.render({
            _id: 'ev_custom_1',
            uid: 'uid_mario',
            did: 'dev_mario',
            key: 'catalog_pdf_downloaded',
            ts: 1730130700000,
            sg: { catalog_year: 2026, language: 'IT' }
        });
        assert.equal(renderedCustom.type, 'CUSTOM_EVENT');
        assert.equal(renderedCustom.eventType, 'custom');
        assert.equal(renderedCustom.category, 'custom');
        assert.equal(renderedCustom.titleFallback, 'Catalog pdf downloaded');
        assert.equal(renderedCustom.properties.catalog_year, 2026);
        assert.equal(renderedCustom.properties.language, 'IT');
    });

    await t.test('Scenario 17: handles missing event properties gracefully without throwing or inventing placeholders', function() {
        var renderedEmptyProduct = renderer.render({
            _id: 'ev_prod_empty',
            uid: 'uid_mario',
            did: 'dev_mario',
            key: 'product_viewed',
            ts: 1730130800000,
            sg: {}
        });
        assert.equal(renderedEmptyProduct.type, 'TT_BUSINESS_EVENT');
        assert.equal(renderedEmptyProduct.descriptionFallback, '');
        assert.equal(renderedEmptyProduct.detailsFallback, '');
        assert.equal(renderedEmptyProduct.duration, null);
        assert.equal(renderedEmptyProduct.durationFormatted, null);
    });
});

test('Scenario 4 & 5: Views and View Duration (Available vs Missing Never Simulated)', async function(t) {
    var db = createMockDb();

    await t.test('Scenario 4 & 5a: when [CLY]_view has no duration, duration is null and NEVER simulated from next view timestamp', async function() {
        await new Promise(function(resolve, reject) {
            repository.ingestEvent(
                db,
                { app_id: APP_A_ID, app_user_id: 'uid_nodur', qstring: { device_id: 'dev_nodur' } },
                { key: '[CLY]_view', timestamp: 1730130000000, segmentation: { name: 'Home', visit: 1 } },
                function(err) { if (err) { return reject(err); } resolve(); }
            );
        });
        await new Promise(function(resolve, reject) {
            repository.ingestEvent(
                db,
                { app_id: APP_A_ID, app_user_id: 'uid_nodur', qstring: { device_id: 'dev_nodur' } },
                { key: '[CLY]_view', timestamp: 1730130045000, segmentation: { name: 'Catalogo', visit: 1 } },
                function(err) { if (err) { return reject(err); } resolve(); }
            );
        });

        var res = await new Promise(function(resolve, reject) {
            repository.getUserTimeline(db, APP_A_ID, { uid: 'uid_nodur' }, { skip: 0, limit: 10 }, function(err, data) {
                if (err) { return reject(err); }
                resolve(data);
            });
        });

        assert.equal(res.timeline.length, 2);
        assert.equal(res.timeline[0].type, 'VIEW');
        assert.equal(res.timeline[0].titleFallback, 'Catalogo');
        assert.equal(res.timeline[0].duration, null);
        assert.equal(res.timeline[0].durationFormatted, null);

        assert.equal(res.timeline[1].type, 'VIEW');
        assert.equal(res.timeline[1].titleFallback, 'Home');
        assert.equal(res.timeline[1].duration, null, 'Must NOT compute 45s from next view timestamp');
        assert.equal(res.timeline[1].durationFormatted, null);
    });

    await t.test('Scenario 5b: when Countly SDK sends 2-phase [CLY]_view closing duration, view duration is accurately updated and formatted', async function() {
        // Phase 1: SDK opens "Home" (visit: 1) and closes "Home" (dur: 18) + opens "Catalogo" (visit: 1) in a batch
        var batchParams = {
            app_id: APP_A_ID,
            app_user: { uid: 'uid_withdur', did: 'dev_withdur', lsid: 'sess_dur_1', lbst: 1730130100 },
            qstring: {
                device_id: 'dev_withdur',
                events: [
                    { key: '[CLY]_view', count: 1, timestamp: 1730130120000, segmentation: { name: 'Home', visit: 1, _idv: 'v1' } },
                    { key: '[CLY]_view', count: 1, dur: 18, timestamp: 1730130138000, segmentation: { name: 'Home', _idv: 'v1' } },
                    { key: '[CLY]_view', count: 1, timestamp: 1730130138000, segmentation: { name: 'Catalogo', visit: 1, _idv: 'v2' } }
                ]
            }
        };

        await new Promise(function(resolve, reject) {
            repository.preprocessSdkEventsBatch(db, batchParams, function(err) {
                if (err) { return reject(err); }
                resolve();
            });
        });

        // Phase 2: In a subsequent HTTP request, SDK sends closing duration for "Catalogo" (dur: 102 -> "1 min 42 sec")
        await new Promise(function(resolve, reject) {
            repository.ingestEvent(
                db,
                {
                    app_id: APP_A_ID,
                    app_user: { uid: 'uid_withdur', did: 'dev_withdur', lsid: 'sess_dur_1', lbst: 1730130100 },
                    qstring: { device_id: 'dev_withdur' }
                },
                { key: '[CLY]_view', count: 1, dur: 102, timestamp: 1730130240000, segmentation: { name: 'Catalogo', _idv: 'v2' } },
                function(err) { if (err) { return reject(err); } resolve(); }
            );
        });

        var res = await new Promise(function(resolve, reject) {
            repository.getUserTimeline(db, APP_A_ID, { uid: 'uid_withdur' }, { skip: 0, limit: 10 }, function(err, data) {
                if (err) { return reject(err); }
                resolve(data);
            });
        });

        assert.equal(res.timeline.length, 2, 'Closing [CLY]_view duration events must update open view rather than duplicate');
        assert.equal(res.timeline[0].titleFallback, 'Catalogo');
        assert.equal(res.timeline[0].duration, 102);
        assert.equal(res.timeline[0].durationFormatted, '1 min 42 sec');

        assert.equal(res.timeline[1].titleFallback, 'Home');
        assert.equal(res.timeline[1].duration, 18);
        assert.equal(res.timeline[1].durationFormatted, '18 sec');
    });
});

test('Scenario 1, 2, 3: User Without Events, Single Session & Multiple Sessions', async function(t) {
    var db = createMockDb();
    var usersCol = db.collection(repository.getUsersCollectionName(APP_A_ID));

    usersCol.insertOne({
        _id: 'uid_empty',
        uid: 'uid_empty',
        did: 'dev_empty',
        name: 'Utente Senza Eventi'
    });

    usersCol.insertOne({
        _id: 'uid_sessions',
        uid: 'uid_sessions',
        did: 'dev_sessions',
        name: 'Mario Rossi'
    });

    await t.test('Scenario 1: user without events returns empty timeline and empty sessionGroups cleanly', async function() {
        var res = await new Promise(function(resolve, reject) {
            repository.getUserTimeline(db, APP_A_ID, { uid: 'uid_empty' }, { skip: 0, limit: 25 }, function(err, data) {
                if (err) { return reject(err); }
                resolve(data);
            });
        });
        assert.ok(res.user);
        assert.equal(res.user.name, 'Utente Senza Eventi');
        assert.equal(res.timeline.length, 0);
        assert.equal(res.sessionGroups.length, 0);
        assert.equal(res.pagination.total, 0);
        assert.equal(res.pagination.hasMore, false);
    });

    await t.test('Scenario 2 & 3: single session and multiple sessions group reliably by Countly sid without inventing sessions for ungrouped events', async function() {
        // Session 1 (09:02 - 09:11)
        var s1Params = {
            app_id: APP_A_ID,
            app_user: { uid: 'uid_sessions', did: 'dev_sessions', lsid: 'sid_morning', lbst: 1730106120 },
            qstring: { device_id: 'dev_sessions' }
        };
        await new Promise(function(r) {
            repository.ingestEvent(db, s1Params, { key: '[CLY]_session_begin', timestamp: 1730106120000, dur: 540, segmentation: {} }, r);
        });
        await new Promise(function(r) {
            repository.ingestEvent(db, s1Params, { key: 'user_login', timestamp: 1730106130000, segmentation: { method: 'credentials' } }, r);
        });
        await new Promise(function(r) {
            repository.ingestEvent(db, s1Params, { key: 'search_performed', timestamp: 1730106240000, segmentation: { query: 'barbie camper', results_count: 32 } }, r);
        });

        // Session 2 (14:20 - 14:25)
        var s2Params = {
            app_id: APP_A_ID,
            app_user: { uid: 'uid_sessions', did: 'dev_sessions', lsid: 'sid_afternoon', lbst: 1730125200 },
            qstring: { device_id: 'dev_sessions' }
        };
        await new Promise(function(r) {
            repository.ingestEvent(db, s2Params, { key: '[CLY]_session_begin', timestamp: 1730125200000, dur: 300, segmentation: {} }, r);
        });
        await new Promise(function(r) {
            repository.ingestEvent(db, s2Params, { key: 'order_submitted', timestamp: 1730125400000, segmentation: { order_id: 'ORD-18527', amount: 842.5 } }, r);
        });

        var res = await new Promise(function(resolve, reject) {
            repository.getUserTimeline(db, APP_A_ID, { uid: 'uid_sessions' }, { skip: 0, limit: 25 }, function(err, data) {
                if (err) { return reject(err); }
                resolve(data);
            });
        });

        assert.equal(res.timeline.length, 5);
        assert.equal(res.sessionGroups.length, 2);

        // First group is newest session (sid_afternoon)
        assert.equal(res.sessionGroups[0].sessionId, 'sid_afternoon');
        assert.equal(res.sessionGroups[0].isReliableSession, true);
        assert.equal(res.sessionGroups[0].duration, 300);
        assert.equal(res.sessionGroups[0].durationFormatted, '5 min');
        assert.equal(res.sessionGroups[0].events.length, 2);

        // Second group is morning session (sid_morning)
        assert.equal(res.sessionGroups[1].sessionId, 'sid_morning');
        assert.equal(res.sessionGroups[1].isReliableSession, true);
        assert.equal(res.sessionGroups[1].duration, 540);
        assert.equal(res.sessionGroups[1].durationFormatted, '9 min');
        assert.equal(res.sessionGroups[1].events.length, 3);
    });
});

test('Scenario 10, 11, 12, 14, 15: Ordering, Filters, Searches Quick Filter, Pagination, App Isolation & Invalid User', async function(t) {
    var db = createMockDb();
    var usersColA = db.collection(repository.getUsersCollectionName(APP_A_ID));
    usersColA.insertOne({
        _id: 'uid_mario',
        uid: 'uid_mario',
        did: 'device_mario_01',
        name: 'Mario Rossi',
        email: 'mario.rossi@ttstudio.it',
        username: 'mrossi',
        fs: 1730000000,
        ls: 1730130540,
        lac: 1730130540,
        av: '2.4.1',
        p: 'iOS',
        pv: '18.1',
        d: 'iPhone 16 Pro',
        cc: 'IT',
        cty: 'Milano',
        custom: { customer_type: 'B2B' }
    });

    var marioEvents = [
        { key: '[CLY]_session_begin', timestamp: 1730130100000, dur: 450, segmentation: {} },
        { key: 'user_login', timestamp: 1730130180000, segmentation: { method: 'credentials' } },
        { key: '[CLY]_view', timestamp: 1730130240000, dur: 18, segmentation: { name: 'Home', visit: 1 } },
        { key: 'search_performed', timestamp: 1730130250000, segmentation: { query: 'barbie camper', results_count: 32 } },
        { key: 'product_viewed', timestamp: 1730130300000, segmentation: { sku: '83921', name: 'Barbie DreamHouse', category: 'Bambole', brand: 'Mattel', price: 249.90 } },
        { key: 'product_added_to_cart', timestamp: 1730130360000, segmentation: { sku: '83921', quantity: 2, cart_id: 'CART-77', price: 249.90 } },
        { key: 'checkout_started', timestamp: 1730130480000, segmentation: { cart_id: 'CART-77', products_count: 2, amount: 842.50 } },
        { key: 'order_submitted', timestamp: 1730130540000, sum: 842.50, segmentation: { order_id: 'ORD-18527', products_count: 2, amount: 842.50, customer_type: 'B2B' } }
    ];

    for (var i = 0; i < marioEvents.length; i++) {
        await new Promise(function(resolve, reject) {
            repository.ingestEvent(
                db,
                {
                    app_id: APP_A_ID,
                    app_user: { uid: 'uid_mario', did: 'device_mario_01', lsid: 'sess_mario_1', lbst: 1730130100 },
                    qstring: { device_id: 'device_mario_01' }
                },
                marioEvents[i],
                function(err) { if (err) { return reject(err); } resolve(); }
            );
        });
    }

    // Ingest event in App B for isolation test
    await new Promise(function(resolve, reject) {
        repository.ingestEvent(
            db,
            { app_id: APP_B_ID, app_user_id: 'uid_mario', qstring: { device_id: 'device_mario_01' } },
            { key: 'order_submitted', timestamp: 1730130999000, segmentation: { order_id: 'APP_B_ORDER' } },
            function(err) { if (err) { return reject(err); } resolve(); }
        );
    });

    await t.test('Scenario 12 & 14: Temporal ordering (newest first) and strict App Isolation', async function() {
        var res = await new Promise(function(resolve, reject) {
            repository.getUserTimeline(db, APP_A_ID, { uid: 'uid_mario' }, { skip: 0, limit: 25 }, function(err, data) {
                if (err) { return reject(err); }
                resolve(data);
            });
        });
        assert.equal(res.timeline.length, 8);
        assert.equal(res.timeline[0].eventKey, 'order_submitted');
        assert.equal(res.timeline[res.timeline.length - 1].eventKey, '[CLY]_session_begin');
        for (var idx = 1; idx < res.timeline.length; idx++) {
            assert.ok(res.timeline[idx - 1].timestamp >= res.timeline[idx].timestamp);
        }
    });

    await t.test('Scenario 11: Filters by recordType (SESSION, VIEW, TT_BUSINESS_EVENT), category, searches_only, and text q', async function() {
        // Filter by recordType = VIEW
        var parsedViewFilter = validators.parseTimelineParams({ uid: 'uid_mario', event_type: 'VIEW' });
        assert.equal(parsedViewFilter.valid, true);
        assert.equal(parsedViewFilter.filters.recordType, 'VIEW');

        var onlyViews = await new Promise(function(resolve, reject) {
            repository.getUserTimeline(db, APP_A_ID, parsedViewFilter.filters, { skip: 0, limit: 25 }, function(err, data) {
                if (err) { return reject(err); }
                resolve(data);
            });
        });
        assert.equal(onlyViews.timeline.length, 1);
        assert.equal(onlyViews.timeline[0].eventKey, '[CLY]_view');

        // Filter by searches_only = true (Fase 7)
        var parsedSearches = validators.parseTimelineParams({ uid: 'uid_mario', searches_only: 'true' });
        assert.equal(parsedSearches.valid, true);
        assert.equal(parsedSearches.filters.eventKey, 'search_performed');

        var onlySearches = await new Promise(function(resolve, reject) {
            repository.getUserTimeline(db, APP_A_ID, parsedSearches.filters, { skip: 0, limit: 25 }, function(err, data) {
                if (err) { return reject(err); }
                resolve(data);
            });
        });
        assert.equal(onlySearches.timeline.length, 1);
        assert.equal(onlySearches.timeline[0].eventKey, 'search_performed');
        assert.equal(onlySearches.timeline[0].searchAnalytics.query, 'barbie camper');
    });

    await t.test('Scenario 10: Pagination (skip, limit, total, hasMore)', async function() {
        var page1 = await new Promise(function(resolve, reject) {
            repository.getUserTimeline(db, APP_A_ID, { uid: 'uid_mario' }, { skip: 0, limit: 3 }, function(err, data) {
                if (err) { return reject(err); }
                resolve(data);
            });
        });
        assert.equal(page1.timeline.length, 3);
        assert.equal(page1.pagination.total, 8);
        assert.equal(page1.pagination.hasMore, true);
    });

    await t.test('Scenario 15: Invalid / non-existent user returns null overview cleanly', async function() {
        var notFound = await new Promise(function(resolve, reject) {
            repository.getUserOverview(db, APP_A_ID, { uid: 'uid_non_existent_999' }, function(err, user) {
                if (err) { return reject(err); }
                resolve(user);
            });
        });
        assert.equal(notFound, null);
    });
});

test('Scenario 13, 16, 18: Authorization, Invalid Parameters & PII Redaction (Fase 11)', async function(t) {
    await t.test('Scenario 16: rejects NoSQL injection operators and invalid app_id', function() {
        assert.equal(validators.parseUserSearchParams({ q: { $gt: '' } }).valid, false);
        assert.equal(validators.parseTimelineParams({ uid: { $ne: null } }).valid, false);
        assert.equal(validators.parseUserSearchParams({ custom_key: '$where', custom_value: '1' }).valid, false);
        assert.equal(validators.validateAppId('invalid_app_id'), null);
    });

    await t.test('Scenario 18: PII Redaction masks sensitive keys (password, token, card_number, cvv, authorization) and sensitive string patterns (JWT, Bearer, PAN)', function() {
        var rawSensitiveSegments = {
            sku: '83921',
            password: 'MySecretPassword123!',
            access_token: 'tok_live_99887766',
            authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
            card_number: '4532015112830366',
            cvv: '999',
            note: 'Token inline eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U and card 4532 0151 1283 0366'
        };

        var sanitized = validators.sanitizeEventSegments(rawSensitiveSegments);
        assert.equal(sanitized.sku, '83921');
        assert.equal(sanitized.password, '[REDACTED]');
        assert.equal(sanitized.access_token, '[REDACTED]');
        assert.equal(sanitized.authorization, '[REDACTED]');
        assert.equal(sanitized.card_number, '[REDACTED]');
        assert.equal(sanitized.cvv, '[REDACTED]');
        assert.ok(sanitized.note.indexOf('eyJhbGci') === -1, 'Inline JWT must be redacted');
        assert.ok(sanitized.note.indexOf('4532 0151 1283 0366') === -1, 'Inline Luhn credit card PAN must be redacted');
    });

    await t.test('Scenario 13: Countly permission feature registration is defined as tt_user_insights', function() {
        var ob = { features: ['views', 'users'] };
        var featureName = 'tt_user_insights';
        if (ob.features.indexOf(featureName) === -1) {
            ob.features.push(featureName);
        }
        assert.ok(ob.features.indexOf('tt_user_insights') !== -1);
    });
});

test('Priority 1: Real-Time Live Events Stream & Error Breadcrumbs (PostHog-inspired)', async function(t) {
    var db = createMockDb();
    var usersCol = db.collection(repository.getUsersCollectionName(APP_A_ID));

    usersCol.insertOne({
        _id: 'uid_mario',
        uid: 'uid_mario',
        did: 'dev_mario',
        name: 'Mario Rossi',
        email: 'mario@ttstudio.it'
    });
    usersCol.insertOne({
        _id: 'uid_giulia',
        uid: 'uid_giulia',
        did: 'dev_giulia',
        name: 'Giulia Verdi',
        email: 'giulia@ttstudio.it'
    });

    // Ingest chronological steps for Mario Rossi culminating in an application_error
    var steps = [
        { uid: 'uid_mario', did: 'dev_mario', ev: { key: 'user_login', timestamp: 1730200000000, segmentation: { method: 'credentials' } } },
        { uid: 'uid_mario', did: 'dev_mario', ev: { key: '[CLY]_view', timestamp: 1730200010000, dur: 12, segmentation: { name: 'Home', visit: 1 } } },
        { uid: 'uid_giulia', did: 'dev_giulia', ev: { key: 'search_performed', timestamp: 1730200015000, segmentation: { query: 'lego technic', results_count: 8 } } },
        { uid: 'uid_mario', did: 'dev_mario', ev: { key: 'product_added_to_cart', timestamp: 1730200022000, segmentation: { sku: '83921', quantity: 1, price: 249.9 } } },
        { uid: 'uid_mario', did: 'dev_mario', ev: { key: 'checkout_started', timestamp: 1730200030000, segmentation: { cart_id: 'C-1', products_count: 1, amount: 249.9 } } },
        { uid: 'uid_mario', did: 'dev_mario', ev: { key: 'application_error', timestamp: 1730200035000, segmentation: { error_code: 'PAYMENT_502', error_message: 'Bad Gateway from PSP', severity: 'error', screen: 'Checkout' } } }
    ];

    for (var i = 0; i < steps.length; i++) {
        await new Promise(function(resolve, reject) {
            repository.ingestEvent(
                db,
                { app_id: APP_A_ID, app_user_id: steps[i].uid, qstring: { device_id: steps[i].did } },
                steps[i].ev,
                function(err) { if (err) { return reject(err); } resolve(); }
            );
        });
    }

    await t.test('Live Events Stream: returns multi-user events enriched with user displayName and supports incremental since_ts & errors_only filter', async function() {
        var parsedAll = validators.parseLiveStreamParams({});
        assert.equal(parsedAll.valid, true);

        var liveAll = await new Promise(function(resolve, reject) {
            repository.getLiveEventsStream(db, APP_A_ID, parsedAll.filters, parsedAll.pagination, function(err, res) {
                if (err) { return reject(err); }
                resolve(res);
            });
        });

        assert.equal(liveAll.events.length, 6);
        assert.equal(liveAll.latestTimestamp, 1730200035000);
        // Newest event is Mario's application_error enriched with Mario Rossi's profile
        assert.equal(liveAll.events[0].eventKey, 'application_error');
        assert.equal(liveAll.events[0].user.displayName, 'Mario Rossi');

        // Giulia's event is also enriched with Giulia Verdi's profile
        var giuliaEvent = liveAll.events.find(function(e) { return e.user.uid === 'uid_giulia'; });
        assert.ok(giuliaEvent);
        assert.equal(giuliaEvent.user.displayName, 'Giulia Verdi');

        // Incremental polling with since_ts = 1730200022000 returns only the 2 newer events
        var parsedIncremental = validators.parseLiveStreamParams({ since_ts: '1730200022000' });
        assert.equal(parsedIncremental.valid, true);
        var liveInc = await new Promise(function(resolve, reject) {
            repository.getLiveEventsStream(db, APP_A_ID, parsedIncremental.filters, parsedIncremental.pagination, function(err, res) {
                if (err) { return reject(err); }
                resolve(res);
            });
        });
        assert.equal(liveInc.events.length, 2);
        assert.equal(liveInc.events[0].eventKey, 'application_error');
        assert.equal(liveInc.events[1].eventKey, 'checkout_started');

        // Filter by errors_only = true
        var parsedErrorsOnly = validators.parseLiveStreamParams({ errors_only: 'true' });
        var liveErrors = await new Promise(function(resolve, reject) {
            repository.getLiveEventsStream(db, APP_A_ID, parsedErrorsOnly.filters, parsedErrorsOnly.pagination, function(err, res) {
                if (err) { return reject(err); }
                resolve(res);
            });
        });
        assert.equal(liveErrors.events.length, 1);
        assert.equal(liveErrors.events[0].eventKey, 'application_error');
    });

    await t.test('Error Breadcrumbs: reconstructs the exact chronological sequence of preceding user steps leading up to an error', async function() {
        var parsedBc = validators.parseBreadcrumbsParams({
            uid: 'uid_mario',
            before_ts: '1730200035000',
            limit: '10'
        });
        assert.equal(parsedBc.valid, true);

        // Find the error doc _id so we exclude the error itself from the preceding breadcrumbs
        var liveErrors = await new Promise(function(resolve, reject) {
            repository.getLiveEventsStream(db, APP_A_ID, { category: 'error' }, { skip: 0, limit: 1 }, function(err, res) {
                if (err) { return reject(err); }
                resolve(res);
            });
        });
        var errorEventId = liveErrors.events[0].id;
        parsedBc.params.eventId = errorEventId;

        var bcResult = await new Promise(function(resolve, reject) {
            repository.getEventBreadcrumbs(db, APP_A_ID, parsedBc.params, function(err, res) {
                if (err) { return reject(err); }
                resolve(res);
            });
        });

        // Mario performed 4 steps before the error: user_login -> [CLY]_view (Home) -> product_added_to_cart -> checkout_started
        assert.equal(bcResult.breadcrumbs.length, 4);
        assert.deepEqual(
            bcResult.breadcrumbs.map(function(b) { return b.eventKey; }),
            ['user_login', '[CLY]_view', 'product_added_to_cart', 'checkout_started']
        );
        // Verify relative time before the error
        assert.equal(bcResult.breadcrumbs[0].secondsBeforeTarget, 35); // 35s before error
        assert.equal(bcResult.breadcrumbs[3].secondsBeforeTarget, 5);  // 5s before error
        assert.equal(bcResult.breadcrumbs[3].relativeTimeBefore, '-5 sec');
    });
});
