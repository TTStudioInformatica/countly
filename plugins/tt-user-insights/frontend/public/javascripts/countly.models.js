'use strict';

/* global countlyCommon, jQuery */

/**
 * Frontend Data Model & Vuex Store for tt-user-insights.
 *
 * Uses exclusively real Countly frontend globals:
 * - `countlyCommon.READ_API_URL` (`"/o"`)
 * - `countlyCommon.ACTIVE_APP_ID`
 * - `jQuery.ajax`
 * - `jQuery.i18n.map` (Countly localization dictionary)
 */
(function(countlyTTUserInsights, $) {
    var API_BASE = (typeof countlyCommon !== 'undefined' && countlyCommon.READ_API_URL ? countlyCommon.READ_API_URL : '/o') + '/tt-user-insights';

    /**
     * Resolves a localization key using Countly's `jQuery.i18n.map` with optional `{param}` interpolation.
     * Never hardcodes language strings in JS logic.
     * @param {string} key
     * @param {Object} [params]
     * @param {string} [fallback]
     * @returns {string}
     */
    function translateTemplate(key, params, fallback) {
        var i18nMap = ($ && $.i18n && $.i18n.map) ? $.i18n.map : {};
        var rawTemplate = (key && i18nMap[key]) ? i18nMap[key] : (fallback || key || '');

        if (!params || typeof params !== 'object') {
            return rawTemplate;
        }

        // Replace `{prop}` placeholders with actual values from `params`
        var interpolated = rawTemplate.replace(/\{([a-zA-Z0-9_]+)\}/g, function(_, token) {
            if (Object.prototype.hasOwnProperty.call(params, token) &&
                params[token] !== undefined &&
                params[token] !== null &&
                params[token] !== '') {
                return String(params[token]);
            }
            return '';
        });

        // Clean up empty separator artifacts when optional parameters are absent (e.g. " - " at the end or empty parens)
        interpolated = interpolated
            .replace(/\(\s*\)/g, '')
            .replace(/€\s*$/g, '')
            .replace(/SKU:\s*$/g, '')
            .replace(/quantità:\s*$/gi, '')
            .replace(/Qty:\s*$/gi, '')
            .replace(/\s+-\s*$/g, '')
            .replace(/^\s*-\s+/g, '')
            .replace(/\s+•\s*$/g, '')
            .replace(/^\s*•\s+/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();

        return interpolated || fallback || '';
    }

    /**
     * Enriches a server-rendered timeline item with localized `title`, `description`, `details`,
     * and `categoryLabel` from `jQuery.i18n.map`.
     * @param {Object} item
     * @returns {Object}
     */
    function localizeTimelineItem(item) {
        if (!item || typeof item !== 'object') {
            return item;
        }

        var title = translateTemplate(item.titleKey, item.descriptionParams, item.titleFallback || item.eventKey);
        var description = translateTemplate(item.descriptionKey, item.descriptionParams, item.descriptionFallback || '');
        var details = translateTemplate(item.detailsKey, item.descriptionParams, item.detailsFallback || '');

        if (!description || description === item.descriptionKey) {
            description = item.descriptionFallback || '';
        }
        if (!details || details === item.detailsKey) {
            details = item.detailsFallback || '';
        }

        // For `[CLY]_view`, if the screen name is present, use the screen name directly as title
        if (item.eventKey === '[CLY]_view' && item.descriptionParams && item.descriptionParams.name) {
            title = item.descriptionParams.name;
            if (description === item.descriptionParams.name) {
                description = '';
            }
        }

        var categoryLabel = translateTemplate(item.categoryLabelKey, null, item.category);
        var localizedSummaries = (item.summaryItems || []).map(function(s) {
            return Object.assign({}, s, {
                label: translateTemplate(s.labelKey, null, s.labelFallback || s.key)
            });
        });

        return Object.assign({}, item, {
            title: title,
            description: description,
            details: details,
            categoryLabel: categoryLabel,
            summaryItems: localizedSummaries
        });
    }

    /**
     * Groups localized timeline items into visual Session blocks when a reliable `session.sessionId` is present.
     * Never invents sessions when `session` is null.
     * @param {Array<Object>} items
     * @returns {Array<Object>}
     */
    function groupTimelineBySession(items) {
        if (!Array.isArray(items) || !items.length) {
            return [];
        }
        var groups = [];
        var currentGroup = null;

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var sid = (item.session && item.session.sessionId) ? item.session.sessionId : null;

            if (!currentGroup || currentGroup.sessionId !== sid) {
                currentGroup = {
                    groupKey: sid ? ('session_' + sid + '_' + groups.length) : ('ungrouped_' + groups.length),
                    sessionId: sid,
                    isReliableSession: Boolean(sid),
                    startTs: (item.session && item.session.startTs) ? item.session.startTs : item.timestamp,
                    endTs: (item.session && item.session.endTs) ? item.session.endTs : item.timestamp,
                    duration: (item.session && item.session.duration) ? item.session.duration : null,
                    durationFormatted: (item.session && item.session.durationFormatted) ? item.session.durationFormatted : null,
                    events: []
                };
                groups.push(currentGroup);
            }

            currentGroup.events.push(item);

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

    countlyTTUserInsights.translateTemplate = translateTemplate;
    countlyTTUserInsights.localizeTimelineItem = localizeTimelineItem;
    countlyTTUserInsights.groupTimelineBySession = groupTimelineBySession;

    /**
     * Vuex store constructor used by `countlyVue.views.BackboneWrapper`.
     */
    countlyTTUserInsights.vuex = function() {
        return {
            state: function() {
                return {
                    // Top-level Navigation Mode: 'users' (User Inspector & Timeline) | 'live' (Real-Time Live Stream)
                    activeMainTab: 'users',

                    // User Search state
                    users: [],
                    usersTotal: 0,
                    usersLoading: false,
                    usersError: null,
                    userSearchFilter: {
                        q: '',
                        uid: '',
                        device_id: '',
                        email: '',
                        name: '',
                        custom_key: '',
                        custom_value: '',
                        skip: 0,
                        limit: 20
                    },

                    // Selected User Overview state
                    selectedUser: null,
                    userDetailsLoading: false,
                    userDetailsError: null,

                    // User Activity Timeline state
                    timeline: [],
                    sessionGroups: [],
                    timelineTotal: 0,
                    timelineHasMore: false,
                    timelineLoading: false,
                    timelineError: null,
                    timelineFilter: {
                        from: null,
                        to: null,
                        category: '',
                        event_type: '',
                        event_key: '',
                        searches_only: false,
                        q: '',
                        skip: 0,
                        limit: 25
                    },

                    // Real-Time Live Events Stream state (Priority 1 - PostHog inspired)
                    liveStream: [],
                    liveStreamTotal: 0,
                    liveStreamLoading: false,
                    liveStreamError: null,
                    liveStreamPaused: false,
                    liveLatestTimestamp: 0,
                    liveFilter: {
                        category: '',
                        event_type: '',
                        event_key: '',
                        errors_only: false,
                        searches_only: false,
                        q: '',
                        limit: 40
                    },

                    // Definitions & Categories metadata
                    categories: [],
                    definitions: [],

                    // Active Event Details Drawer & Error Breadcrumbs state
                    selectedEvent: null,
                    activeDetailsTab: 'business', // 'business' | 'breadcrumbs' | 'raw'
                    breadcrumbs: [],
                    breadcrumbsLoading: false
                };
            },

            mutations: {
                SET_ACTIVE_MAIN_TAB: function(state, tab) {
                    state.activeMainTab = tab === 'live' ? 'live' : 'users';
                },
                SET_USERS_LOADING: function(state, flag) {
                    state.usersLoading = Boolean(flag);
                },
                SET_USERS_ERROR: function(state, err) {
                    state.usersError = err || null;
                },
                SET_USERS_DATA: function(state, payload) {
                    state.users = (payload && Array.isArray(payload.users)) ? payload.users : [];
                    state.usersTotal = (payload && payload.pagination && typeof payload.pagination.total === 'number')
                        ? payload.pagination.total
                        : state.users.length;
                },
                SET_USER_SEARCH_FILTER: function(state, partial) {
                    state.userSearchFilter = Object.assign({}, state.userSearchFilter, partial || {});
                },
                SET_SELECTED_USER: function(state, user) {
                    state.selectedUser = user || null;
                },
                SET_USER_DETAILS_LOADING: function(state, flag) {
                    state.userDetailsLoading = Boolean(flag);
                },
                SET_USER_DETAILS_ERROR: function(state, err) {
                    state.userDetailsError = err || null;
                },
                SET_TIMELINE_LOADING: function(state, flag) {
                    state.timelineLoading = Boolean(flag);
                },
                SET_TIMELINE_ERROR: function(state, err) {
                    state.timelineError = err || null;
                },
                SET_TIMELINE_DATA: function(state, payload) {
                    var rawItems = (payload && Array.isArray(payload.timeline)) ? payload.timeline : [];
                    var localized = rawItems.map(localizeTimelineItem);
                    if (payload && payload.append) {
                        state.timeline = state.timeline.concat(localized);
                    } else {
                        state.timeline = localized;
                    }
                    state.sessionGroups = groupTimelineBySession(state.timeline);
                    state.timelineTotal = (payload && payload.pagination && typeof payload.pagination.total === 'number')
                        ? payload.pagination.total
                        : state.timeline.length;
                    state.timelineHasMore = Boolean(payload && payload.pagination && payload.pagination.hasMore);
                },
                SET_TIMELINE_FILTER: function(state, partial) {
                    state.timelineFilter = Object.assign({}, state.timelineFilter, partial || {});
                },
                SET_LIVE_STREAM_LOADING: function(state, flag) {
                    state.liveStreamLoading = Boolean(flag);
                },
                SET_LIVE_STREAM_ERROR: function(state, err) {
                    state.liveStreamError = err || null;
                },
                SET_LIVE_STREAM_PAUSED: function(state, flag) {
                    state.liveStreamPaused = Boolean(flag);
                },
                SET_LIVE_FILTER: function(state, partial) {
                    state.liveFilter = Object.assign({}, state.liveFilter, partial || {});
                },
                SET_LIVE_STREAM_DATA: function(state, payload) {
                    var rawItems = (payload && Array.isArray(payload.events)) ? payload.events : [];
                    var localized = rawItems.map(localizeTimelineItem);

                    if (payload && payload.prependNew) {
                        if (localized.length > 0) {
                            var existingIds = {};
                            state.liveStream.forEach(function(item) {
                                existingIds[item.id] = true;
                            });
                            var brandNew = localized.filter(function(item) {
                                return !existingIds[item.id];
                            });
                            if (brandNew.length > 0) {
                                state.liveStream = brandNew.concat(state.liveStream).slice(0, 150);
                                state.liveStreamTotal += brandNew.length;
                            }
                        }
                    } else {
                        state.liveStream = localized;
                        state.liveStreamTotal = (payload && payload.pagination && typeof payload.pagination.total === 'number')
                            ? payload.pagination.total
                            : localized.length;
                    }

                    if (payload && typeof payload.latestTimestamp === 'number' && payload.latestTimestamp > state.liveLatestTimestamp) {
                        state.liveLatestTimestamp = payload.latestTimestamp;
                    } else if (!payload || !payload.prependNew) {
                        state.liveLatestTimestamp = state.liveStream.length > 0 ? state.liveStream[0].timestamp : 0;
                    }
                },
                SET_DEFINITIONS: function(state, payload) {
                    state.categories = (payload && Array.isArray(payload.categories)) ? payload.categories : [];
                    state.definitions = (payload && Array.isArray(payload.definitions)) ? payload.definitions : [];
                },
                SET_SELECTED_EVENT: function(state, ev) {
                    state.selectedEvent = ev || null;
                    state.breadcrumbs = [];
                    if (ev) {
                        // Automatically open Breadcrumbs tab if the user clicked an error/crash event, otherwise Business tab
                        state.activeDetailsTab = 'business';
                    }
                },
                SET_ACTIVE_DETAILS_TAB: function(state, tab) {
                    if (tab === 'raw' || tab === 'breadcrumbs') {
                        state.activeDetailsTab = tab;
                    } else {
                        state.activeDetailsTab = 'business';
                    }
                },
                SET_BREADCRUMBS_LOADING: function(state, flag) {
                    state.breadcrumbsLoading = Boolean(flag);
                },
                SET_BREADCRUMBS_DATA: function(state, items) {
                    var rawList = Array.isArray(items) ? items : [];
                    state.breadcrumbs = rawList.map(localizeTimelineItem);
                }
            },

            actions: {
                /**
                 * Loads registered business event definitions and categories for filter dropdowns.
                 */
                fetchDefinitions: function(context) {
                    var appId = countlyCommon.ACTIVE_APP_ID;
                    if (!appId) {
                        return Promise.resolve();
                    }
                    return new Promise(function(resolve) {
                        $.ajax({
                            type: 'GET',
                            url: API_BASE + '/definitions',
                            dataType: 'json',
                            data: { app_id: appId },
                            success: function(res) {
                                context.commit('SET_DEFINITIONS', res);
                                resolve(res);
                            },
                            error: function() {
                                resolve(null);
                            }
                        });
                    });
                },

                /**
                 * Searches users within the currently active Countly application.
                 */
                searchUsers: function(context, filterOverrides) {
                    var appId = countlyCommon.ACTIVE_APP_ID;
                    if (!appId) {
                        return Promise.resolve();
                    }
                    if (filterOverrides) {
                        context.commit('SET_USER_SEARCH_FILTER', filterOverrides);
                    }

                    var f = context.state.userSearchFilter;
                    var requestData = {
                        app_id: appId,
                        skip: f.skip || 0,
                        limit: f.limit || 20
                    };

                    if (f.q) { requestData.q = f.q; }
                    if (f.uid) { requestData.uid = f.uid; }
                    if (f.device_id) { requestData.device_id = f.device_id; }
                    if (f.email) { requestData.email = f.email; }
                    if (f.name) { requestData.name = f.name; }
                    if (f.custom_key) { requestData.custom_key = f.custom_key; }
                    if (f.custom_value) { requestData.custom_value = f.custom_value; }

                    context.commit('SET_USERS_LOADING', true);
                    context.commit('SET_USERS_ERROR', null);

                    return new Promise(function(resolve) {
                        $.ajax({
                            type: 'GET',
                            url: API_BASE + '/users',
                            dataType: 'json',
                            data: requestData,
                            success: function(res) {
                                context.commit('SET_USERS_LOADING', false);
                                context.commit('SET_USERS_DATA', res);
                                resolve(res);
                            },
                            error: function(xhr) {
                                context.commit('SET_USERS_LOADING', false);
                                var msg = (xhr && xhr.responseJSON && xhr.responseJSON.result)
                                    ? xhr.responseJSON.result
                                    : 'Error loading users';
                                context.commit('SET_USERS_ERROR', msg);
                                resolve(null);
                            }
                        });
                    });
                },

                /**
                 * Selects a user and loads both their User Overview and Activity Timeline.
                 */
                selectUser: function(context, userOrIdentifier) {
                    var appId = countlyCommon.ACTIVE_APP_ID;
                    if (!appId || !userOrIdentifier) {
                        return Promise.resolve();
                    }

                    var uid = typeof userOrIdentifier === 'string'
                        ? userOrIdentifier
                        : (userOrIdentifier.uid || null);
                    var deviceId = typeof userOrIdentifier === 'object'
                        ? (userOrIdentifier.deviceId || userOrIdentifier.did || null)
                        : null;

                    if (typeof userOrIdentifier === 'object' && (userOrIdentifier.uid || userOrIdentifier.deviceId)) {
                        context.commit('SET_SELECTED_USER', userOrIdentifier);
                    }

                    context.commit('SET_SELECTED_EVENT', null);
                    context.commit('SET_TIMELINE_FILTER', { skip: 0 });
                    context.commit('SET_USER_DETAILS_LOADING', true);
                    context.commit('SET_USER_DETAILS_ERROR', null);

                    var detailParams = { app_id: appId };
                    if (uid) { detailParams.uid = uid; }
                    if (deviceId) { detailParams.device_id = deviceId; }

                    return new Promise(function(resolve) {
                        $.ajax({
                            type: 'GET',
                            url: API_BASE + '/details',
                            dataType: 'json',
                            data: detailParams,
                            success: function(res) {
                                context.commit('SET_USER_DETAILS_LOADING', false);
                                if (res && res.user) {
                                    context.commit('SET_SELECTED_USER', res.user);
                                }
                                context.dispatch('fetchTimeline', { append: false }).then(resolve);
                            },
                            error: function(xhr) {
                                context.commit('SET_USER_DETAILS_LOADING', false);
                                var msg = (xhr && xhr.responseJSON && xhr.responseJSON.result)
                                    ? xhr.responseJSON.result
                                    : 'User not found';
                                context.commit('SET_USER_DETAILS_ERROR', msg);
                                resolve(null);
                            }
                        });
                    });
                },

                /**
                 * Loads the activity timeline for the currently selected user.
                 */
                fetchTimeline: function(context, options) {
                    var opts = options || {};
                    var appId = countlyCommon.ACTIVE_APP_ID;
                    var user = context.state.selectedUser;
                    if (!appId || !user || (!user.uid && !user.deviceId)) {
                        return Promise.resolve();
                    }

                    if (opts.filter) {
                        context.commit('SET_TIMELINE_FILTER', opts.filter);
                    }

                    var tf = context.state.timelineFilter;
                    var reqData = {
                        app_id: appId,
                        skip: tf.skip || 0,
                        limit: tf.limit || 25
                    };
                    if (user.uid) { reqData.uid = user.uid; }
                    if (user.deviceId) { reqData.device_id = user.deviceId; }
                    if (tf.from) { reqData.from = tf.from; }
                    if (tf.to) { reqData.to = tf.to; }
                    if (tf.category) { reqData.category = tf.category; }
                    if (tf.event_type) { reqData.event_type = tf.event_type; }
                    if (tf.event_key) { reqData.event_key = tf.event_key; }
                    if (tf.searches_only) { reqData.searches_only = 'true'; }
                    if (tf.q) { reqData.q = tf.q; }

                    if (!opts.silent) {
                        context.commit('SET_TIMELINE_LOADING', true);
                    }
                    context.commit('SET_TIMELINE_ERROR', null);

                    return new Promise(function(resolve) {
                        $.ajax({
                            type: 'GET',
                            url: API_BASE + '/timeline',
                            dataType: 'json',
                            data: reqData,
                            success: function(res) {
                                context.commit('SET_TIMELINE_LOADING', false);
                                if (res && res.user && !context.state.selectedUser) {
                                    context.commit('SET_SELECTED_USER', res.user);
                                }
                                context.commit('SET_TIMELINE_DATA', {
                                    timeline: res ? res.timeline : [],
                                    pagination: res ? res.pagination : null,
                                    append: Boolean(opts.append)
                                });
                                resolve(res);
                            },
                            error: function(xhr) {
                                context.commit('SET_TIMELINE_LOADING', false);
                                var msg = (xhr && xhr.responseJSON && xhr.responseJSON.result)
                                    ? xhr.responseJSON.result
                                    : 'Error loading activity timeline';
                                context.commit('SET_TIMELINE_ERROR', msg);
                                resolve(null);
                            }
                        });
                    });
                },

                /**
                 * Loads the real-time Live Events Stream across the application (`/o/tt-user-insights/live`).
                 * Supports both initial full load and incremental polling (`opts.incremental === true`).
                 */
                fetchLiveStream: function(context, options) {
                    var opts = options || {};
                    var appId = countlyCommon.ACTIVE_APP_ID;
                    if (!appId) {
                        return Promise.resolve();
                    }

                    if (opts.filter) {
                        context.commit('SET_LIVE_FILTER', opts.filter);
                    }

                    var lf = context.state.liveFilter;
                    var reqData = {
                        app_id: appId,
                        limit: lf.limit || 40
                    };
                    if (lf.category) { reqData.category = lf.category; }
                    if (lf.event_type) { reqData.event_type = lf.event_type; }
                    if (lf.event_key) { reqData.event_key = lf.event_key; }
                    if (lf.errors_only) { reqData.errors_only = 'true'; }
                    if (lf.searches_only) { reqData.searches_only = 'true'; }
                    if (lf.q) { reqData.q = lf.q; }

                    var isIncremental = Boolean(opts.incremental && context.state.liveLatestTimestamp > 0);
                    if (isIncremental) {
                        reqData.since_ts = context.state.liveLatestTimestamp;
                    } else {
                        context.commit('SET_LIVE_STREAM_LOADING', true);
                    }
                    context.commit('SET_LIVE_STREAM_ERROR', null);

                    return new Promise(function(resolve) {
                        $.ajax({
                            type: 'GET',
                            url: API_BASE + '/live',
                            dataType: 'json',
                            data: reqData,
                            success: function(res) {
                                context.commit('SET_LIVE_STREAM_LOADING', false);
                                context.commit('SET_LIVE_STREAM_DATA', {
                                    events: res ? res.events : [],
                                    latestTimestamp: res ? res.latestTimestamp : 0,
                                    pagination: res ? res.pagination : null,
                                    prependNew: isIncremental
                                });
                                resolve(res);
                            },
                            error: function(xhr) {
                                context.commit('SET_LIVE_STREAM_LOADING', false);
                                var msg = (xhr && xhr.responseJSON && xhr.responseJSON.result)
                                    ? xhr.responseJSON.result
                                    : 'Error loading live events stream';
                                context.commit('SET_LIVE_STREAM_ERROR', msg);
                                resolve(null);
                            }
                        });
                    });
                },

                /**
                 * Loads the preceding Breadcrumb trail for a selected event (`/o/tt-user-insights/breadcrumbs`).
                 */
                fetchBreadcrumbs: function(context, targetEvent) {
                    var appId = countlyCommon.ACTIVE_APP_ID;
                    var ev = targetEvent || context.state.selectedEvent;
                    if (!appId || !ev || !ev.user || (!ev.user.uid && !ev.user.deviceId)) {
                        return Promise.resolve();
                    }

                    var reqData = {
                        app_id: appId,
                        before_ts: ev.timestamp,
                        event_id: ev.id,
                        limit: 10
                    };
                    if (ev.user.uid) { reqData.uid = ev.user.uid; }
                    if (ev.user.deviceId) { reqData.device_id = ev.user.deviceId; }

                    context.commit('SET_BREADCRUMBS_LOADING', true);

                    return new Promise(function(resolve) {
                        $.ajax({
                            type: 'GET',
                            url: API_BASE + '/breadcrumbs',
                            dataType: 'json',
                            data: reqData,
                            success: function(res) {
                                context.commit('SET_BREADCRUMBS_LOADING', false);
                                context.commit('SET_BREADCRUMBS_DATA', res && Array.isArray(res.breadcrumbs) ? res.breadcrumbs : []);
                                resolve(res);
                            },
                            error: function() {
                                context.commit('SET_BREADCRUMBS_LOADING', false);
                                context.commit('SET_BREADCRUMBS_DATA', []);
                                resolve(null);
                            }
                        });
                    });
                }
            }
        };
    };
})((window.countlyTTUserInsights = window.countlyTTUserInsights || {}), jQuery);
