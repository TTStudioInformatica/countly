'use strict';

/**
 * Data Access Layer (Repository) for tt-user-insights.
 *
 * Architectural notes on Countly database collections:
 * 1. `app_users{app_id}` (Countly Core collection):
 *    Stores per-user profile & device metrics (`uid`, `did`, `fs`, `ls`, `lac`, `lbst`, `lest`, `lsid`, `hos`, `sd`, `tsd`, `sc`, `av`, `p`, `pv`, `d`, `cc`, `cty`)
 *    plus user properties synced via `/sdk/user_properties` (`name`, `username`, `email`, `custom`).
 * 2. `app_tt_user_events{app_id}` (Plugin-owned per-app collection):
 *    Stores individual user activity timeline items (Sessions, Views, TT Business Events, Custom Events, Crashes)
 *    with strict per-app isolation and compound indexes for multi-million-event scalability.
 */
var crypto = require('crypto');
var validators = require('./validators.js');
var eventRegistryModule = require('./eventRegistry.js');
var businessEventRendererModule = require('./businessEventRenderer.js');

var initializedAppIndexes = {};

var USER_PROJECTION = {
    _id: 1,
    uid: 1,
    did: 1,
    fs: 1,
    ls: 1,
    lac: 1,
    lbst: 1,
    lest: 1,
    lsid: 1,
    hos: 1,
    sd: 1,
    tsd: 1,
    sc: 1,
    av: 1,
    p: 1,
    pv: 1,
    d: 1,
    dt: 1,
    mnf: 1,
    cc: 1,
    cty: 1,
    rgn: 1,
    name: 1,
    username: 1,
    email: 1,
    organization: 1,
    phone: 1,
    custom: 1
};

var EVENT_PROJECTION = {
    _id: 1,
    uid: 1,
    did: 1,
    sid: 1,
    key: 1,
    ts: 1,
    endTs: 1,
    cd: 1,
    c: 1,
    s: 1,
    dur: 1,
    cat: 1,
    type: 1,
    rtype: 1,
    sg: 1
};

/**
 * Computes the MD5 short hash used by Countly Core (`common.getUserId`) when `uid` is derived from `device_id`.
 * @param {string} deviceId
 * @returns {string}
 */
function computeCountlyUid(deviceId) {
    return crypto.createHash('md5').update(String(deviceId)).digest('base64').slice(0, -4);
}

/**
 * Returns the collection name for the plugin's per-app event timeline storage.
 * Strictly validates `appId` to prevent cross-collection access.
 * @param {*} appId
 * @returns {string}
 */
function getEventsCollectionName(appId) {
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId) {
        throw new Error('Invalid app_id');
    }
    return 'app_tt_user_events' + cleanAppId;
}

/**
 * Returns the Countly core `app_users{app_id}` collection name.
 * @param {*} appId
 * @returns {string}
 */
function getUsersCollectionName(appId) {
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId) {
        throw new Error('Invalid app_id');
    }
    return 'app_users' + cleanAppId;
}

/**
 * Ensures all required compound indexes exist on `app_tt_user_events{app_id}` and `app_users{app_id}`.
 * Idempotent and cached per app in memory.
 * @param {Object} db - Countly MongoDB connection
 * @param {*} appId
 * @param {Function} [callback]
 */
function ensureIndexesForApp(db, appId, callback) {
    var cb = typeof callback === 'function' ? callback : function() {};
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId || !db) {
        return cb(new Error('Invalid db or app_id'));
    }

    if (initializedAppIndexes[cleanAppId]) {
        return cb(null);
    }

    initializedAppIndexes[cleanAppId] = true;
    var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
    var usersCol = db.collection(getUsersCollectionName(cleanAppId));

    var indexSpecs = [
        // 1. Primary chronological timeline index per user
        { col: eventsCol, spec: { uid: 1, ts: -1, _id: -1 }, opts: { name: 'tt_uid_ts_desc', background: true } },
        // 2. Fallback chronological timeline index by device_id
        { col: eventsCol, spec: { did: 1, ts: -1, _id: -1 }, opts: { name: 'tt_did_ts_desc', background: true } },
        // 3. Category filter index (authentication, navigation, search, catalog, cart, order, error, custom)
        { col: eventsCol, spec: { uid: 1, cat: 1, ts: -1 }, opts: { name: 'tt_uid_cat_ts_desc', background: true } },
        // 4. Event key filter & open view duration lookup index
        { col: eventsCol, spec: { uid: 1, key: 1, ts: -1 }, opts: { name: 'tt_uid_key_ts_desc', background: true } },
        // 5. Record type filter index (SESSION, VIEW, TT_BUSINESS_EVENT, CUSTOM_EVENT)
        { col: eventsCol, spec: { uid: 1, rtype: 1, ts: -1 }, opts: { name: 'tt_uid_rtype_ts_desc', background: true } },
        // 6. Session grouping & session duration update index
        { col: eventsCol, spec: { uid: 1, sid: 1, ts: -1 }, opts: { name: 'tt_uid_sid_ts_desc', sparse: true, background: true } },
        // 7. Global Live Events Stream chronological index (across all users of the app)
        { col: eventsCol, spec: { ts: -1, _id: -1 }, opts: { name: 'tt_live_ts_desc', background: true } },
        // 8. Global Live Events Stream category filter index (e.g. live errors, live orders)
        { col: eventsCol, spec: { cat: 1, ts: -1 }, opts: { name: 'tt_live_cat_ts_desc', background: true } },
        // 9. Sparse user identity search indexes on app_users{app_id}
        { col: usersCol, spec: { email: 1 }, opts: { name: 'tt_users_email', sparse: true, background: true } },
        { col: usersCol, spec: { name: 1 }, opts: { name: 'tt_users_name', sparse: true, background: true } },
        { col: usersCol, spec: { username: 1 }, opts: { name: 'tt_users_username', sparse: true, background: true } }
    ];

    var pending = indexSpecs.length;
    var firstErr = null;

    indexSpecs.forEach(function(item) {
        var ensureFn = item.col.createIndex || item.col.ensureIndex;
        if (typeof ensureFn !== 'function') {
            pending--;
            if (pending === 0) {
                cb(firstErr);
            }
            return;
        }
        ensureFn.call(item.col, item.spec, item.opts, function(err) {
            if (err && !firstErr) {
                firstErr = err;
            }
            pending--;
            if (pending === 0) {
                cb(firstErr);
            }
        });
    });
}

