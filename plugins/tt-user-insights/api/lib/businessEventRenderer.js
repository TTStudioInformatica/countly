'use strict';

/**
 * BusinessEventRenderer Layer
 *
 * Transforms raw Countly event documents into structured, human-readable business events
 * without mutating the underlying Countly event format and without hardcoding language strings
 * or event-specific property logic.
 *
 * Conceptual pipeline:
 *   rawEvent (from MongoDB)
 *      ↓
 *   BusinessEventRenderer.render(rawEvent)
 *      ↓
 *   humanReadableEvent {
 *     id, eventKey, timestamp, createdAt,
 *     type: 'SESSION' | 'VIEW' | 'TT_BUSINESS_EVENT' | 'CUSTOM_EVENT',
 *     eventType: 'business' | 'system' | 'custom',
 *     category, categoryLabelKey, icon,
 *     titleKey, titleFallback,
 *     descriptionKey, descriptionParams, descriptionFallback,
 *     detailsKey, detailsFallback,
 *     duration, durationFormatted,
 *     session: { sessionId } | null,
 *     properties: { ... },
 *     searchAnalytics: { query, resultsCount, category, filters } | null,
 *     summaryItems: [{ key, labelKey, value, formattedValue, format, primary, detail }],
 *     eventData: { count, sum, duration, segments },
 *     user: { uid, deviceId },
 *     raw: { ... }
 *   }
 */
var eventRegistryModule = require('./eventRegistry.js');
var validators = require('./validators.js');

// Internal Countly view segmentation keys that are technical metadata rather than user-facing business properties
var INTERNAL_VIEW_META_KEYS = {
    visit: true,
    start: true,
    exit: true,
    bounce: true,
    uvc: true,
    _idv: true,
    dur: true
};

/**
 * Formats a positive duration in seconds into a human-readable string (e.g., "18 sec", "1 min 42 sec", "1 h 5 min").
 * Returns null if duration is null, undefined, <= 0, or non-numeric.
 * IMPORTANT: Never invents or simulates missing durations.
 * @param {*} secondsRaw
 * @returns {{ seconds: number|null, formatted: string|null }}
 */
function formatDurationSeconds(secondsRaw) {
    if (secondsRaw === null || secondsRaw === undefined || secondsRaw === '') {
        return { seconds: null, formatted: null };
    }
    var sec = Number(secondsRaw);
    if (Number.isNaN(sec) || !Number.isFinite(sec) || sec <= 0 || String(Math.round(sec)).length >= 10) {
        return { seconds: null, formatted: null };
    }
    var rounded = Math.round(sec);
    if (rounded <= 0) {
        return { seconds: null, formatted: null };
    }
    if (rounded < 60) {
        return { seconds: rounded, formatted: rounded + ' sec' };
    }
    var mins = Math.floor(rounded / 60);
    var remSec = rounded % 60;
    if (mins < 60) {
        return {
            seconds: rounded,
            formatted: remSec > 0 ? (mins + ' min ' + remSec + ' sec') : (mins + ' min')
        };
    }
    var hours = Math.floor(mins / 60);
    var remMins = mins % 60;
    return {
        seconds: rounded,
        formatted: remMins > 0 ? (hours + ' h ' + remMins + ' min') : (hours + ' h')
    };
}

/**
 * Safely converts a raw value to a displayable scalar value according to its field format.
 * Never throws on malformed input.
 * @param {*} rawValue
 * @param {string} format - 'string' | 'number' | 'currency' | 'integer' | 'boolean'
 * @returns {{ value: *, formattedValue: string }}
 */
function formatPropertyValue(rawValue, format) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return { value: null, formattedValue: '' };
    }

    if (format === 'currency') {
        var numCurrency = Number(rawValue);
        if (!Number.isNaN(numCurrency) && Number.isFinite(numCurrency)) {
            return {
                value: numCurrency,
                formattedValue: numCurrency.toFixed(2)
            };
        }
    }

    if (format === 'integer') {
        var numInt = parseInt(rawValue, 10);
        if (!Number.isNaN(numInt) && Number.isFinite(numInt)) {
            return {
                value: numInt,
                formattedValue: String(numInt)
            };
        }
    }

    if (format === 'number') {
        var numVal = Number(rawValue);
        if (!Number.isNaN(numVal) && Number.isFinite(numVal)) {
            return {
                value: numVal,
                formattedValue: String(numVal)
            };
        }
    }

    if (typeof rawValue === 'object') {
        try {
            var jsonStr = JSON.stringify(rawValue);
            return { value: jsonStr, formattedValue: jsonStr };
        } catch (e) {
            return { value: String(rawValue), formattedValue: String(rawValue) };
        }
    }

    var strVal = String(rawValue);
    return {
        value: rawValue,
        formattedValue: strVal
    };
}

