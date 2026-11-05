'use strict';

/**
 * Backend Entry Point for tt-user-insights Countly Plugin.
 *
 * Uses ONLY real Countly 25.03.0 APIs, hooks, and authorization utilities:
 * - Permission registration: `/permissions/features` (`FEATURE_NAME = "tt_user_insights"`)
 * - Read endpoint authorization: `validateRead` from `../../../api/utils/rights.js`
 * - Response helpers: `common.returnOutput` / `common.returnMessage` from `../../../api/utils/common.js`
 * - Ingestion & lifecycle hooks:
 *   - `/master`
 *   - `/i/apps/create`, `/i/apps/delete`, `/i/apps/reset`
 *   - `/i/app_users/delete`, `/i/device_id`
 *   - `/sdk/user_properties`
 *   - `/i/events`
 *   - `/plugins/drill`, `/view/duration`
 *   - `/session/begin`, `/session/duration`, `/session/end`
 * - Read API endpoints under `/o/tt-user-insights`:
 *   - `GET /o/tt-user-insights/users`
 *   - `GET /o/tt-user-insights/users/details`
 *   - `GET /o/tt-user-insights/timeline`
 *   - `GET /o/tt-user-insights/definitions`
 */
var plugins = require('../../pluginManager.js');
var common = require('../../../api/utils/common.js');
var rights = require('../../../api/utils/rights.js');
var log = common.log('tt-user-insights:api');

var eventRegistryModule = require('./lib/eventRegistry.js');
var businessEventRendererModule = require('./lib/businessEventRenderer.js');
var validators = require('./lib/validators.js');
var repository = require('./lib/repository.js');

var FEATURE_NAME = 'tt_user_insights';