/**
 * Formats a raw MongoDB document from `app_users{app_id}` into a clean User Overview object,
 * including only properties that are actually available on the user record and redacting any PII keys.
 * @param {Object} doc - Raw document from `app_users{app_id}`
 * @returns {Object|null}
 */
function formatUserOverview(doc) {
    if (!doc || typeof doc !== 'object') {
        return null;
    }

    var overview = {
        uid: doc.uid !== undefined ? String(doc.uid) : (doc._id !== undefined ? String(doc._id) : null),
        deviceId: doc.did !== undefined ? String(doc.did) : null
    };

    var displayUser = doc.name || doc.username || doc.email || overview.uid || overview.deviceId;
    if (displayUser) {
        overview.displayName = String(displayUser);
    }

    if (doc.name !== undefined && doc.name !== null && doc.name !== '') {
        overview.name = String(doc.name);
    }
    if (doc.username !== undefined && doc.username !== null && doc.username !== '') {
        overview.username = String(doc.username);
    }
    if (doc.email !== undefined && doc.email !== null && doc.email !== '') {
        overview.email = String(doc.email);
    }
    if (doc.organization !== undefined && doc.organization !== null && doc.organization !== '') {
        overview.organization = String(doc.organization);
    }
    if (doc.phone !== undefined && doc.phone !== null && doc.phone !== '') {
        overview.phone = String(doc.phone);
    }

    if (typeof doc.fs === 'number' && doc.fs > 0) {
        overview.firstSeen = doc.fs < 10000000000 ? doc.fs * 1000 : doc.fs;
    }
    if (typeof doc.ls === 'number' && doc.ls > 0) {
        overview.lastSeen = doc.ls < 10000000000 ? doc.ls * 1000 : doc.ls;
    }
    var lastActivitySec = typeof doc.lac === 'number' && doc.lac > 0 ? doc.lac : doc.ls;
    if (typeof lastActivitySec === 'number' && lastActivitySec > 0) {
        overview.lastActivity = lastActivitySec < 10000000000 ? lastActivitySec * 1000 : lastActivitySec;
    }

    if (doc.av !== undefined && doc.av !== null && doc.av !== '') {
        overview.appVersion = String(doc.av);
    }
    if (doc.p !== undefined && doc.p !== null && doc.p !== '') {
        overview.os = String(doc.p);
        if (doc.pv !== undefined && doc.pv !== null && doc.pv !== '') {
            overview.osVersion = String(doc.pv);
            overview.osDisplay = String(doc.p) + ' ' + String(doc.pv);
        } else {
            overview.osDisplay = String(doc.p);
        }
    }
    if (doc.d !== undefined && doc.d !== null && doc.d !== '') {
        overview.device = String(doc.d);
    }
    if (doc.dt !== undefined && doc.dt !== null && doc.dt !== '') {
        overview.deviceType = String(doc.dt);
    }
    if (doc.mnf !== undefined && doc.mnf !== null && doc.mnf !== '') {
        overview.manufacturer = String(doc.mnf);
    }
    if (doc.cc !== undefined && doc.cc !== null && doc.cc !== '') {
        overview.country = String(doc.cc);
    }
    if (doc.cty !== undefined && doc.cty !== null && doc.cty !== '') {
        overview.city = String(doc.cty);
    }
    if (typeof doc.sc === 'number') {
        overview.sessionCount = doc.sc;
    }
    if (typeof doc.tsd === 'number') {
        overview.totalSessionDuration = doc.tsd;
    }

    if (doc.custom && typeof doc.custom === 'object' && !Array.isArray(doc.custom)) {
        var sanitizedCustom = validators.sanitizeEventSegments(doc.custom);
        if (Object.keys(sanitizedCustom).length > 0) {
            overview.customProperties = sanitizedCustom;
        }
    }

    return overview;
}

/**
 * Builds a safe MongoDB query for `app_users{app_id}` based on validated search filters.
 * @param {Object} filters
 * @returns {Object}
 */
function buildUserSearchQuery(filters) {
    var f = filters || {};
    var andConditions = [];

    if (f.uid) {
        andConditions.push({ uid: f.uid });
    }
    if (f.deviceId) {
        andConditions.push({ did: f.deviceId });
    }
    if (f.email) {
        var emailRegex = new RegExp('^' + validators.escapeRegExp(f.email), 'i');
        andConditions.push({ email: emailRegex });
    }
    if (f.name) {
        var nameRegex = new RegExp(validators.escapeRegExp(f.name), 'i');
        andConditions.push({ name: nameRegex });
    }
    if (f.username) {
        var userRegex = new RegExp('^' + validators.escapeRegExp(f.username), 'i');
        andConditions.push({ username: userRegex });
    }
    if (f.customKey) {
        var customFieldPath = 'custom.' + f.customKey;
        var customCond = {};
        if (f.customValue !== null && f.customValue !== undefined) {
            var numVal = Number(f.customValue);
            if (!Number.isNaN(numVal) && String(numVal) === f.customValue) {
                customCond.$or = [
                    (function() { var o = {}; o[customFieldPath] = f.customValue; return o; })(),
                    (function() { var o = {}; o[customFieldPath] = numVal; return o; })()
                ];
            } else {
                customCond[customFieldPath] = new RegExp(validators.escapeRegExp(f.customValue), 'i');
            }
        } else {
            customCond[customFieldPath] = { $exists: true, $ne: null };
        }
        andConditions.push(customCond);
    }

    if (f.q) {
        var escapedQ = validators.escapeRegExp(f.q);
        var containsRegex = new RegExp(escapedQ, 'i');
        var orClauses = [
            { uid: f.q },
            { did: f.q },
            { did: containsRegex },
            { name: containsRegex },
            { email: containsRegex },
            { username: containsRegex }
        ];

        var colonIdx = f.q.indexOf(':');
        if (colonIdx > 0 && colonIdx < f.q.length - 1) {
            var propKey = validators.sanitizeScalarString(f.q.substring(0, colonIdx), { maxLength: 64, disallowDollarPrefix: true });
            var propVal = validators.sanitizeScalarString(f.q.substring(colonIdx + 1), { maxLength: 128 });
            if (propKey && propKey.indexOf('.') === -1 && !validators.FORBIDDEN_KEYS[propKey] && propVal) {
                var dynClause = {};
                dynClause['custom.' + propKey] = new RegExp(validators.escapeRegExp(propVal), 'i');
                orClauses.push(dynClause);
            }
        }

        andConditions.push({ $or: orClauses });
    }

    if (andConditions.length === 0) {
        return {};
    }
    if (andConditions.length === 1) {
        return andConditions[0];
    }
    return { $and: andConditions };
}