/**
 * Extracts a property from segments (`sg`) checking both the primary `prop` name and any configured `aliases`.
 * @param {Object} segments
 * @param {Object} fieldDef
 * @returns {{ matchedProp: string|null, rawValue: * }}
 */
function extractFieldFromSegments(segments, fieldDef) {
    if (!segments || typeof segments !== 'object') {
        return { matchedProp: null, rawValue: undefined };
    }

    if (Object.prototype.hasOwnProperty.call(segments, fieldDef.prop) &&
        segments[fieldDef.prop] !== undefined &&
        segments[fieldDef.prop] !== null &&
        segments[fieldDef.prop] !== '') {
        return { matchedProp: fieldDef.prop, rawValue: segments[fieldDef.prop] };
    }

    if (Array.isArray(fieldDef.aliases)) {
        for (var i = 0; i < fieldDef.aliases.length; i++) {
            var alias = fieldDef.aliases[i];
            if (Object.prototype.hasOwnProperty.call(segments, alias) &&
                segments[alias] !== undefined &&
                segments[alias] !== null &&
                segments[alias] !== '') {
                return { matchedProp: alias, rawValue: segments[alias] };
            }
        }
    }

    return { matchedProp: null, rawValue: undefined };
}

/**
 * Converts a snake_case or camelCase identifier into a readable label fallback
 * when no localization dictionary is loaded (e.g., for arbitrary custom events).
 * @param {string} key
 * @returns {string}
 */