(function (plugin) {
    /**
     * Helper to retrieve the active plugin configuration via Countly's pluginManager.
     */
    function getPluginConfig(appId) {
        return plugins.getConfig('tt-user-insights', appId) || {};
    }

    /**
     * Extracts user uid from Countly's `params` object.
     */
    function resolveUidFromParams(params) {
        if (!params) {
            return null;
        }
        if (params.app_user && params.app_user.uid) {
            return String(params.app_user.uid);
        }
        if (params.app_user_id) {
            return String(params.app_user_id);
        }
        if (params.qstring && params.qstring.device_id) {
            return repository.computeCountlyUid(String(params.qstring.device_id));
        }
        return null;
    }

    // =========================================================================
    // 1. PERMISSION & FEATURE REGISTRATION
    // =========================================================================
    plugins.register('/permissions/features', function (ob) {
        if (ob && Array.isArray(ob.features) && ob.features.indexOf(FEATURE_NAME) === -1) {
            ob.features.push(FEATURE_NAME);
        }
    });

    // =========================================================================
    // 2. MASTER & APP LIFECYCLE HOOKS
    // =========================================================================
    plugins.register('/master', function () {
        if (!common.db) {
            return;
        }
        common.db.collection('apps').find({}, { projection: { _id: 1 } }).toArray(function (err, apps) {
            if (err || !Array.isArray(apps)) {
                return;
            }
            apps.forEach(function (app) {
                repository.ensureIndexesForApp(common.db, app._id);
            });
        });
    });

    plugins.register('/i/apps/create', function (ob) {
        if (ob && ob.data && ob.data._id && common.db) {
            repository.ensureIndexesForApp(common.db, ob.data._id);
        }
    });

    plugins.register('/i/apps/delete', function (ob) {
        if (ob && ob.app_id && common.db) {
            repository.dropAppData(common.db, ob.app_id);
        }
    });

    plugins.register('/i/apps/reset', function (ob) {
        if (ob && ob.app_id && common.db) {
            repository.dropAppData(common.db, ob.app_id, function () {
                repository.ensureIndexesForApp(common.db, ob.app_id);
            });
        }
    });

    plugins.register('/i/app_users/delete', function (ob) {
        if (ob && ob.app_id && Array.isArray(ob.uids) && common.db) {
            repository.deleteUsersData(common.db, ob.app_id, ob.uids);
        }
    });

    plugins.register('/i/device_id', function (ob) {
        if (ob && ob.params && ob.params.app_id && ob.oldUid && ob.uid && common.db) {
            var newDid = ob.params.qstring ? ob.params.qstring.device_id : null;
            repository.mergeUserUid(common.db, ob.params.app_id, ob.oldUid, ob.uid, newDid);
        }
    });

    // =========================================================================
    // 3. SDK USER PROPERTIES, VIEW, CRASH & EVENT INGESTION HOOKS
    // =========================================================================
    plugins.register('/sdk/user_properties', function (ob) {
        if (!ob || !ob.params) {
            return;
        }
        var params = ob.params;
        var cfg = getPluginConfig(params.app_id);

        // 3a. Determine reliable active session ID (`tt_active_sid`) when `begin_session` is in this request
        if (params.qstring && params.qstring.begin_session && params.request_id) {
            var sessionCooldown = plugins.getConfig('api', params.app_id)
                ? plugins.getConfig('api', params.app_id).session_cooldown
                : 15;
            if (params.app_user && params.app_user.lsid && params.app_user.lest &&
                params.time && (params.time.timestamp - params.app_user.lest < sessionCooldown)) {
                params.tt_active_sid = params.app_user.lsid;
            } else {
                params.tt_active_sid = params.request_id;
            }
        }

        // 3b. Sync user_details into app_users{app_id}
        if (cfg.sync_user_details !== false) {
            repository.applyUserDetailsUpdates(ob);
        }

        if (!common.db || cfg.store_user_events === false) {
            return;
        }

        // 3c. Pre-process `[CLY]_view` events in `params.qstring.events` BEFORE `views` plugin strips them
        if (cfg.track_views !== false && params.qstring && Array.isArray(params.qstring.events)) {
            repository.preprocessSdkEventsBatch(common.db, params);
        }

        // 3d. Capture SDK crashes (`params.qstring.crash`) as `[CLY]_crash` timeline events
        if (cfg.track_crashes !== false && params.qstring && params.qstring.crash) {
            var rawCrash = params.qstring.crash;
            if (typeof rawCrash === 'string') {
                try {
                    rawCrash = JSON.parse(rawCrash);
                } catch (e) {
                    rawCrash = null;
                }
            }
            if (rawCrash && typeof rawCrash === 'object') {
                var crashSeg = {};
                if (rawCrash._name) {
                    crashSeg.name = String(rawCrash._name).substring(0, 256);
                }
                if (rawCrash._error) {
                    crashSeg.error = String(rawCrash._error).split('\n')[0].substring(0, 256);
                }
                if (rawCrash._type) {
                    crashSeg.type = String(rawCrash._type).substring(0, 128);
                }
                if (rawCrash._view) {
                    crashSeg.view = String(rawCrash._view).substring(0, 128);
                }
                if (rawCrash._nonfatal !== undefined) {
                    crashSeg.nonfatal = Boolean(rawCrash._nonfatal);
                }
                repository.ingestEvent(common.db, params, {
                    key: '[CLY]_crash',
                    count: 1,
                    timestamp: params.time && params.time.timestamp ? params.time.timestamp : Date.now(),
                    segmentation: crashSeg
                });
            }
        }
    });

    plugins.register('/i/events', function (ob) {
        if (!ob || !ob.params || !ob.currEvent || !common.db) {
            return;
        }
        var cfg = getPluginConfig(ob.params.app_id);
        if (cfg.store_user_events === false) {
            return;
        }
        if (ob.currEvent.key === '[CLY]_view' && cfg.track_views === false) {
            return;
        }
        repository.ingestEvent(common.db, ob.params, ob.currEvent, function (err) {
            if (err) {
                log.d('Error ingesting event in tt-user-insights', err);
            }
        });
    });

    // Fallback hook if `views` plugin ran before `tt-user-insights` and dispatched `/plugins/drill` for `[CLY]_view`
    plugins.register('/plugins/drill', function (ob) {
        if (!ob || !ob.params || !ob.currEvent || ob.currEvent.key !== '[CLY]_view' || !common.db) {
            return;
        }
        var cfg = getPluginConfig(ob.params.app_id);
        if (cfg.store_user_events === false || cfg.track_views === false) {
            return;
        }
        repository.ingestEvent(common.db, ob.params, ob.currEvent);
    });

    // Hook dispatched by Countly `views` plugin when a closing `[CLY]_view` event reports view duration (`dur`)
    plugins.register('/view/duration', function (ob) {
        if (!ob || !ob.params || !ob.view || !common.db) {
            return;
        }
        var cfg = getPluginConfig(ob.params.app_id);
        if (cfg.store_user_events === false || cfg.track_views === false) {
            return;
        }
        var uid = resolveUidFromParams(ob.params);
        if (!uid) {
            return;
        }
        repository.updateOpenViewDuration(common.db, ob.params.app_id, uid, ob.view, ob.duration, null);
    });

    plugins.register('/session/begin', function (ob) {
        if (!ob || !ob.params || !common.db) {
            return;
        }
        var cfg = getPluginConfig(ob.params.app_id);
        if (cfg.store_user_events === false || cfg.track_sessions === false) {
            return;
        }
        if (ob.params.request_id && !ob.params.tt_active_sid) {
            ob.params.tt_active_sid = ob.params.request_id;
        }
        repository.ingestEvent(common.db, ob.params, {
            key: '[CLY]_session_begin',
            count: 1,
            timestamp: ob.params.time && ob.params.time.timestamp ? ob.params.time.timestamp : Date.now(),
            segmentation: {}
        });
    });

    plugins.register('/session/duration', function (ob) {
        if (!ob || !ob.params || !common.db) {
            return;
        }
        var cfg = getPluginConfig(ob.params.app_id);
        if (cfg.store_user_events === false || cfg.track_sessions === false) {
            return;
        }
        var uid = resolveUidFromParams(ob.params);
        var sid = ob.params.app_user && ob.params.app_user.lsid ? ob.params.app_user.lsid : null;
        var endTsMs = ob.params.time && ob.params.time.timestamp
            ? (ob.params.time.timestamp < 10000000000 ? ob.params.time.timestamp * 1000 : ob.params.time.timestamp)
            : Date.now();
        if (uid && sid) {
            repository.updateSessionMetrics(common.db, ob.params.app_id, uid, sid, ob.duration, endTsMs);
        }
    });

    plugins.register('/session/end', function (ob) {
        if (!ob || !ob.params || !common.db) {
            return;
        }
        var cfg = getPluginConfig(ob.params.app_id);
        if (cfg.store_user_events === false || cfg.track_sessions === false) {
            return;
        }
        var duration = typeof ob.duration === 'number'
            ? ob.duration
            : (ob.params.qstring && ob.params.qstring.session_duration ? Number(ob.params.qstring.session_duration) : null);
        var uid = resolveUidFromParams(ob.params);
        var sid = ob.params.app_user && ob.params.app_user.lsid ? ob.params.app_user.lsid : null;
        var endTsMs = ob.params.time && ob.params.time.timestamp
            ? (ob.params.time.timestamp < 10000000000 ? ob.params.time.timestamp * 1000 : ob.params.time.timestamp)
            : Date.now();
        if (uid && sid) {
            repository.updateSessionMetrics(common.db, ob.params.app_id, uid, sid, duration, endTsMs);
        }
        repository.ingestEvent(common.db, ob.params, {
            key: '[CLY]_session_end',
            count: 1,
            dur: duration,
            timestamp: ob.params.time && ob.params.time.timestamp ? ob.params.time.timestamp : Date.now(),
            segmentation: duration !== null && !Number.isNaN(duration) && duration > 0 ? { duration: duration } : {}
        });
    });

    // =========================================================================
    // 4. READ API ENDPOINTS (/o/tt-user-insights/*)
    // =========================================================================
    plugins.register('/o/tt-user-insights', function (ob) {
        var params = ob.params;
        var paths = ob.paths || [];
        var subRoute = paths[3] || '';

        rights.validateRead(params, FEATURE_NAME, function () {
            var cleanAppId = validators.validateAppId(params.app_id);
            if (!cleanAppId) {
                common.returnMessage(params, 400, 'Invalid parameter "app_id"');
                return;
            }

            if (subRoute === 'users' || subRoute === '') {
                var parsedUsers = validators.parseUserSearchParams(params.qstring);
                if (!parsedUsers.valid) {
                    common.returnMessage(params, 400, parsedUsers.error);
                    return;
                }

                repository.searchUsers(common.db, cleanAppId, parsedUsers.filters, parsedUsers.pagination, function (err, result) {
                    if (err) {
                        log.e('Error searching users in tt-user-insights:', err);
                        common.returnMessage(params, 500, 'Error searching users');
                        return;
                    }
                    common.returnOutput(params, result);
                });
            } else if (subRoute === 'details' || (subRoute === 'users' && paths[4] === 'details')) {
                var qstring = params.qstring || {};
                if ((qstring.uid !== undefined && typeof qstring.uid === 'object') ||
                    (qstring.device_id !== undefined && typeof qstring.device_id === 'object') ||
                    (qstring.did !== undefined && typeof qstring.did === 'object')) {
                    common.returnMessage(params, 400, 'Invalid user identifier parameter');
                    return;
                }

                var uid = validators.sanitizeScalarString(qstring.uid, { maxLength: 128, disallowDollarPrefix: true });
                var deviceId = validators.sanitizeScalarString(
                    qstring.device_id !== undefined ? qstring.device_id : qstring.did,
                    { maxLength: 128, disallowDollarPrefix: true }
                );

                if (!uid && !deviceId) {
                    common.returnMessage(params, 400, 'Missing required parameter "uid" or "device_id"');
                    return;
                }

                repository.getUserOverview(common.db, cleanAppId, { uid: uid, deviceId: deviceId }, function (err, overview) {
                    if (err) {
                        log.e('Error fetching user details in tt-user-insights:', err);
                        common.returnMessage(params, 500, 'Error fetching user details');
                        return;
                    }
                    if (!overview) {
                        common.returnMessage(params, 404, 'User not found');
                        return;
                    }
                    common.returnOutput(params, { user: overview });
                });
            } else if (subRoute === 'timeline') {
                var parsedTimeline = validators.parseTimelineParams(params.qstring);
                if (!parsedTimeline.valid) {
                    common.returnMessage(params, 400, parsedTimeline.error);
                    return;
                }

                repository.getUserTimeline(common.db, cleanAppId, parsedTimeline.filters, parsedTimeline.pagination, function (err, result) {
                    if (err) {
                        log.e('Error fetching user timeline in tt-user-insights:', err);
                        common.returnMessage(params, 500, 'Error fetching user timeline');
                        return;
                    }
                    common.returnOutput(params, result);
                });
            } else if (subRoute === 'live') {
                var parsedLive = validators.parseLiveStreamParams(params.qstring);
                if (!parsedLive.valid) {
                    common.returnMessage(params, 400, parsedLive.error);
                    return;
                }

                repository.getLiveEventsStream(common.db, cleanAppId, parsedLive.filters, parsedLive.pagination, function (err, result) {
                    if (err) {
                        log.e('Error fetching live events stream in tt-user-insights:', err);
                        common.returnMessage(params, 500, 'Error fetching live events stream');
                        return;
                    }
                    common.returnOutput(params, result);
                });
            } else if (subRoute === 'breadcrumbs') {
                var parsedBreadcrumbs = validators.parseBreadcrumbsParams(params.qstring);
                if (!parsedBreadcrumbs.valid) {
                    common.returnMessage(params, 400, parsedBreadcrumbs.error);
                    return;
                }

                repository.getEventBreadcrumbs(common.db, cleanAppId, parsedBreadcrumbs.params, function (err, result) {
                    if (err) {
                        log.e('Error fetching event breadcrumbs in tt-user-insights:', err);
                        common.returnMessage(params, 500, 'Error fetching event breadcrumbs');
                        return;
                    }
                    common.returnOutput(params, result);
                });
            } else if (subRoute === 'definitions') {
                common.returnOutput(params, {
                    categories: eventRegistryModule.registry.getCategories(),
                    definitions: eventRegistryModule.registry.getAllDefinitions()
                });
            } else {
                common.returnMessage(params, 400, 'Invalid path');
            }
        });

        return true;
    });

    // Expose public extension API so other TT Analytics plugins can register business events or custom renderers
    plugin.FEATURE_NAME = FEATURE_NAME;
    plugin.registry = eventRegistryModule.registry;
    plugin.renderer = businessEventRendererModule.renderer;
    plugin.registerEventDefinition = function (def) {
        return eventRegistryModule.registry.registerEventDefinition(def);
    };
    plugin.registerEventDefinitions = function (defs) {
        return eventRegistryModule.registry.registerEventDefinitions(defs);
    };
    plugin.registerEventRenderer = function (eventKey, rendererFn) {
        return eventRegistryModule.registry.registerEventRenderer(eventKey, rendererFn);
    };
    plugin.registerCategory = function (cat) {
        return eventRegistryModule.registry.registerCategory(cat);
    };
})(module.exports);