/**
 * Searches users inside `app_users{app_id}` with pagination and projection.
 */
function searchUsers(db, appId, filters, pagination, callback) {
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId) {
        return callback(new Error('Invalid app_id'));
    }

    var usersCol = db.collection(getUsersCollectionName(cleanAppId));
    var query = buildUserSearchQuery(filters);
    var skip = pagination && typeof pagination.skip === 'number' ? pagination.skip : 0;
    var limit = pagination && typeof pagination.limit === 'number' ? pagination.limit : 25;

    usersCol.count(query, function(countErr, total) {
        if (countErr) {
            return callback(countErr);
        }

        usersCol
            .find(query, { projection: USER_PROJECTION })
            .sort({ lac: -1, ls: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(function(findErr, docs) {
                if (findErr) {
                    return callback(findErr);
                }

                var users = (docs || []).map(formatUserOverview).filter(Boolean);
                callback(null, {
                    users: users,
                    pagination: {
                        skip: skip,
                        limit: limit,
                        total: typeof total === 'number' ? total : users.length,
                        hasMore: skip + users.length < (typeof total === 'number' ? total : 0)
                    }
                });
            });
    });
}

/**
 * Retrieves a single user overview by `uid` or `deviceId` (`did`) within `app_users{app_id}`.
 */
function getUserOverview(db, appId, identifier, callback) {
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId) {
        return callback(new Error('Invalid app_id'));
    }

    var uid = identifier && identifier.uid ? validators.sanitizeScalarString(identifier.uid, { maxLength: 128, disallowDollarPrefix: true }) : null;
    var deviceId = identifier && identifier.deviceId ? validators.sanitizeScalarString(identifier.deviceId, { maxLength: 128, disallowDollarPrefix: true }) : null;

    if (!uid && !deviceId) {
        return callback(new Error('Missing uid or device_id'));
    }

    var usersCol = db.collection(getUsersCollectionName(cleanAppId));
    var query;
    if (uid && deviceId) {
        query = { $or: [{ uid: uid }, { did: deviceId }] };
    } else if (uid) {
        query = { $or: [{ uid: uid }, { _id: uid }, { did: uid }] };
    } else {
        var computedUid = computeCountlyUid(deviceId);
        query = { $or: [{ did: deviceId }, { uid: computedUid }] };
    }

    usersCol.findOne(query, { projection: USER_PROJECTION }, function(err, doc) {
        if (err) {
            return callback(err);
        }
        if (!doc) {
            return callback(null, null, null);
        }
        return callback(null, formatUserOverview(doc), doc);
    });
}

/**
 * Builds the MongoDB query for `app_tt_user_events{app_id}` timeline filtering.
 * Uses indexed fields (`uid` / `did`, `cat`, `key`, `rtype`, `sid`, `ts`) first.
 */
function buildTimelineQuery(filters, resolvedUser) {
    var f = filters || {};
    var andConditions = [];

    var targetUid = (resolvedUser && resolvedUser.uid) ? resolvedUser.uid : f.uid;
    var targetDid = (resolvedUser && resolvedUser.deviceId) ? resolvedUser.deviceId : f.deviceId;

    if (targetUid && targetDid) {
        andConditions.push({ $or: [{ uid: targetUid }, { did: targetDid }] });
    } else if (targetUid) {
        andConditions.push({ uid: targetUid });
    } else if (targetDid) {
        andConditions.push({ did: targetDid });
    }

    if (f.category) {
        andConditions.push({ cat: f.category });
    }

    if (f.recordType) {
        andConditions.push({ rtype: f.recordType });
    } else if (f.eventType) {
        andConditions.push({ type: f.eventType });
    }

    if (f.eventKey) {
        andConditions.push({ key: f.eventKey });
    }

    if (f.sessionId) {
        andConditions.push({ sid: f.sessionId });
    }

    if ((f.from !== null && f.from !== undefined) ||
        (f.to !== null && f.to !== undefined) ||
        (f.sinceTs !== null && f.sinceTs !== undefined && f.sinceTs > 0)) {
        var tsCond = {};
        if (f.from !== null && f.from !== undefined) {
            tsCond.$gte = f.from;
        }
        if (f.to !== null && f.to !== undefined) {
            tsCond.$lte = f.to;
        }
        if (f.sinceTs !== null && f.sinceTs !== undefined && f.sinceTs > 0) {
            tsCond.$gt = f.sinceTs;
        }
        andConditions.push({ ts: tsCond });
    }

    if (f.q) {
        var escaped = validators.escapeRegExp(f.q);
        var regex = new RegExp(escaped, 'i');
        andConditions.push({
            $or: [
                { key: regex },
                { cat: regex },
                { uid: regex },
                { did: regex },
                { 'sg.sku': regex },
                { 'sg.product_id': regex },
                { 'sg.name': regex },
                { 'sg.title': regex },
                { 'sg.query': regex },
                { 'sg.order_id': regex },
                { 'sg.cart_id': regex },
                { 'sg.category': regex },
                { 'sg.brand': regex },
                { 'sg.status': regex },
                { 'sg.filter_name': regex },
                { 'sg.filter_value': regex },
                { 'sg.error_message': regex },
                { 'sg.error_code': regex },
                { st: regex }
            ]
        });
    }

    if (andConditions.length === 0) {
        return {};
    }
    if (andConditions.length === 1) {
        return andConditions[0];
    }
    return { $and: andConditions };
}