function humanizeKeyFallback(key) {
    if (!key || typeof key !== 'string') {
        return '';
    }
    var cleaned = key.replace(/^\[CLY\]_/, '').replace(/[_-]+/g, ' ').trim();
    if (!cleaned) {
        return key;
    }
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * BusinessEventRenderer class
 * @param {EventRegistry} [customRegistry] - Optional custom registry instance
 */
function BusinessEventRenderer(customRegistry) {
    this.registry = customRegistry || eventRegistryModule.registry;
}

/**
 * Renders a single raw event document into a human-readable timeline item.
 * @param {Object} rawDoc - Raw event document from `app_tt_user_events{app_id}`
 * @param {Object} [sessionMetaMap] - Optional map of sessionId -> { sessionId, startTs, endTs, duration }
 * @returns {Object} Structured timeline item with separated `business` and `raw` representations
 */
BusinessEventRenderer.prototype.render = function(rawDoc, sessionMetaMap) {
    if (!rawDoc || typeof rawDoc !== 'object') {
        return null;
    }

    var eventKey = typeof rawDoc.key === 'string' ? rawDoc.key : 'unknown';
    var rawSegments = (rawDoc.sg && typeof rawDoc.sg === 'object' && !Array.isArray(rawDoc.sg))
        ? rawDoc.sg
        : {};

    // Ensure PII redaction is always enforced even on historical documents read from DB
    var segments = validators.sanitizeEventSegments(rawSegments);

    var definition = this.registry.getDefinition(eventKey);
    var classification = this.registry.classifyEventKey(eventKey);

    var category = rawDoc.cat || classification.category;
    var eventType = rawDoc.type || classification.eventType;
    var recordType = rawDoc.rtype || classification.recordType;
    var icon = definition ? definition.icon : (recordType === 'VIEW' ? 'layout' : (recordType === 'SESSION' ? 'play-circle' : 'activity'));
    var titleKey = definition ? definition.titleKey : 'tt-user-insights.event.custom.title';
    var descriptionKey = definition ? definition.descriptionKey : 'tt-user-insights.event.custom.description';
    var detailsKey = definition ? definition.detailsKey : 'tt-user-insights.event.custom.details';

    // Resolve reliable duration ONLY if genuinely provided by Countly/SDK
    // (Never computed from next_view_timestamp - previous_view_timestamp)
    var rawDurationCandidate = (rawDoc.dur !== undefined && rawDoc.dur !== null)
        ? rawDoc.dur
        : (segments.duration !== undefined ? segments.duration : (rawSegments.dur !== undefined ? rawSegments.dur : null));
    var parsedDuration = formatDurationSeconds(rawDurationCandidate);

    var summaryItems = [];
    var descriptionParams = {};
    var consumedSegmentKeys = {};

    if (parsedDuration.seconds !== null) {
        descriptionParams.duration = String(parsedDuration.seconds);
        descriptionParams.duration_formatted = parsedDuration.formatted;
    }

    // 1. Extract defined fields if this event has a declarative definition
    if (definition && Array.isArray(definition.fields)) {
        definition.fields.forEach(function(fieldDef) {
            var extracted = extractFieldFromSegments(segments, fieldDef);
            if (extracted.rawValue === undefined) {
                if (fieldDef.prop === 'duration' && parsedDuration.seconds !== null) {
                    extracted = { matchedProp: 'dur', rawValue: parsedDuration.seconds };
                } else if (fieldDef.prop === 'amount' && rawDoc.s !== undefined && rawDoc.s !== null && rawDoc.s > 0) {
                    extracted = { matchedProp: 's', rawValue: rawDoc.s };
                }
            }

            if (extracted.rawValue !== undefined) {
                if (extracted.matchedProp) {
                    consumedSegmentKeys[extracted.matchedProp] = true;
                }
                var formatted = formatPropertyValue(extracted.rawValue, fieldDef.format);
                if (formatted.value !== null) {
                    descriptionParams[fieldDef.prop] = formatted.formattedValue;
                    summaryItems.push({
                        key: fieldDef.prop,
                        labelKey: fieldDef.labelKey,
                        value: formatted.value,
                        formattedValue: formatted.formattedValue,
                        format: fieldDef.format,
                        primary: Boolean(fieldDef.primary),
                        detail: Boolean(fieldDef.detail)
                    });
                }
            }
        });
    }

    // 2. Include remaining unconsumed user/business segment properties as secondary summary items
    // (excluding internal `[CLY]_view` flags like `visit`, `start`, `exit`, `bounce`, `uvc`, `_idv`)
    var publicProperties = {};
    var segmentKeys = Object.keys(segments);
    for (var i = 0; i < segmentKeys.length; i++) {
        var segKey = segmentKeys[i];
        if (eventKey === '[CLY]_view' && INTERNAL_VIEW_META_KEYS[segKey]) {
            continue;
        }
        publicProperties[segKey] = segments[segKey];

        if (!consumedSegmentKeys[segKey]) {
            var rawVal = segments[segKey];
            if (rawVal !== undefined && rawVal !== null && rawVal !== '') {
                var autoFormatted = formatPropertyValue(rawVal, typeof rawVal === 'number' ? 'number' : 'string');
                if (autoFormatted.value !== null) {
                    if (descriptionParams[segKey] === undefined) {
                        descriptionParams[segKey] = autoFormatted.formattedValue;
                    }
                    summaryItems.push({
                        key: segKey,
                        labelKey: 'tt-user-insights.field.' + segKey,
                        labelFallback: humanizeKeyFallback(segKey),
                        value: autoFormatted.value,
                        formattedValue: autoFormatted.formattedValue,
                        format: typeof rawVal === 'number' ? 'number' : 'string',
                        primary: !definition && summaryItems.length < 2,
                        detail: !definition && summaryItems.length >= 2 && summaryItems.length < 4
                    });
                }
            }
        }
    }

    // 3. Build primary descriptionFallback and secondary detailsFallback
    var primaryParts = summaryItems
        .filter(function(item) { return item.primary; })
        .map(function(item) { return item.formattedValue; });

    var detailParts = summaryItems
        .filter(function(item) { return item.detail; })
        .map(function(item) {
            if (item.format === 'currency') {
                return '€' + item.formattedValue;
            }
            if (item.key === 'results_count') {
                return item.formattedValue;
            }
            return item.key + ': ' + item.formattedValue;
        });

    if (!primaryParts.length && summaryItems.length > 0 && recordType !== 'SESSION') {
        primaryParts = [summaryItems[0].formattedValue];
    }

    // 4. Special structured Search Analytics extraction for `search_performed` (Fase 7)
    var searchAnalytics = null;
    if (eventKey === 'search_performed') {
        searchAnalytics = {
            query: descriptionParams.query !== undefined ? descriptionParams.query : null,
            resultsCount: segments.results_count !== undefined
                ? Number(segments.results_count)
                : (segments.results !== undefined ? Number(segments.results) : null),
            category: segments.category || segments.search_category || null,
            filters: segments.filters || segments.active_filters || segments.applied_filters || null
        };
    }

    // 5. Session association (Fase 8): only attach when `rawDoc.sid` is genuinely present
    var sessionId = typeof rawDoc.sid === 'string' && rawDoc.sid.trim() ? rawDoc.sid.trim() : null;
    var sessionInfo = null;
    if (sessionId) {
        if (sessionMetaMap && sessionMetaMap[sessionId]) {
            sessionInfo = sessionMetaMap[sessionId];
        } else {
            sessionInfo = {
                sessionId: sessionId,
                startTs: null,
                endTs: null,
                duration: null,
                durationFormatted: null
            };
        }
    }

    var timestampMs = typeof rawDoc.ts === 'number' ? rawDoc.ts : 0;

    // For `[CLY]_view`, the human-readable title can directly reflect the screen name when rendered in compact mode
    var titleFallback = (eventKey === '[CLY]_view' && descriptionParams.name)
        ? String(descriptionParams.name)
        : humanizeKeyFallback(eventKey);

    var rendered = {
        id: rawDoc._id ? String(rawDoc._id) : String(timestampMs) + '_' + eventKey,
        eventKey: eventKey,
        timestamp: timestampMs,
        createdAt: rawDoc.cd ? new Date(rawDoc.cd).toISOString() : (timestampMs ? new Date(timestampMs).toISOString() : null),
        type: recordType, // 'SESSION' | 'VIEW' | 'TT_BUSINESS_EVENT' | 'CUSTOM_EVENT'
        eventType: eventType, // 'business' | 'system' | 'custom'
        category: category,
        categoryLabelKey: 'tt-user-insights.category.' + category,
        icon: icon,
        titleKey: titleKey,
        titleFallback: titleFallback,
        descriptionKey: descriptionKey,
        descriptionParams: descriptionParams,
        descriptionFallback: primaryParts.join(' - '),
        detailsKey: detailsKey,
        detailsFallback: detailParts.join(' • '),
        duration: parsedDuration.seconds,
        durationFormatted: parsedDuration.formatted,
        session: sessionInfo,
        properties: publicProperties,
        searchAnalytics: searchAnalytics,
        summaryItems: summaryItems,
        user: {
            uid: rawDoc.uid || null,
            deviceId: rawDoc.did || null
        },
        eventData: {
            count: typeof rawDoc.c === 'number' ? rawDoc.c : 1,
            sum: typeof rawDoc.s === 'number' ? rawDoc.s : 0,
            duration: parsedDuration.seconds,
            segments: publicProperties
        },
        raw: {
            _id: rawDoc._id ? String(rawDoc._id) : undefined,
            key: eventKey,
            uid: rawDoc.uid || null,
            did: rawDoc.did || null,
            sid: sessionId,
            ts: timestampMs,
            cd: rawDoc.cd || null,
            c: typeof rawDoc.c === 'number' ? rawDoc.c : 1,
            s: typeof rawDoc.s === 'number' ? rawDoc.s : 0,
            dur: parsedDuration.seconds,
            cat: category,
            type: eventType,
            rtype: recordType,
            sg: segments
        }
    };

    // 6. Invoke custom programmatic renderer if one was registered for this eventKey
    var customRenderer = this.registry.getCustomRenderer(eventKey);
    if (customRenderer) {
        try {
            var customOverrides = customRenderer(rawDoc, definition, rendered);
            if (customOverrides && typeof customOverrides === 'object') {
                if (typeof customOverrides.titleKey === 'string') {
                    rendered.titleKey = customOverrides.titleKey;
                }
                if (typeof customOverrides.titleFallback === 'string') {
                    rendered.titleFallback = customOverrides.titleFallback;
                }
                if (typeof customOverrides.descriptionKey === 'string') {
                    rendered.descriptionKey = customOverrides.descriptionKey;
                }
                if (typeof customOverrides.descriptionFallback === 'string') {
                    rendered.descriptionFallback = customOverrides.descriptionFallback;
                }
                if (typeof customOverrides.detailsKey === 'string') {
                    rendered.detailsKey = customOverrides.detailsKey;
                }
                if (typeof customOverrides.detailsFallback === 'string') {
                    rendered.detailsFallback = customOverrides.detailsFallback;
                }
                if (customOverrides.descriptionParams && typeof customOverrides.descriptionParams === 'object') {
                    rendered.descriptionParams = customOverrides.descriptionParams;
                }
                if (typeof customOverrides.icon === 'string') {
                    rendered.icon = customOverrides.icon;
                }
                if (typeof customOverrides.category === 'string') {
                    rendered.category = customOverrides.category;
                    rendered.categoryLabelKey = 'tt-user-insights.category.' + customOverrides.category;
                }
                if (Array.isArray(customOverrides.summaryItems)) {
                    rendered.summaryItems = customOverrides.summaryItems;
                }
            }
        } catch (err) {
            // Fail gracefully and preserve default rendering if a custom renderer throws
        }
    }

    return rendered;
};

/**
 * Renders an array of raw event documents.
 * @param {Array<Object>} rawDocs
 * @param {Object} [sessionMetaMap]
 * @returns {Array<Object>}
 */
BusinessEventRenderer.prototype.renderMany = function(rawDocs, sessionMetaMap) {
    if (!Array.isArray(rawDocs)) {
        return [];
    }
    var self = this;
    var results = [];
    for (var i = 0; i < rawDocs.length; i++) {
        var item = self.render(rawDocs[i], sessionMetaMap);
        if (item) {
            results.push(item);
        }
    }
    return results;
};

var defaultRenderer = new BusinessEventRenderer();

module.exports = {
    BusinessEventRenderer: BusinessEventRenderer,
    renderer: defaultRenderer,
    formatPropertyValue: formatPropertyValue,
    formatDurationSeconds: formatDurationSeconds,
    humanizeKeyFallback: humanizeKeyFallback
};
