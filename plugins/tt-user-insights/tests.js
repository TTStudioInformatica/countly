'use strict';

/**
 * Countly Integration Test Suite for tt-user-insights (Mocha + Supertest).
 *
 * Follows standard Countly plugin test conventions (`testUtils`).
 * Run on a configured Countly test instance via:
 *   npx mocha plugins/tt-user-insights/tests.js
 */
var request = require('supertest');
var should = require('should');
var testUtils = require('../../test/testUtils');

var requestUrl = testUtils.url;
var API_KEY_ADMIN;
var APP_ID;
var APP_KEY;

describe('Testing tt-user-insights plugin API (User Activity Timeline & TT Tracking Standard v1)', function () {
    before(function (done) {
        testUtils.waitForInitialization(function () {
            API_KEY_ADMIN = testUtils.get('API_KEY_ADMIN');
            APP_ID = testUtils.get('APP_ID');
            APP_KEY = testUtils.get('APP_KEY');
            done();
        });
    });

    describe('1. Authorization & Access Control', function () {
        it('should reject unauthenticated requests without api_key', function (done) {
            request(requestUrl)
                .get('/o/tt-user-insights/users?app_id=' + APP_ID)
                .expect(401, done);
        });

        it('should reject requests without app_id', function (done) {
            request(requestUrl)
                .get('/o/tt-user-insights/users?api_key=' + API_KEY_ADMIN)
                .expect(401, done);
        });

        it('should reject malformed app_id', function (done) {
            request(requestUrl)
                .get('/o/tt-user-insights/users?api_key=' + API_KEY_ADMIN + '&app_id=invalid_app_id')
                .expect(400, done);
        });

        it('should return 404 for non-existent user in /o/tt-user-insights/details', function (done) {
            request(requestUrl)
                .get('/o/tt-user-insights/details')
                .query({
                    api_key: API_KEY_ADMIN,
                    app_id: APP_ID,
                    uid: 'non_existent_uid_999999'
                })
                .expect(404, done);
        });
    });

    describe('2. Session, Views (with 2-Phase Duration), TT Business Events & PII Redaction', function () {
        var testDeviceId = 'mario_rossi_device_01';

        it('should ingest begin_session, user_details, views (visit + duration), TT business events, and redact PII via /i', function (done) {
            var userDetails = JSON.stringify({
                name: 'Mario Rossi',
                email: 'mario.rossi@example.it',
                username: 'mrossi',
                custom: {
                    customer_type: 'B2B',
                    company: 'Rossi Giocattoli SRL',
                    password: 'ShouldBeRedacted123'
                }
            });

            var events = JSON.stringify([
                {
                    key: 'user_login',
                    count: 1,
                    timestamp: 1730106120000,
                    segmentation: { method: 'credentials', customer_type: 'B2B', access_token: 'secret_jwt_token' }
                },
                {
                    key: '[CLY]_view',
                    count: 1,
                    timestamp: 1730106180000,
                    segmentation: { name: 'Home', visit: 1, _idv: 'v_home_1' }
                },
                {
                    key: '[CLY]_view',
                    count: 1,
                    dur: 18,
                    timestamp: 1730106198000,
                    segmentation: { name: 'Home', _idv: 'v_home_1' }
                },
                {
                    key: '[CLY]_view',
                    count: 1,
                    timestamp: 1730106198000,
                    segmentation: { name: 'Catalogo', visit: 1, _idv: 'v_cat_1' }
                },
                {
                    key: '[CLY]_view',
                    count: 1,
                    dur: 102,
                    timestamp: 1730106300000,
                    segmentation: { name: 'Catalogo', _idv: 'v_cat_1' }
                },
                {
                    key: 'search_performed',
                    count: 1,
                    timestamp: 1730106240000,
                    segmentation: { query: 'barbie camper', results_count: 32, category: 'Bambole' }
                },
                {
                    key: 'product_viewed',
                    count: 1,
                    timestamp: 1730106300000,
                    segmentation: { sku: '83921', name: 'Barbie DreamHouse', category: 'Bambole', brand: 'Mattel', price: 249.9 }
                },
                {
                    key: 'product_added_to_cart',
                    count: 1,
                    timestamp: 1730106360000,
                    segmentation: { sku: '83921', quantity: 2, cart_id: 'CART-01', price: 249.9 }
                },
                {
                    key: 'checkout_started',
                    count: 1,
                    timestamp: 1730106540000,
                    segmentation: { cart_id: 'CART-01', products_count: 2, amount: 842.5 }
                },
                {
                    key: 'order_submitted',
                    count: 1,
                    sum: 842.5,
                    timestamp: 1730106660000,
                    segmentation: { order_id: 'ORD-18527', products_count: 2, amount: 842.5, customer_type: 'B2B' }
                }
            ]);

            request(requestUrl)
                .get('/i')
                .query({
                    app_key: APP_KEY,
                    device_id: testDeviceId,
                    begin_session: 1,
                    user_details: userDetails,
                    events: events
                })
                .expect(200)
                .end(function (err) {
                    if (err) {
                        return done(err);
                    }
                    setTimeout(done, 300);
                });
        });

        it('should find Mario Rossi via /o/tt-user-insights/users and redact sensitive custom properties', function (done) {
            request(requestUrl)
                .get('/o/tt-user-insights/users')
                .query({
                    api_key: API_KEY_ADMIN,
                    app_id: APP_ID,
                    q: 'Mario Rossi'
                })
                .expect(200)
                .end(function (err, res) {
                    if (err) {
                        return done(err);
                    }
                    var body = res.body;
                    should.exist(body.users);
                    body.users.length.should.be.above(0);
                    body.users[0].name.should.equal('Mario Rossi');
                    body.users[0].deviceId.should.equal(testDeviceId);
                    if (body.users[0].customProperties && body.users[0].customProperties.password) {
                        body.users[0].customProperties.password.should.equal('[REDACTED]');
                    }
                    done();
                });
        });

        it('should return chronological activity timeline with view durations, session groups, and redacted PII', function (done) {
            request(requestUrl)
                .get('/o/tt-user-insights/timeline')
                .query({
                    api_key: API_KEY_ADMIN,
                    app_id: APP_ID,
                    device_id: testDeviceId
                })
                .expect(200)
                .end(function (err, res) {
                    if (err) {
                        return done(err);
                    }
                    var body = res.body;
                    should.exist(body.timeline);
                    should.exist(body.sessionGroups);
                    body.timeline.length.should.be.aboveOrEqual(8);
                    body.timeline[0].eventKey.should.equal('order_submitted');
                    body.timeline[0].type.should.equal('TT_BUSINESS_EVENT');

                    var homeView = body.timeline.find(function (ev) {
                        return ev.eventKey === '[CLY]_view' && ev.properties && ev.properties.name === 'Home';
                    });
                    if (homeView) {
                        homeView.type.should.equal('VIEW');
                        homeView.duration.should.equal(18);
                        homeView.durationFormatted.should.equal('18 sec');
                    }

                    var loginEv = body.timeline.find(function (ev) {
                        return ev.eventKey === 'user_login';
                    });
                    if (loginEv && loginEv.properties) {
                        loginEv.properties.access_token.should.equal('[REDACTED]');
                    }
                    done();
                });
        });

        it('should filter timeline by searches_only=true', function (done) {
            request(requestUrl)
                .get('/o/tt-user-insights/timeline')
                .query({
                    api_key: API_KEY_ADMIN,
                    app_id: APP_ID,
                    device_id: testDeviceId,
                    searches_only: 'true'
                })
                .expect(200)
                .end(function (err, res) {
                    if (err) {
                        return done(err);
                    }
                    var body = res.body;
                    should.exist(body.timeline);
                    body.timeline.length.should.equal(1);
                    body.timeline[0].eventKey.should.equal('search_performed');
                    body.timeline[0].searchAnalytics.query.should.equal('barbie camper');
                    body.timeline[0].searchAnalytics.resultsCount.should.equal(32);
                    done();
                });
        });
    });
});