/**
 * Builds visual session groups from rendered timeline items (Fase 8).
 *
 * IMPORTANT:
 * - Events are grouped into a visual session block ONLY if they carry a reliable `session.sessionId` (`sid`)
 *   recorded from Countly's session lifecycle (`lsid` / `session_id`).
 * - Events without a reliable `sid` are placed in an ungrouped block (`sessionId: null`, `isReliableSession: false`)
 *   so we NEVER fabricate or guess session boundaries.
 * @param {Array<Object>} renderedItems
 * @param {Object} sessionMetaMap
 * @returns {Array<Object>}
 */
function buildTimelineSessionGroups(renderedItems, sessionMetaMap) {
    if (!Array.isArray(renderedItems) || !renderedItems.length) {
        return [];
    }

    var groups = [];
    var currentGroup = null;

    for (var i = 0; i < renderedItems.length; i++) {
        var item = renderedItems[i];
        var itemSid = (item.session && item.session.sessionId) ? item.session.sessionId : null;

        if (!currentGroup || currentGroup.sessionId !== itemSid) {
            var meta = (itemSid && sessionMetaMap && sessionMetaMap[itemSid]) ? sessionMetaMap[itemSid] : null;
            currentGroup = {
                groupKey: itemSid ? ('session_' + itemSid + '_' + groups.length) : ('ungrouped_' + groups.length),
                sessionId: itemSid,
                isReliableSession: Boolean(itemSid),
                startTs: meta ? meta.startTs : item.timestamp,
                endTs: meta ? meta.endTs : item.timestamp,
                duration: meta ? meta.duration : null,
                durationFormatted: meta ? meta.durationFormatted : null,
                events: []
            };
            groups.push(currentGroup);
        }

        currentGroup.events.push(item);

        // Expand observed timestamp range within the current page slice if metadata was partial
        if (item.timestamp) {
            if (!currentGroup.startTs || item.timestamp < currentGroup.startTs) {
                currentGroup.startTs = item.timestamp;
            }
            if (!currentGroup.endTs || item.timestamp > currentGroup.endTs) {
                currentGroup.endTs = item.timestamp;
            }
        }
    }

    return groups;
}

/**
 * Retrieves the chronological activity timeline (newest to oldest) for a user,
 * applying `BusinessEventRenderer` and building reliable session metadata & groups.
 */
