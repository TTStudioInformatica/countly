'use strict';

/* global app, countlyVue, countlyTTUserInsights, CV, Backbone */

/**
 * Frontend Views, Routing & Sidebar Integration for tt-user-insights.
 *
 * Uses strictly verified Countly 25.03.0 Vue + Backbone conventions:
 * - `countlyVue.views.create`
 * - `countlyVue.views.BackboneWrapper`
 * - `countlyVue.mixins.auth("tt_user_insights")`
 * - `countlyVue.mixins.i18n`
 * - `CV.T('/tt-user-insights/templates/main.html')`
 * - `app.addSubMenu("analytics", ...)`
 * - `app.route("/analytics/user-insights", ...)`
 */
(function() {
    var FEATURE_NAME = 'tt_user_insights';
    var LIVE_POLL_INTERVAL_MS = 3000;

    var TTUserInsightsViewComponent = countlyVue.views.create({
        template: CV.T('/tt-user-insights/templates/main.html'),
        mixins: [
            countlyVue.mixins.auth(FEATURE_NAME),
            countlyVue.mixins.i18n
        ],
        data: function() {
            return {
                // User Search inputs
                searchQuery: '',
                searchFieldMode: 'all', // 'all' | 'uid' | 'device_id' | 'email' | 'name' | 'custom'
                customPropKey: '',
                customPropValue: '',

                // Single-User Timeline filters & Live Auto-Refresh toggle
                periodPreset: 'all', // 'all' | '24h' | '7d' | '30d' | '90d'
                timelineSearchText: '',
                selectedCategory: '',
                selectedEventType: '', // '' | 'SESSION' | 'VIEW' | 'TT_BUSINESS_EVENT' | 'CUSTOM_EVENT'
                selectedEventKey: '',
                searchesOnly: false,
                userTimelineLive: false,

                // Global Live Events Stream filters (Priority 1 - PostHog inspired)
                liveCategory: '',
                liveEventType: '',
                liveEventKey: '',
                liveSearchText: '',
                liveErrorsOnly: false,
                liveSearchesOnly: false,

                // Internal polling timer reference
                pollTimerId: null
            };
        },
        computed: {
            state: function() {
                return this.$store.state.countlyTTUserInsights;
            },
            activeMainTab: function() {
                return this.state.activeMainTab || 'users';
            },
            users: function() {
                return this.state.users || [];
            },
            usersTotal: function() {
                return this.state.usersTotal || 0;
            },
            usersLoading: function() {
                return this.state.usersLoading;
            },
            usersError: function() {
                return this.state.usersError;
            },
            selectedUser: function() {
                return this.state.selectedUser;
            },
            userDetailsLoading: function() {
                return this.state.userDetailsLoading;
            },
            userDetailsError: function() {
                return this.state.userDetailsError;
            },
            timeline: function() {
                return this.state.timeline || [];
            },
            sessionGroups: function() {
                return this.state.sessionGroups || [];
            },
            timelineTotal: function() {
                return this.state.timelineTotal || 0;
            },
            timelineHasMore: function() {
                return this.state.timelineHasMore;
            },
            timelineLoading: function() {
                return this.state.timelineLoading;
            },
            timelineError: function() {
                return this.state.timelineError;
            },
            liveStream: function() {
                return this.state.liveStream || [];
            },
            liveStreamTotal: function() {
                return this.state.liveStreamTotal || 0;
            },
            liveStreamLoading: function() {
                return this.state.liveStreamLoading;
            },
            liveStreamError: function() {
                return this.state.liveStreamError;
            },
            liveStreamPaused: function() {
                return Boolean(this.state.liveStreamPaused);
            },
            breadcrumbs: function() {
                return this.state.breadcrumbs || [];
            },
            breadcrumbsLoading: function() {
                return Boolean(this.state.breadcrumbsLoading);
            },
            categories: function() {
                var self = this;
                return (this.state.categories || []).map(function(cat) {
                    return {
                        key: cat.key,
                        icon: cat.icon,
                        label: self.i18n(cat.labelKey) !== cat.labelKey ? self.i18n(cat.labelKey) : cat.key
                    };
                });
            },
            definitions: function() {
                var self = this;
                return (this.state.definitions || []).map(function(def) {
                    return {
                        key: def.key,
                        category: def.category,
                        label: self.i18n(def.titleKey) !== def.titleKey ? (self.i18n(def.titleKey) + ' (' + def.key + ')') : def.key
                    };
                });
            },
            selectedEvent: function() {
                return this.state.selectedEvent;
            },
            activeDetailsTab: function() {
                return this.state.activeDetailsTab || 'business';
            },
            hasCustomProperties: function() {
                return Boolean(
                    this.selectedUser &&
                    this.selectedUser.customProperties &&
                    Object.keys(this.selectedUser.customProperties).length > 0
                );
            },
            formattedRawEventJson: function() {
                if (!this.selectedEvent || !this.selectedEvent.raw) {
                    return '';
                }
                try {
                    return JSON.stringify(this.selectedEvent.raw, null, 2);
                } catch (e) {
                    return String(this.selectedEvent.raw);
                }
            },
            hasEventSegments: function() {
                return Boolean(
                    this.selectedEvent &&
                    this.selectedEvent.eventData &&
                    this.selectedEvent.eventData.segments &&
                    Object.keys(this.selectedEvent.eventData.segments).length > 0
                );
            }
        },
        methods: {
            /**
             * Formats a millisecond timestamp as HH:mm, HH:mm:ss, DD/MM/YYYY, and full date/time string.
             */
            formatTimeShort: function(ts) {
                if (!ts) {
                    return '';
                }
                var d = new Date(Number(ts));
                if (Number.isNaN(d.getTime())) {
                    return '';
                }
                var hh = String(d.getHours()).padStart(2, '0');
                var mm = String(d.getMinutes()).padStart(2, '0');
                return hh + ':' + mm;
            },
            formatTimeWithSeconds: function(ts) {
                if (!ts) {
                    return '';
                }
                var d = new Date(Number(ts));
                if (Number.isNaN(d.getTime())) {
                    return '';
                }
                var hh = String(d.getHours()).padStart(2, '0');
                var mm = String(d.getMinutes()).padStart(2, '0');
                var ss = String(d.getSeconds()).padStart(2, '0');
                return hh + ':' + mm + ':' + ss;
            },
            formatSessionDate: function(ts) {
                if (!ts) {
                    return '';
                }
                var d = new Date(Number(ts));
                if (Number.isNaN(d.getTime())) {
                    return '';
                }
                var yyyy = d.getFullYear();
                var mo = String(d.getMonth() + 1).padStart(2, '0');
                var dd = String(d.getDate()).padStart(2, '0');
                return dd + '/' + mo + '/' + yyyy;
            },
            formatDateTimeFull: function(ts) {
                if (!ts) {
                    return '';
                }
                var d = new Date(Number(ts));
                if (Number.isNaN(d.getTime())) {
                    return '';
                }
                var yyyy = d.getFullYear();
                var mo = String(d.getMonth() + 1).padStart(2, '0');
                var dd = String(d.getDate()).padStart(2, '0');
                var hh = String(d.getHours()).padStart(2, '0');
                var mm = String(d.getMinutes()).padStart(2, '0');
                var ss = String(d.getSeconds()).padStart(2, '0');
                return dd + '/' + mo + '/' + yyyy + ' ' + hh + ':' + mm + ':' + ss;
            },

            /**
             * Manages the background 3-second polling interval for Live Stream or User Live Timeline.
             */
            startPollingTimerIfNeeded: function() {
                var self = this;
                this.stopPollingTimer();

                var shouldPollLiveStream = (this.activeMainTab === 'live' && !this.liveStreamPaused);
                var shouldPollUserTimeline = (this.activeMainTab === 'users' && this.userTimelineLive && this.selectedUser);

                if (!shouldPollLiveStream && !shouldPollUserTimeline) {
                    return;
                }

                this.pollTimerId = setInterval(function() {
                    if (self.activeMainTab === 'live' && !self.liveStreamPaused) {
                        self.$store.dispatch('countlyTTUserInsights/fetchLiveStream', { incremental: true });
                    } else if (self.activeMainTab === 'users' && self.userTimelineLive && self.selectedUser) {
                        self.$store.dispatch('countlyTTUserInsights/fetchTimeline', {
                            append: false,
                            silent: true,
                            filter: { skip: 0 }
                        });
                    }
                }, LIVE_POLL_INTERVAL_MS);
            },
            stopPollingTimer: function() {
                if (this.pollTimerId) {
                    clearInterval(this.pollTimerId);
                    this.pollTimerId = null;
                }
            },

            /**
             * Switches between "User Inspector & Timeline" ('users') and "Live Events Stream" ('live').
             */
            onSwitchMainTab: function(tab) {
                var target = tab === 'live' ? 'live' : 'users';
                this.$store.commit('countlyTTUserInsights/SET_ACTIVE_MAIN_TAB', target);
                if (target === 'live') {
                    this.$store.dispatch('countlyTTUserInsights/fetchLiveStream', { incremental: false });
                }
                this.startPollingTimerIfNeeded();
            },

            /**
             * Toggles live auto-refresh on the single-user timeline.
             */
            onToggleUserTimelineLive: function() {
                this.userTimelineLive = !this.userTimelineLive;
                if (this.userTimelineLive && this.selectedUser) {
                    this.$store.dispatch('countlyTTUserInsights/fetchTimeline', {
                        append: false,
                        silent: true,
                        filter: { skip: 0 }
                    });
                }
                this.startPollingTimerIfNeeded();
            },

            /**
             * Toggles Pause / Resume on the Global Live Events Stream.
             */
            onToggleLiveStreamPause: function() {
                var nextPaused = !this.liveStreamPaused;
                this.$store.commit('countlyTTUserInsights/SET_LIVE_STREAM_PAUSED', nextPaused);
                if (!nextPaused) {
                    this.$store.dispatch('countlyTTUserInsights/fetchLiveStream', { incremental: true });
                }
                this.startPollingTimerIfNeeded();
            },

            /**
             * Applies filters on the Global Live Events Stream.
             */
            onApplyLiveFilters: function() {
                this.$store.dispatch('countlyTTUserInsights/fetchLiveStream', {
                    incremental: false,
                    filter: {
                        category: this.liveCategory || '',
                        event_type: this.liveEventType || '',
                        event_key: this.liveEventKey || '',
                        errors_only: Boolean(this.liveErrorsOnly),
                        searches_only: Boolean(this.liveSearchesOnly),
                        q: (this.liveSearchText || '').trim()
                    }
                });
            },
            onToggleLiveErrorsOnly: function() {
                this.liveErrorsOnly = !this.liveErrorsOnly;
                if (this.liveErrorsOnly) {
                    this.liveSearchesOnly = false;
                    this.liveCategory = 'error';
                } else if (this.liveCategory === 'error') {
                    this.liveCategory = '';
                }
                this.onApplyLiveFilters();
            },
            onToggleLiveSearchesOnly: function() {
                this.liveSearchesOnly = !this.liveSearchesOnly;
                if (this.liveSearchesOnly) {
                    this.liveErrorsOnly = false;
                    this.liveCategory = 'search';
                    this.liveEventKey = 'search_performed';
                } else {
                    if (this.liveCategory === 'search') {
                        this.liveCategory = '';
                    }
                    if (this.liveEventKey === 'search_performed') {
                        this.liveEventKey = '';
                    }
                }
                this.onApplyLiveFilters();
            },
            onResetLiveFilters: function() {
                this.liveCategory = '';
                this.liveEventType = '';
                this.liveEventKey = '';
                this.liveSearchText = '';
                this.liveErrorsOnly = false;
                this.liveSearchesOnly = false;
                this.onApplyLiveFilters();
            },

            /**
             * Clicking a user badge inside the Live Events Stream switches to the User Inspector tab
             * and loads that user's full profile and activity timeline.
             */
            onInspectUserFromLive: function(userObj, domEvent) {
                if (domEvent && domEvent.stopPropagation) {
                    domEvent.stopPropagation();
                }
                if (!userObj || (!userObj.uid && !userObj.deviceId)) {
                    return;
                }
                this.$store.commit('countlyTTUserInsights/SET_ACTIVE_MAIN_TAB', 'users');
                this.startPollingTimerIfNeeded();
                this.onSelectUser(userObj);
            },

            /**
             * Executes user search based on current search bar inputs.
             */
            onSearchUsers: function() {
                var filter = {
                    q: '',
                    uid: '',
                    device_id: '',
                    email: '',
                    name: '',
                    custom_key: '',
                    custom_value: '',
                    skip: 0
                };
                var term = (this.searchQuery || '').trim();
                if (this.searchFieldMode === 'uid') {
                    filter.uid = term;
                } else if (this.searchFieldMode === 'device_id') {
                    filter.device_id = term;
                } else if (this.searchFieldMode === 'email') {
                    filter.email = term;
                } else if (this.searchFieldMode === 'name') {
                    filter.name = term;
                } else if (this.searchFieldMode === 'custom') {
                    filter.custom_key = (this.customPropKey || '').trim();
                    filter.custom_value = (this.customPropValue || '').trim();
                } else {
                    filter.q = term;
                }

                this.$store.dispatch('countlyTTUserInsights/searchUsers', filter);
            },
            onResetUserSearch: function() {
                this.searchQuery = '';
                this.searchFieldMode = 'all';
                this.customPropKey = '';
                this.customPropValue = '';
                this.$store.dispatch('countlyTTUserInsights/searchUsers', {
                    q: '',
                    uid: '',
                    device_id: '',
                    email: '',
                    name: '',
                    custom_key: '',
                    custom_value: '',
                    skip: 0
                });
            },
            onSelectUser: function(user) {
                if (!user) {
                    return;
                }
                if (typeof Backbone !== 'undefined' && Backbone.history && user.uid) {
                    Backbone.history.navigate('#/analytics/user-insights/' + encodeURIComponent(user.uid), { trigger: false });
                }
                this.$store.dispatch('countlyTTUserInsights/selectUser', user);
            },
            /**
             * Toggles the quick "Searches" (`Ricerche`) filter (Fase 7).
             */
            onToggleSearchesOnly: function() {
                this.searchesOnly = !this.searchesOnly;
                if (this.searchesOnly) {
                    this.selectedCategory = 'search';
                    this.selectedEventKey = 'search_performed';
                } else {
                    if (this.selectedCategory === 'search') {
                        this.selectedCategory = '';
                    }
                    if (this.selectedEventKey === 'search_performed') {
                        this.selectedEventKey = '';
                    }
                }
                this.onApplyTimelineFilters();
            },
            /**
             * Applies timeline filters (period preset, category, event type, event key, searches_only, search text).
             */
            onApplyTimelineFilters: function() {
                var now = Date.now();
                var from = null;
                var to = null;

                if (this.periodPreset === '24h') {
                    from = now - 24 * 3600 * 1000;
                } else if (this.periodPreset === '7d') {
                    from = now - 7 * 24 * 3600 * 1000;
                } else if (this.periodPreset === '30d') {
                    from = now - 30 * 24 * 3600 * 1000;
                } else if (this.periodPreset === '90d') {
                    from = now - 90 * 24 * 3600 * 1000;
                }

                if (this.selectedEventKey && this.selectedEventKey !== 'search_performed') {
                    this.searchesOnly = false;
                }

                this.$store.dispatch('countlyTTUserInsights/fetchTimeline', {
                    append: false,
                    filter: {
                        from: from,
                        to: to,
                        category: this.selectedCategory || '',
                        event_type: this.selectedEventType || '',
                        event_key: this.selectedEventKey || '',
                        searches_only: Boolean(this.searchesOnly),
                        q: (this.timelineSearchText || '').trim(),
                        skip: 0
                    }
                });
            },
            onResetTimelineFilters: function() {
                this.periodPreset = 'all';
                this.timelineSearchText = '';
                this.selectedCategory = '';
                this.selectedEventType = '';
                this.selectedEventKey = '';
                this.searchesOnly = false;
                this.onApplyTimelineFilters();
            },
            onLoadMoreTimeline: function() {
                var currentLen = this.timeline.length;
                this.$store.dispatch('countlyTTUserInsights/fetchTimeline', {
                    append: true,
                    filter: {
                        skip: currentLen
                    }
                });
            },
            /**
             * Opens the Event Details Drawer and loads the preceding Breadcrumbs trail (`fetchBreadcrumbs`).
             */
            onOpenEventDetails: function(item) {
                this.$store.commit('countlyTTUserInsights/SET_SELECTED_EVENT', item);
                this.$store.dispatch('countlyTTUserInsights/fetchBreadcrumbs', item);
            },
            onCloseEventDetails: function() {
                this.$store.commit('countlyTTUserInsights/SET_SELECTED_EVENT', null);
            },
            onSwitchDetailsTab: function(tab) {
                this.$store.commit('countlyTTUserInsights/SET_ACTIVE_DETAILS_TAB', tab);
            },
            onPageUsers: function(direction) {
                var currentSkip = this.state.userSearchFilter.skip || 0;
                var limit = this.state.userSearchFilter.limit || 20;
                var nextSkip = direction === 'next' ? currentSkip + limit : Math.max(0, currentSkip - limit);
                this.$store.dispatch('countlyTTUserInsights/searchUsers', { skip: nextSkip });
            },
            refreshAllForActiveApp: function(initialUid) {
                var self = this;
                this.$store.commit('countlyTTUserInsights/SET_SELECTED_EVENT', null);
                this.$store.dispatch('countlyTTUserInsights/fetchDefinitions');
                this.$store.dispatch('countlyTTUserInsights/searchUsers', { skip: 0 }).then(function(res) {
                    if (initialUid) {
                        self.$store.dispatch('countlyTTUserInsights/selectUser', initialUid);
                    } else if (res && Array.isArray(res.users) && res.users.length > 0 && !self.selectedUser) {
                        self.$store.dispatch('countlyTTUserInsights/selectUser', res.users[0]);
                    }
                });
                if (this.activeMainTab === 'live') {
                    this.$store.dispatch('countlyTTUserInsights/fetchLiveStream', { incremental: false });
                }
                this.startPollingTimerIfNeeded();
            }
        },
        mounted: function() {
            var initialUid = this.$options.initialUid || null;
            this.refreshAllForActiveApp(initialUid);
        },
        beforeDestroy: function() {
            this.stopPollingTimer();
        }
    });

    var TTUserInsightsRouteView = countlyVue.views.BackboneWrapper.extend({
        initialize: function(options) {
            var uidFromRoute = options && options.params && options.params[0] ? decodeURIComponent(options.params[0]) : null;
            var ComponentWithRoute = Object.assign({}, TTUserInsightsViewComponent, {
                initialUid: uidFromRoute
            });
            countlyVue.views.BackboneWrapper.prototype.initialize.call(this, {
                component: ComponentWithRoute,
                vuex: [{ clyModel: countlyTTUserInsights, name: 'countlyTTUserInsights' }]
            });
        },
        appChanged: function() {
            this.render();
        }
    });

    app.TTUserInsightsRouteView = TTUserInsightsRouteView;

    // Register routes under Countly Analytics section
    app.route('/analytics/user-insights', 'tt-user-insights', function() {
        this.renderWhenReady(new app.TTUserInsightsRouteView());
    });

    app.route('/analytics/user-insights/*uid', 'tt-user-insights-user', function(uid) {
        this.renderWhenReady(new app.TTUserInsightsRouteView({ params: [uid] }));
    });

    // Register menu item inside Analytics sidebar
    $(document).ready(function() {
        if (app.addSubMenu) {
            app.addSubMenu('analytics', {
                code: 'analytics-tt-user-insights',
                permission: FEATURE_NAME,
                pluginName: 'tt-user-insights',
                url: '#/analytics/user-insights',
                text: 'tt-user-insights.title',
                priority: 18
            });
        }
    });
})();