function getUserTimeline(db, appId, filters, pagination, callback) {
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId) {
        return callback(new Error('Invalid app_id'));
    }

    getUserOverview(db, cleanAppId, { uid: filters.uid, deviceId: filters.deviceId }, function(userErr, userOverview) {
        if (userErr) {
            return callback(userErr);
        }

        var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
        var query = buildTimelineQuery(filters, userOverview);
        var skip = pagination && typeof pagination.skip === 'number' ? pagination.skip : 0;
        var limit = pagination && typeof pagination.limit === 'number' ? pagination.limit : 25;

        eventsCol.count(query, function(countErr, total) {
            if (countErr) {
                return callback(countErr);
            }

            eventsCol
                .find(query, { projection: EVENT_PROJECTION })
                .sort({ ts: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .toArray(function(findErr, rawDocs) {
                    if (findErr) {
                        return callback(findErr);
                    }

                    var docsToRender = rawDocs || [];

                    // Build session metadata map from any session documents present in this slice
                    var sessionMetaMap = {};
                    docsToRender.forEach(function(d) {
                        if (!d.sid) {
                            return;
                        }
                        if (!sessionMetaMap[d.sid]) {
                            sessionMetaMap[d.sid] = {
                                sessionId: d.sid,
                                startTs: d.ts,
                                endTs: d.endTs || d.ts,
                                duration: null,
                                durationFormatted: null
                            };
                        } else {
                            if (d.ts < sessionMetaMap[d.sid].startTs) {
                                sessionMetaMap[d.sid].startTs = d.ts;
                            }
                            var candidateEnd = d.endTs || d.ts;
                            if (candidateEnd > sessionMetaMap[d.sid].endTs) {
                                sessionMetaMap[d.sid].endTs = candidateEnd;
                            }
                        }

                        if ((d.key === '[CLY]_session_begin' || d.key === '[CLY]_session_end') && d.dur > 0) {
                            var formattedDur = businessEventRendererModule.formatDurationSeconds(d.dur);
                            sessionMetaMap[d.sid].duration = formattedDur.seconds;
                            sessionMetaMap[d.sid].durationFormatted = formattedDur.formatted;
                        }
                    });

                    var items = businessEventRendererModule.renderer.renderMany(docsToRender, sessionMetaMap);
                    var sessionGroups = buildTimelineSessionGroups(items, sessionMetaMap);

                    callback(null, {
                        user: userOverview,
                        timeline: items,
                        sessionGroups: sessionGroups,
                        pagination: {
                            skip: skip,
                            limit: limit,
                            total: typeof total === 'number' ? total : items.length,
                            hasMore: skip + items.length < (typeof total === 'number' ? total : 0)
                        }
                    });
                });
        });
    });
}

/**
 * Retrieves the real-time Live Events Stream across the entire application (or filtered by user/category/error/since_ts),
 * enriching each event with the corresponding user's profile summary (`displayName`, `name`, `email`, `username`)
 * from `app_users{app_id}` in a single batched lookup.
 */
function getLiveEventsStream(db, appId, filters, pagination, callback) {
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId) {
        return callback(new Error('Invalid app_id'));
    }

    var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
    var usersCol = db.collection(getUsersCollectionName(cleanAppId));
    var query = buildTimelineQuery(filters, null);
    var skip = pagination && typeof pagination.skip === 'number' ? pagination.skip : 0;
    var limit = pagination && typeof pagination.limit === 'number' ? pagination.limit : 40;

    eventsCol.count(query, function(countErr, total) {
        if (countErr) {
            return callback(countErr);
        }

        eventsCol
            .find(query, { projection: EVENT_PROJECTION })
            .sort({ ts: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(function(findErr, rawDocs) {
                if (findErr) {
                    return callback(findErr);
                }

                var docsToRender = rawDocs || [];
                var items = businessEventRendererModule.renderer.renderMany(docsToRender);

                // Collect distinct uids to batch-enrich user display names
                var distinctUids = [];
                var uidSet = {};
                items.forEach(function(item) {
                    var u = item.user && item.user.uid ? item.user.uid : null;
                    if (u && !uidSet[u]) {
                        uidSet[u] = true;
                        distinctUids.push(u);
                    }
                });

                var latestTimestamp = items.length > 0 ? items[0].timestamp : (filters && filters.sinceTs ? filters.sinceTs : 0);

                if (distinctUids.length === 0) {
                    return callback(null, {
                        events: items,
                        latestTimestamp: latestTimestamp,
                        pagination: {
                            skip: skip,
                            limit: limit,
                            total: typeof total === 'number' ? total : items.length,
                            hasMore: skip + items.length < (typeof total === 'number' ? total : 0)
                        }
                    });
                }

                usersCol
                    .find({ uid: { $in: distinctUids } }, { projection: USER_PROJECTION })
                    .toArray(function(uErr, userDocs) {
                        var userMap = {};
                        if (!uErr && Array.isArray(userDocs)) {
                            userDocs.forEach(function(uDoc) {
                                var formatted = formatUserOverview(uDoc);
                                if (formatted && formatted.uid) {
                                    userMap[formatted.uid] = formatted;
                                }
                            });
                        }

                        items.forEach(function(item) {
                            var itemUid = item.user && item.user.uid ? item.user.uid : null;
                            if (itemUid && userMap[itemUid]) {
                                var uProfile = userMap[itemUid];
                                item.user = {
                                    uid: uProfile.uid,
                                    deviceId: uProfile.deviceId || item.user.deviceId,
                                    displayName: uProfile.displayName,
                                    name: uProfile.name || null,
                                    email: uProfile.email || null,
                                    username: uProfile.username || null
                                };
                            } else if (item.user) {
                                item.user.displayName = item.user.deviceId || item.user.uid || 'Unknown';
                            }
                        });

                        callback(null, {
                            events: items,
                            latestTimestamp: latestTimestamp,
                            pagination: {
                                skip: skip,
                                limit: limit,
                                total: typeof total === 'number' ? total : items.length,
                                hasMore: skip + items.length < (typeof total === 'number' ? total : 0)
                            }
                        });
                    });
            });
    });
}

/**
 * Retrieves the Error / Event Breadcrumb trail (the N actions performed by the user immediately prior to `beforeTs`).
 * Allows developers and operators to reproduce bugs by seeing the exact step-by-step sequence leading up to an error.
 */
function getEventBreadcrumbs(db, appId, params, callback) {
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId) {
        return callback(new Error('Invalid app_id'));
    }

    var p = params || {};
    var beforeTs = typeof p.beforeTs === 'number' ? p.beforeTs : Date.now();
    var limit = typeof p.limit === 'number' ? p.limit : 10;

    var andConds = [{ ts: { $lte: beforeTs } }];
    if (p.uid && p.deviceId) {
        andConds.push({ $or: [{ uid: p.uid }, { did: p.deviceId }] });
    } else if (p.uid) {
        andConds.push({ uid: p.uid });
    } else if (p.deviceId) {
        andConds.push({ did: p.deviceId });
    } else {
        return callback(new Error('Missing uid or device_id'));
    }

    var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
    eventsCol
        .find({ $and: andConds }, { projection: EVENT_PROJECTION })
        .sort({ ts: -1, _id: -1 })
        .limit(limit + 1)
        .toArray(function(err, rawDocs) {
            if (err) {
                return callback(err);
            }

            var filtered = (rawDocs || []).filter(function(doc) {
                if (p.eventId && String(doc._id) === String(p.eventId)) {
                    return false;
                }
                return true;
            }).slice(0, limit);

            var rendered = businessEventRendererModule.renderer.renderMany(filtered);
            rendered.forEach(function(item) {
                var diffSec = Math.max(0, Math.round((beforeTs - item.timestamp) / 1000));
                item.secondsBeforeTarget = diffSec;
                var formattedDelta = businessEventRendererModule.formatDurationSeconds(diffSec);
                item.relativeTimeBefore = diffSec === 0 ? '0 sec' : ('-' + (formattedDelta.formatted || (diffSec + ' sec')));
            });

            // Also provide chronological order (oldest step first -> leading right up to the error)
            var chronologicalSteps = rendered.slice().reverse();

            callback(null, {
                beforeTimestamp: beforeTs,
                breadcrumbs: chronologicalSteps,
                breadcrumbsDesc: rendered
            });
        });
}

/**
 * Builds a compact searchable string (`st`) from sanitized segments to accelerate text search on custom properties.
 * (Runs AFTER `sanitizeEventSegments`, so redacted PII values are never indexed in `st`).
 */
function buildSearchableText(eventKey, segments) {
    var parts = [eventKey];
    if (segments && typeof segments === 'object') {
        var keys = Object.keys(segments);
        for (var i = 0; i < keys.length; i++) {
            var val = segments[keys[i]];
            if (val !== undefined && val !== null && val !== '' && val !== '[REDACTED]') {
                parts.push(String(keys[i]) + ':' + String(val));
            }
        }
    }
    var joined = parts.join(' ');
    return joined.length > 512 ? joined.substring(0, 512) : joined;
}

/**
 * Resolves a reliable Countly Session ID (`sid`) for an incoming event or request.
 *
 * Returns a non-null `sid` ONLY when Countly has a verifiable session association:
 * 1. Explicit `session_id` in event segmentation or request query string;
 * 2. `params.tt_active_sid` set during the current `/i` request (`begin_session=1`);
 * 3. `params.app_user.lsid` set by Countly Core AND the event timestamp `tsMs` is not older
 *    than `params.app_user.lbst` (the start of that session, with 5s tolerance for clock skew).
 *
 * If none of these hold, returns `null` (never invents a session ID).
 * @param {Object} params
 * @param {Object} currEvent
 * @param {number} tsMs
 * @returns {string|null}
 */
function resolveReliableSessionId(params, currEvent, tsMs) {
    if (currEvent && currEvent.segmentation && typeof currEvent.segmentation.session_id === 'string' && currEvent.segmentation.session_id.trim()) {
        return currEvent.segmentation.session_id.trim().substring(0, 128);
    }
    if (params && params.qstring && typeof params.qstring.session_id === 'string' && params.qstring.session_id.trim()) {
        return params.qstring.session_id.trim().substring(0, 128);
    }
    if (params && typeof params.tt_active_sid === 'string' && params.tt_active_sid) {
        return params.tt_active_sid;
    }
    if (params && params.app_user && typeof params.app_user.lsid === 'string' && params.app_user.lsid) {
        var lbstSec = typeof params.app_user.lbst === 'number' ? params.app_user.lbst : 0;
        var lbstMs = lbstSec > 0 ? (lbstSec < 10000000000 ? lbstSec * 1000 : lbstSec) : 0;
        // Verify that the event did not happen before this session started
        if (lbstMs === 0 || tsMs >= (lbstMs - 5000)) {
            return params.app_user.lsid;
        }
    }
    return null;
}

/**
 * Normalizes a raw timestamp (seconds or milliseconds) into milliseconds.
 * @param {*} rawTs
 * @param {Object} [params]
 * @returns {number}
 */
function normalizeTimestampMs(rawTs, params) {
    var candidate = rawTs || (params && params.time && (params.time.mstimestamp || params.time.timestamp)) || Date.now();
    var tsNum = Number(candidate);
    if (Number.isNaN(tsNum) || !Number.isFinite(tsNum) || tsNum <= 0) {
        return Date.now();
    }
    return tsNum < 10000000000 ? Math.floor(tsNum * 1000) : Math.floor(tsNum);
}

/**
 * Extracts a reliable positive duration (in seconds) from an event if genuinely provided by Countly/SDK.
 * Guards against SDK bug where a 10+ digit UNIX timestamp is accidentally sent in `dur` (same check as Countly `views`).
 * Returns `null` if not provided or <= 0.
 * @param {Object} currEvent
 * @returns {number|null}
 */
function extractReliableDurationSeconds(currEvent) {
    if (!currEvent || typeof currEvent !== 'object') {
        return null;
    }
    var rawDur = currEvent.dur !== undefined && currEvent.dur !== null
        ? currEvent.dur
        : (currEvent.segmentation && currEvent.segmentation.dur !== undefined ? currEvent.segmentation.dur : null);
    if (rawDur === null || rawDur === undefined || rawDur === '') {
        return null;
    }
    var num = Math.round(Number(rawDur));
    if (Number.isNaN(num) || !Number.isFinite(num) || num <= 0 || String(num).length >= 10) {
        return null;
    }
    return num;
}

/**
 * Updates the `dur` of the most recent open `[CLY]_view` document for a user and view name (or `_idv`)
 * when Countly SDK sends the closing `[CLY]_view` duration report (without `visit: 1`).
 * @param {Object} db
 * @param {*} appId
 * @param {string} uid
 * @param {string} viewName
 * @param {number} durationSeconds
 * @param {string} [viewInstanceId] - Optional `_idv` from Countly SDK
 * @param {Function} [callback]
 */
function updateOpenViewDuration(db, appId, uid, viewName, durationSeconds, viewInstanceId, callback) {
    var cb = typeof callback === 'function' ? callback : function() {};
    var cleanAppId = validators.validateAppId(appId);
    var parsedDur = extractReliableDurationSeconds({ dur: durationSeconds });
    if (!cleanAppId || !db || !uid || !viewName || parsedDur === null) {
        return cb(null, false);
    }

    var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
    var query = {
        uid: String(uid),
        key: '[CLY]_view',
        'sg.name': String(viewName)
    };
    if (viewInstanceId) {
        query['sg._idv'] = String(viewInstanceId);
    }

    eventsCol
        .find(query, { projection: { _id: 1, ts: 1, dur: 1 } })
        .sort({ ts: -1, _id: -1 })
        .limit(1)
        .toArray(function(err, docs) {
            if (err || !docs || !docs.length) {
                return cb(err || null, false);
            }
            var targetDoc = docs[0];
            var newDur = (typeof targetDoc.dur === 'number' && targetDoc.dur > 0)
                ? (targetDoc.dur + parsedDur)
                : parsedDur;

            var updateFn = eventsCol.updateOne || eventsCol.update;
            updateFn.call(eventsCol, { _id: targetDoc._id }, { $set: { dur: newDur } }, function(updErr) {
                cb(updErr, !updErr);
            });
        });
}

/**
 * Updates the duration and end timestamp of an active session (`[CLY]_session_begin`)
 * when `/session/duration` or `/session/end` is received.
 */
function updateSessionMetrics(db, appId, uid, sessionId, durationSeconds, endTsMs, callback) {
    var cb = typeof callback === 'function' ? callback : function() {};
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId || !db || !uid || !sessionId) {
        return cb(null);
    }

    var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
    var updateSet = {};
    var parsedDur = extractReliableDurationSeconds({ dur: durationSeconds });
    if (parsedDur !== null) {
        updateSet.dur = parsedDur;
    }
    if (typeof endTsMs === 'number' && endTsMs > 0) {
        updateSet.endTs = endTsMs;
    }
    if (Object.keys(updateSet).length === 0) {
        return cb(null);
    }

    var updateFn = eventsCol.updateMany || eventsCol.update;
    updateFn.call(
        eventsCol,
        { uid: String(uid), sid: String(sessionId), key: '[CLY]_session_begin' },
        { $set: updateSet },
        { multi: true },
        function(err) {
            cb(err);
        }
    );
}

/**
 * Ingests a single Countly event into `app_tt_user_events{app_id}`.
 *
 * Handles:
 * - Standard custom events & TT Analytics Tracking Standard v1 business events
 * - Countly `[CLY]_view` events (including 2-phase closing view duration updates)
 * - Countly `[CLY]_session_begin` and `[CLY]_session_end` events
 * - Countly `[CLY]_crash` events
 * - PII Redaction via `validators.sanitizeEventSegments`
 */
function ingestEvent(db, params, currEvent, callback) {
    var cb = typeof callback === 'function' ? callback : function() {};
    if (!db || !params || !params.app_id || !currEvent || typeof currEvent.key !== 'string') {
        return cb(null);
    }

    // Deduplication guard if the event was already processed in an earlier hook of the same request
    if (currEvent._ttIngested) {
        return cb(null);
    }

    var cleanAppId = validators.validateAppId(params.app_id);
    if (!cleanAppId) {
        return cb(null);
    }

    var deviceId = params.qstring && params.qstring.device_id
        ? validators.sanitizeScalarString(params.qstring.device_id, { maxLength: 128, disallowDollarPrefix: true })
        : (params.app_user && params.app_user.did ? String(params.app_user.did) : null);
    var uid = (params.app_user && params.app_user.uid)
        ? String(params.app_user.uid)
        : (params.app_user_id ? String(params.app_user_id) : (deviceId ? computeCountlyUid(deviceId) : null));

    if (!uid && !deviceId) {
        return cb(null);
    }

    var eventKey = currEvent.key.trim().substring(0, 128);
    if (!eventKey) {
        return cb(null);
    }

    var rawSeg = (currEvent.segmentation && typeof currEvent.segmentation === 'object') ? currEvent.segmentation : {};
    var reliableDur = extractReliableDurationSeconds(currEvent);

    // Special handling for Countly 2-phase `[CLY]_view` closing duration event:
    // When `eventKey === '[CLY]_view'` and `visit` is NOT set, Countly SDK is reporting the duration of the previous view.
    if (eventKey === '[CLY]_view' && !rawSeg.visit && reliableDur !== null && rawSeg.name) {
        Object.defineProperty(currEvent, '_ttIngested', { value: true, enumerable: false, configurable: true });
        return updateOpenViewDuration(db, cleanAppId, uid, rawSeg.name, reliableDur, rawSeg._idv, function(err) {
            cb(err);
        });
    }

    Object.defineProperty(currEvent, '_ttIngested', { value: true, enumerable: false, configurable: true });

    var tsNum = normalizeTimestampMs(currEvent.timestamp, params);
    var sessionId = resolveReliableSessionId(params, currEvent, tsNum);
    var segments = validators.sanitizeEventSegments(rawSeg);
    var classification = eventRegistryModule.registry.classifyEventKey(eventKey);

    var doc = {
        uid: uid,
        did: deviceId,
        sid: sessionId,
        key: eventKey,
        ts: tsNum,
        cd: new Date(tsNum),
        c: typeof currEvent.count === 'number' && currEvent.count > 0 ? currEvent.count : 1,
        s: typeof currEvent.sum === 'number' && Number.isFinite(currEvent.sum) ? currEvent.sum : 0,
        dur: reliableDur,
        cat: classification.category,
        type: classification.eventType,
        rtype: classification.recordType,
        sg: segments,
        st: buildSearchableText(eventKey, segments)
    };

    ensureIndexesForApp(db, cleanAppId, function() {
        var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
        eventsCol.insertOne(doc, function(err) {
            cb(err, doc);
        });
    });
}

/**
 * Processes an array of raw events in `params.qstring.events` during `/sdk/user_properties`
 * BEFORE the `views` plugin strips `[CLY]_view` from `params.qstring.events`.
 *
 * Also performs same-batch view duration merging (matching `[CLY]_view` with `visit: 1` and closing `[CLY]_view` with `dur > 0`
 * in the same batch) without mutating Countly's `params.qstring.events` structure.
 */
function preprocessSdkEventsBatch(db, params, callback) {
    var cb = typeof callback === 'function' ? callback : function() {};
    if (!db || !params || !params.qstring || !Array.isArray(params.qstring.events) || !params.qstring.events.length) {
        return cb(null);
    }

    var events = params.qstring.events;
    // Map open view visits in this batch by view name so same-batch closing view durations merge cleanly
    var openVisitsByName = {};
    var toProcess = [];

    for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (!ev || typeof ev !== 'object' || typeof ev.key !== 'string') {
            continue;
        }
        if (ev.key === '[CLY]_view' && ev.segmentation && ev.segmentation.name) {
            var vName = String(ev.segmentation.name);
            var vDur = extractReliableDurationSeconds(ev);
            if (ev.segmentation.visit) {
                var clonedVisit = {
                    key: '[CLY]_view',
                    count: ev.count || 1,
                    timestamp: ev.timestamp,
                    dur: vDur,
                    segmentation: Object.assign({}, ev.segmentation)
                };
                Object.defineProperty(ev, '_ttIngested', { value: true, enumerable: false, configurable: true });
                openVisitsByName[vName] = openVisitsByName[vName] || [];
                openVisitsByName[vName].push(clonedVisit);
                toProcess.push(clonedVisit);
            } else if (vDur !== null) {
                // Closing view duration event in same batch or from earlier batch
                Object.defineProperty(ev, '_ttIngested', { value: true, enumerable: false, configurable: true });
                var candidates = openVisitsByName[vName];
                if (candidates && candidates.length > 0) {
                    var target = candidates[candidates.length - 1];
                    if (ev.segmentation._idv) {
                        for (var c = candidates.length - 1; c >= 0; c--) {
                            if (candidates[c].segmentation._idv === ev.segmentation._idv) {
                                target = candidates[c];
                                break;
                            }
                        }
                    }
                    target.dur = (target.dur || 0) + vDur;
                } else {
                    // Belongs to a view opened in a previous HTTP batch -> update existing DB document
                    toProcess.push({
                        key: '[CLY]_view',
                        timestamp: ev.timestamp,
                        dur: vDur,
                        segmentation: Object.assign({}, ev.segmentation, { visit: 0 })
                    });
                }
            }
        }
    }

    if (!toProcess.length) {
        return cb(null);
    }

    var idx = 0;
    function next() {
        if (idx >= toProcess.length) {
            return cb(null);
        }
        var item = toProcess[idx++];
        ingestEvent(db, params, item, function() {
            next();
        });
    }
    next();
}

/**
 * Extracts and sanitizes `user_details` from `/i` SDK requests and pushes `$set` operations
 * into `ob.updates` during the `/sdk/user_properties` hook so Countly Core persists
 * `name`, `username`, `email`, and PII-redacted `custom.*` directly into `app_users{app_id}`.
 */
function applyUserDetailsUpdates(ob) {
    if (!ob || !ob.params || !ob.params.qstring || !ob.params.qstring.user_details || !ob.updates) {
        return;
    }

    var details = ob.params.qstring.user_details;
    if (typeof details === 'string') {
        try {
            details = JSON.parse(details);
        } catch (e) {
            return;
        }
    }
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
        return;
    }

    var setPayload = {};

    var scalarFields = ['name', 'username', 'email', 'organization', 'phone'];
    for (var i = 0; i < scalarFields.length; i++) {
        var field = scalarFields[i];
        if (details[field] !== undefined && details[field] !== null) {
            var cleanVal = validators.sanitizeScalarString(details[field], { maxLength: 256, disallowDollarPrefix: true });
            if (cleanVal !== null) {
                setPayload[field] = validators.maskSensitiveStringContent(cleanVal);
            }
        }
    }

    if (details.custom && typeof details.custom === 'object' && !Array.isArray(details.custom)) {
        var sanitizedCustom = validators.sanitizeEventSegments(details.custom);
        var customKeys = Object.keys(sanitizedCustom);
        for (var j = 0; j < customKeys.length; j++) {
            var ck = customKeys[j];
            setPayload['custom.' + ck] = sanitizedCustom[ck];
        }
    }

    if (Object.keys(setPayload).length > 0) {
        if (Array.isArray(ob.updates)) {
            ob.updates.push({ $set: setPayload });
        } else if (typeof ob.updates === 'object') {
            ob.updates.$set = Object.assign(ob.updates.$set || {}, setPayload);
        }
    }
}

/**
 * Deletes stored timeline events when users are deleted via `/i/app_users/delete` (GDPR compliance).
 */
function deleteUsersData(db, appId, uids, callback) {
    var cb = typeof callback === 'function' ? callback : function() {};
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId || !Array.isArray(uids) || !uids.length) {
        return cb(null);
    }

    var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
    var deleteFn = eventsCol.deleteMany || eventsCol.remove;
    deleteFn.call(eventsCol, { uid: { $in: uids } }, function(err) {
        cb(err);
    });
}

/**
 * Reassigns events from `oldUid` to `newUid` when Countly merges a temporary device ID into a permanent user ID (`/i/device_id`).
 */
function mergeUserUid(db, appId, oldUid, newUid, newDeviceId, callback) {
    var cb = typeof callback === 'function' ? callback : function() {};
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId || !oldUid || !newUid || oldUid === newUid) {
        return cb(null);
    }

    var eventsCol = db.collection(getEventsCollectionName(cleanAppId));
    var updateDoc = { $set: { uid: newUid } };
    if (newDeviceId) {
        updateDoc.$set.did = newDeviceId;
    }

    var updateFn = eventsCol.updateMany || eventsCol.update;
    updateFn.call(eventsCol, { uid: oldUid }, updateDoc, { multi: true }, function(err) {
        cb(err);
    });
}

/**
 * Drops `app_tt_user_events{app_id}` when an app is deleted or reset.
 */
function dropAppData(db, appId, callback) {
    var cb = typeof callback === 'function' ? callback : function() {};
    var cleanAppId = validators.validateAppId(appId);
    if (!cleanAppId || !db) {
        return cb(null);
    }
    delete initializedAppIndexes[cleanAppId];
    db.collection(getEventsCollectionName(cleanAppId)).drop(function() {
        cb(null);
    });
}

module.exports = {
    computeCountlyUid: computeCountlyUid,
    getEventsCollectionName: getEventsCollectionName,
    getUsersCollectionName: getUsersCollectionName,
    ensureIndexesForApp: ensureIndexesForApp,
    formatUserOverview: formatUserOverview,
    buildUserSearchQuery: buildUserSearchQuery,
    searchUsers: searchUsers,
    getUserOverview: getUserOverview,
    buildTimelineQuery: buildTimelineQuery,
    buildTimelineSessionGroups: buildTimelineSessionGroups,
    getUserTimeline: getUserTimeline,
    getLiveEventsStream: getLiveEventsStream,
    getEventBreadcrumbs: getEventBreadcrumbs,
    resolveReliableSessionId: resolveReliableSessionId,
    extractReliableDurationSeconds: extractReliableDurationSeconds,
    updateOpenViewDuration: updateOpenViewDuration,
    updateSessionMetrics: updateSessionMetrics,
    ingestEvent: ingestEvent,
    preprocessSdkEventsBatch: preprocessSdkEventsBatch,
    applyUserDetailsUpdates: applyUserDetailsUpdates,
    deleteUsersData: deleteUsersData,
    mergeUserUid: mergeUserUid,
    dropAppData: dropAppData
};
