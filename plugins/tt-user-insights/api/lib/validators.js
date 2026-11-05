'use strict';

/**
 * Input Validation, Sanitization & PII Redaction Utilities for tt-user-insights.
 *
 * Security & Privacy protections enforced:
 * 1. Strict scalar type checking (rejects Objects/Arrays passed as query parameters to prevent NoSQL operator injection like `{$ne: null}`, `{$gt: ""}`, `{$where: ...}`).
 * 2. Safe Regular Expression escaping (`escapeRegExp`) to prevent ReDoS and regex injection.
 * 3. Strict `app_id` 24-hex ObjectId format validation for application isolation.
 * 4. Pagination and date-range clamping.
 * 5. Sanitization of ingested event segmentation and user custom properties (rejects keys starting with `$` or containing `.` or `__proto__`).
 * 6. Automatic PII & Secret Redaction:
 *    - Masks values of sensitive property keys (`password`, `token`, `authorization`, `credit_card`, `cvv`, `iban`, etc. + configurable `config.redacted_properties`).
 *    - Detects and masks inline JWTs, Bearer/Basic authorization headers, and payment card numbers (PAN) inside string values.
 */
var config = require('../../config.js');

var HEX_24_REGEX = /^[0-9a-fA-F]{24}$/;
var FORBIDDEN_KEYS = {
    '__proto__': true,
    'constructor': true,
    'prototype': true
};

// Built-in regex matching sensitive property names (case-insensitive)
var SENSITIVE_KEY_REGEX = /(?:^|[_.-])(pass(?:word|wd|code|phrase)?|pwd|secret|client_secret|private_key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|csrf[_-]?token|jwt|authorization|auth[_-]?header|cookie|set[_-]?cookie|credit[_-]?card|card[_-]?number|cc[_-]?number|pan|cvv|cvc|ccv|security[_-]?code|iban|bic|pin|ssn)(?:$|[_.-])/i;

// Built-in regexes for sensitive patterns inside string values:
// 1. JWT tokens (header.payload.signature)
var JWT_VALUE_REGEX = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// 2. Bearer / Basic Authorization headers
var AUTH_HEADER_VALUE_REGEX = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
// 3. Potential 13-19 digit payment card numbers (with optional spaces or hyphens)
var CARD_CANDIDATE_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Checks whether a digit string (13 to 19 digits) satisfies the Luhn checksum algorithm.
 * @param {string} digits
 * @returns {boolean}
 */
function passesLuhnCheck(digits) {
    if (!digits || digits.length < 13 || digits.length > 19 || !/^\d+$/.test(digits)) {
        return false;
    }
    var sum = 0;
    var shouldDouble = false;
    for (var i = digits.length - 1; i >= 0; i--) {
        var digit = parseInt(digits.charAt(i), 10);
        if (shouldDouble) {
            digit *= 2;
            if (digit > 9) {
                digit -= 9;
            }
        }
        sum += digit;
        shouldDouble = !shouldDouble;
    }
    return sum > 0 && (sum % 10) === 0;
}

/**
 * Checks whether a property key name is classified as sensitive / PII and must be redacted.
 * @param {string} key
 * @param {Array<string>} [extraRedactedKeys]
 * @returns {boolean}
 */
function isSensitivePropertyKey(key, extraRedactedKeys) {
    if (!key || typeof key !== 'string') {
        return false;
    }
    var normalized = key.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    if (SENSITIVE_KEY_REGEX.test(normalized)) {
        return true;
    }
    var configuredList = Array.isArray(extraRedactedKeys)
        ? extraRedactedKeys
        : (Array.isArray(config.redacted_properties) ? config.redacted_properties : []);

    for (var i = 0; i < configuredList.length; i++) {
        var item = configuredList[i];
        if (typeof item === 'string' && item.trim().toLowerCase() === normalized) {
            return true;
        }
    }
    return false;
}

/**
 * Masks sensitive patterns (JWTs, Bearer tokens, Luhn-valid credit cards) inside a string value.
 * @param {string} str
 * @param {string} [placeholder]
 * @returns {string}
 */
function maskSensitiveStringContent(str, placeholder) {
    if (typeof str !== 'string' || !str) {
        return str;
    }
    var mask = placeholder || config.redaction_placeholder || '[REDACTED]';
    var out = str
        .replace(JWT_VALUE_REGEX, mask)
        .replace(AUTH_HEADER_VALUE_REGEX, mask);

    out = out.replace(CARD_CANDIDATE_REGEX, function(match) {
        var digitsOnly = match.replace(/\D/g, '');
        if (passesLuhnCheck(digitsOnly)) {
            return mask;
        }
        return match;
    });

    return out;
}

/**
 * Escapes special regular expression characters in a literal user search string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
    if (typeof str !== 'string') {
        return '';
    }
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validates that an app_id (string or ObjectId) is a valid 24-character hex identifier.
 * @param {*} appId
 * @returns {string|null} Normalized 24-hex string or null if invalid
 */
function validateAppId(appId) {
    if (!appId) {
        return null;
    }
    var str = typeof appId === 'string' ? appId : (typeof appId.toString === 'function' ? appId.toString() : '');
    if (!HEX_24_REGEX.test(str)) {
        return null;
    }
    return str;
}

/**
 * Extracts a safe, trimmed scalar string from an input value.
 * Returns null if the input is an Object, Array, boolean, or starts with `$` when `disallowDollarPrefix` is true.
 * @param {*} val
 * @param {Object} [options]
 * @param {number} [options.maxLength=256]
 * @param {boolean} [options.disallowDollarPrefix=false]
 * @returns {string|null}
 */
function sanitizeScalarString(val, options) {
    var opts = options || {};
    var maxLen = typeof opts.maxLength === 'number' ? opts.maxLength : 256;

    if (val === null || val === undefined) {
        return null;
    }
    if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
            return null;
        }
        val = String(val);
    }
    if (typeof val !== 'string') {
        return null;
    }

    var trimmed = val.trim().replace(/\0/g, '');
    if (!trimmed) {
        return null;
    }
    if (opts.disallowDollarPrefix && trimmed.charAt(0) === '$') {
        return null;
    }
    if (trimmed.length > maxLen) {
        trimmed = trimmed.substring(0, maxLen);
    }
    return trimmed;
}

/**
 * Validates and clamps pagination parameters (`skip`, `limit`).
 * @param {Object} qstring
 * @returns {{ skip: number, limit: number }}
 */
function parsePagination(qstring) {
    var qs = qstring || {};
    var defaultLimit = config.default_page_size || 25;
    var maxLimit = config.max_page_size || 100;

    var rawSkip = qs.skip !== undefined ? qs.skip : qs.offset;
    var rawLimit = qs.limit !== undefined ? qs.limit : qs.page_size;

    var skip = 0;
    if (rawSkip !== undefined && rawSkip !== null && typeof rawSkip !== 'object') {
        var parsedSkip = parseInt(rawSkip, 10);
        if (!Number.isNaN(parsedSkip) && parsedSkip >= 0 && parsedSkip <= 100000) {
            skip = parsedSkip;
        }
    }

    var limit = defaultLimit;
    if (rawLimit !== undefined && rawLimit !== null && typeof rawLimit !== 'object') {
        var parsedLimit = parseInt(rawLimit, 10);
        if (!Number.isNaN(parsedLimit) && parsedLimit >= 1) {
            limit = Math.min(parsedLimit, maxLimit);
        }
    }

    return { skip: skip, limit: limit };
}

/**
 * Parses and validates optional timestamp bounds (`from`, `to`) in milliseconds or seconds.
 * @param {Object} qstring
 * @returns {{ from: number|null, to: number|null, valid: boolean, error?: string }}
 */
function parseDateRange(qstring) {
    var qs = qstring || {};
    var from = null;
    var to = null;

    function parseTimestamp(raw) {
        if (raw === undefined || raw === null || raw === '') {
            return null;
        }
        if (typeof raw === 'object') {
            return NaN;
        }
        var num = Number(raw);
        if (!Number.isNaN(num) && Number.isFinite(num) && num > 0) {
            return num < 10000000000 ? Math.floor(num * 1000) : Math.floor(num);
        }
        if (typeof raw === 'string') {
            var parsedDate = Date.parse(raw);
            if (!Number.isNaN(parsedDate) && parsedDate > 0) {
                return parsedDate;
            }
        }
        return NaN;
    }

    if (qs.from !== undefined && qs.from !== null && qs.from !== '') {
        from = parseTimestamp(qs.from);
        if (Number.isNaN(from)) {
            return { from: null, to: null, valid: false, error: 'Invalid "from" timestamp parameter' };
        }
    }

    if (qs.to !== undefined && qs.to !== null && qs.to !== '') {
        to = parseTimestamp(qs.to);
        if (Number.isNaN(to)) {
            return { from: null, to: null, valid: false, error: 'Invalid "to" timestamp parameter' };
        }
    }

    if (from !== null && to !== null && from > to) {
        return { from: null, to: null, valid: false, error: '"from" timestamp cannot be greater than "to" timestamp' };
    }

    return { from: from, to: to, valid: true };
}

/**
 * Validates and normalizes user search parameters.
 * @param {Object} qstring
 * @returns {{ valid: boolean, error?: string, filters?: Object, pagination?: Object }}
 */
function parseUserSearchParams(qstring) {
    var qs = qstring || {};

    var paramNames = ['q', 'search', 'uid', 'device_id', 'did', 'email', 'name', 'username', 'custom_key', 'custom_value'];
    for (var i = 0; i < paramNames.length; i++) {
        var key = paramNames[i];
        if (qs[key] !== undefined && qs[key] !== null && typeof qs[key] === 'object') {
            return { valid: false, error: 'Invalid parameter "' + key + '"' };
        }
    }

    var rawCustomKey = sanitizeScalarString(qs.custom_key, { maxLength: 64 });
    if (rawCustomKey && (rawCustomKey.charAt(0) === '$' || rawCustomKey.indexOf('.') !== -1 || FORBIDDEN_KEYS[rawCustomKey])) {
        return { valid: false, error: 'Invalid "custom_key" parameter' };
    }
    var customKey = rawCustomKey;

    var filters = {
        q: sanitizeScalarString(qs.q !== undefined ? qs.q : qs.search, { maxLength: 128 }),
        uid: sanitizeScalarString(qs.uid, { maxLength: 128, disallowDollarPrefix: true }),
        deviceId: sanitizeScalarString(qs.device_id !== undefined ? qs.device_id : qs.did, { maxLength: 128, disallowDollarPrefix: true }),
        email: sanitizeScalarString(qs.email, { maxLength: 128 }),
        name: sanitizeScalarString(qs.name, { maxLength: 128 }),
        username: sanitizeScalarString(qs.username, { maxLength: 128 }),
        customKey: customKey,
        customValue: sanitizeScalarString(qs.custom_value, { maxLength: 128 })
    };

    var pagination = parsePagination(qs);

    return {
        valid: true,
        filters: filters,
        pagination: pagination
    };
}

/**
 * Normalizes an `event_type` / `type` filter value into either:
 * - a `recordType` ('SESSION' | 'VIEW' | 'TT_BUSINESS_EVENT' | 'CUSTOM_EVENT')
 * - or a legacy `eventType` ('business' | 'system' | 'custom')
 * Returns null if invalid.
 */
function normalizeEventTypeFilter(rawType) {
    if (!rawType || typeof rawType !== 'string') {
        return null;
    }
    var upper = rawType.trim().toUpperCase();
    var lower = rawType.trim().toLowerCase();

    if (upper === 'SESSION' || upper === 'VIEW' || upper === 'TT_BUSINESS_EVENT' || upper === 'CUSTOM_EVENT') {
        return { recordType: upper, eventType: null };
    }
    if (lower === 'business') {
        return { recordType: 'TT_BUSINESS_EVENT', eventType: 'business' };
    }
    if (lower === 'system' || lower === 'custom') {
        return { recordType: null, eventType: lower };
    }
    return null;
}

/**
 * Validates and normalizes timeline query parameters.
 * @param {Object} qstring
 * @returns {{ valid: boolean, error?: string, filters?: Object, pagination?: Object }}
 */
function parseTimelineParams(qstring) {
    var qs = qstring || {};

    var scalarParams = ['uid', 'device_id', 'did', 'category', 'event_key', 'event_type', 'type', 'q', 'search', 'searches_only', 'session_id'];
    for (var i = 0; i < scalarParams.length; i++) {
        var p = scalarParams[i];
        if (qs[p] !== undefined && qs[p] !== null && typeof qs[p] === 'object') {
            return { valid: false, error: 'Invalid parameter "' + p + '"' };
        }
    }

    var uid = sanitizeScalarString(qs.uid, { maxLength: 128, disallowDollarPrefix: true });
    var deviceId = sanitizeScalarString(qs.device_id !== undefined ? qs.device_id : qs.did, { maxLength: 128, disallowDollarPrefix: true });

    if (!uid && !deviceId) {
        return { valid: false, error: 'Missing required parameter "uid" or "device_id"' };
    }

    var dateRange = parseDateRange(qs);
    if (!dateRange.valid) {
        return { valid: false, error: dateRange.error };
    }

    var rawEventType = sanitizeScalarString(qs.event_type !== undefined ? qs.event_type : qs.type, { maxLength: 32, disallowDollarPrefix: true });
    var normalizedType = null;
    if (rawEventType) {
        normalizedType = normalizeEventTypeFilter(rawEventType);
        if (!normalizedType) {
            return { valid: false, error: 'Invalid "event_type" parameter' };
        }
    }

    var category = sanitizeScalarString(qs.category, { maxLength: 64, disallowDollarPrefix: true });
    var eventKey = sanitizeScalarString(qs.event_key, { maxLength: 128, disallowDollarPrefix: true });
    var searchText = sanitizeScalarString(qs.q !== undefined ? qs.q : qs.search, { maxLength: 128 });
    var sessionId = sanitizeScalarString(qs.session_id, { maxLength: 128, disallowDollarPrefix: true });
    var searchesOnly = qs.searches_only === 'true' || qs.searches_only === '1' || qs.searches_only === true || qs.searches_only === 1;

    if (searchesOnly) {
        eventKey = 'search_performed';
        category = 'search';
    }

    return {
        valid: true,
        filters: {
            uid: uid,
            deviceId: deviceId,
            from: dateRange.from,
            to: dateRange.to,
            category: category ? category.toLowerCase() : null,
            eventKey: eventKey,
            recordType: normalizedType ? normalizedType.recordType : null,
            eventType: normalizedType ? normalizedType.eventType : null,
            sessionId: sessionId,
            searchesOnly: searchesOnly,
            q: searchText
        },
        pagination: parsePagination(qs)
    };
}

/**
 * Validates and normalizes Live Events Stream parameters (`GET /o/tt-user-insights/live`).
 * Unlike `parseTimelineParams`, `uid` / `device_id` are optional because the Live Stream can monitor
 * the entire application in real time or be narrowed down to a specific user/category/error filter.
 * @param {Object} qstring
 * @returns {{ valid: boolean, error?: string, filters?: Object, pagination?: Object }}
 */
function parseLiveStreamParams(qstring) {
    var qs = qstring || {};

    var scalarParams = [
        'uid', 'device_id', 'did', 'category', 'event_key', 'event_type',
        'type', 'q', 'search', 'searches_only', 'errors_only', 'since_ts'
    ];
    for (var i = 0; i < scalarParams.length; i++) {
        var p = scalarParams[i];
        if (qs[p] !== undefined && qs[p] !== null && typeof qs[p] === 'object') {
            return { valid: false, error: 'Invalid parameter "' + p + '"' };
        }
    }

    var uid = sanitizeScalarString(qs.uid, { maxLength: 128, disallowDollarPrefix: true });
    var deviceId = sanitizeScalarString(qs.device_id !== undefined ? qs.device_id : qs.did, { maxLength: 128, disallowDollarPrefix: true });

    var dateRange = parseDateRange(qs);
    if (!dateRange.valid) {
        return { valid: false, error: dateRange.error };
    }

    var sinceTs = null;
    if (qs.since_ts !== undefined && qs.since_ts !== null && qs.since_ts !== '') {
        var numSince = Number(qs.since_ts);
        if (Number.isNaN(numSince) || !Number.isFinite(numSince) || numSince < 0) {
            return { valid: false, error: 'Invalid "since_ts" parameter' };
        }
        sinceTs = numSince > 0 && numSince < 10000000000 ? Math.floor(numSince * 1000) : Math.floor(numSince);
    }

    var rawEventType = sanitizeScalarString(qs.event_type !== undefined ? qs.event_type : qs.type, { maxLength: 32, disallowDollarPrefix: true });
    var normalizedType = null;
    if (rawEventType) {
        normalizedType = normalizeEventTypeFilter(rawEventType);
        if (!normalizedType) {
            return { valid: false, error: 'Invalid "event_type" parameter' };
        }
    }

    var category = sanitizeScalarString(qs.category, { maxLength: 64, disallowDollarPrefix: true });
    var eventKey = sanitizeScalarString(qs.event_key, { maxLength: 128, disallowDollarPrefix: true });
    var searchText = sanitizeScalarString(qs.q !== undefined ? qs.q : qs.search, { maxLength: 128 });
    var searchesOnly = qs.searches_only === 'true' || qs.searches_only === '1' || qs.searches_only === true || qs.searches_only === 1;
    var errorsOnly = qs.errors_only === 'true' || qs.errors_only === '1' || qs.errors_only === true || qs.errors_only === 1;

    if (searchesOnly) {
        eventKey = 'search_performed';
        category = 'search';
    } else if (errorsOnly) {
        category = 'error';
    }

    var pagination = parsePagination(Object.assign({ limit: 40 }, qs));

    return {
        valid: true,
        filters: {
            uid: uid,
            deviceId: deviceId,
            from: dateRange.from,
            to: dateRange.to,
            sinceTs: sinceTs,
            category: category ? category.toLowerCase() : null,
            eventKey: eventKey,
            recordType: normalizedType ? normalizedType.recordType : null,
            eventType: normalizedType ? normalizedType.eventType : null,
            searchesOnly: searchesOnly,
            errorsOnly: errorsOnly,
            q: searchText
        },
        pagination: pagination
    };
}

/**
 * Validates parameters for `GET /o/tt-user-insights/breadcrumbs` (Error & Event Breadcrumbs).
 * Retrieves the sequence of preceding user actions leading up to `before_ts`.
 * @param {Object} qstring
 * @returns {{ valid: boolean, error?: string, params?: Object }}
 */
function parseBreadcrumbsParams(qstring) {
    var qs = qstring || {};

    var scalarParams = ['uid', 'device_id', 'did', 'before_ts', 'timestamp', 'event_id', 'limit'];
    for (var i = 0; i < scalarParams.length; i++) {
        var p = scalarParams[i];
        if (qs[p] !== undefined && qs[p] !== null && typeof qs[p] === 'object') {
            return { valid: false, error: 'Invalid parameter "' + p + '"' };
        }
    }

    var uid = sanitizeScalarString(qs.uid, { maxLength: 128, disallowDollarPrefix: true });
    var deviceId = sanitizeScalarString(qs.device_id !== undefined ? qs.device_id : qs.did, { maxLength: 128, disallowDollarPrefix: true });

    if (!uid && !deviceId) {
        return { valid: false, error: 'Missing required parameter "uid" or "device_id"' };
    }

    var rawTs = qs.before_ts !== undefined ? qs.before_ts : qs.timestamp;
    if (rawTs === undefined || rawTs === null || rawTs === '') {
        return { valid: false, error: 'Missing required parameter "before_ts"' };
    }
    var numTs = Number(rawTs);
    if (Number.isNaN(numTs) || !Number.isFinite(numTs) || numTs <= 0) {
        return { valid: false, error: 'Invalid "before_ts" timestamp parameter' };
    }
    var beforeTs = numTs < 10000000000 ? Math.floor(numTs * 1000) : Math.floor(numTs);

    var eventId = sanitizeScalarString(qs.event_id, { maxLength: 128, disallowDollarPrefix: true });
    var limit = 10;
    if (qs.limit !== undefined && qs.limit !== null) {
        var parsedLimit = parseInt(qs.limit, 10);
        if (!Number.isNaN(parsedLimit) && parsedLimit >= 1) {
            limit = Math.min(parsedLimit, 30);
        }
    }

    return {
        valid: true,
        params: {
            uid: uid,
            deviceId: deviceId,
            beforeTs: beforeTs,
            eventId: eventId,
            limit: limit
        }
    };
}

/**
 * Sanitizes and PII-redacts an event segmentation object (`currEvent.segmentation`)
 * before persisting to MongoDB or returning via API.
 *
 * - Strips keys starting with `$`, containing `.` or `\0`, or matching prototype pollution keys.
 * - Redacts values of any key matching `isSensitivePropertyKey` (passwords, tokens, auth headers, credit cards, etc.)
 *   with `"[REDACTED]"`.
 * - Masks inline JWTs, Bearer tokens, and Luhn-valid credit card numbers inside string values.
 * @param {Object} rawSegments
 * @param {Object} [options]
 * @param {Array<string>} [options.redactedProperties]
 * @param {string} [options.redactionPlaceholder]
 * @param {boolean} [options.redactPii=true]
 * @returns {Object}
 */
function sanitizeEventSegments(rawSegments, options) {
    if (!rawSegments || typeof rawSegments !== 'object' || Array.isArray(rawSegments)) {
        return {};
    }

    var opts = options || {};
    var redactEnabled = opts.redactPii !== undefined ? Boolean(opts.redactPii) : (config.redact_pii !== false);
    var placeholder = opts.redactionPlaceholder || config.redaction_placeholder || '[REDACTED]';
    var customRedactedList = opts.redactedProperties || config.redacted_properties;

    var maxKeys = config.max_segmentation_keys || 50;
    var maxStrLen = config.max_string_length || 1000;
    var clean = {};
    var keys = Object.keys(rawSegments);
    var count = 0;

    for (var i = 0; i < keys.length; i++) {
        if (count >= maxKeys) {
            break;
        }
        var k = keys[i];
        if (!k || typeof k !== 'string') {
            continue;
        }
        var trimmedKey = k.trim();
        if (!trimmedKey ||
            trimmedKey.length > 128 ||
            trimmedKey.charAt(0) === '$' ||
            trimmedKey.indexOf('.') !== -1 ||
            trimmedKey.indexOf('\0') !== -1 ||
            FORBIDDEN_KEYS[trimmedKey]) {
            continue;
        }

        var val = rawSegments[k];
        if (val === undefined || val === null) {
            continue;
        }

        // Check if property key is sensitive/PII
        if (redactEnabled && isSensitivePropertyKey(trimmedKey, customRedactedList)) {
            clean[trimmedKey] = placeholder;
            count++;
            continue;
        }

        if (typeof val === 'string') {
            var truncated = val.length > maxStrLen ? val.substring(0, maxStrLen) : val;
            clean[trimmedKey] = redactEnabled ? maskSensitiveStringContent(truncated, placeholder) : truncated;
            count++;
        } else if (typeof val === 'number') {
            if (Number.isFinite(val)) {
                // Guard against raw numeric credit card numbers passed as numbers
                if (redactEnabled && String(val).length >= 13 && passesLuhnCheck(String(val))) {
                    clean[trimmedKey] = placeholder;
                } else {
                    clean[trimmedKey] = val;
                }
                count++;
            }
        } else if (typeof val === 'boolean') {
            clean[trimmedKey] = val;
            count++;
        } else if (Array.isArray(val)) {
            var safeArr = val.slice(0, 20).map(function(item) {
                if (typeof item === 'string') {
                    var s = item.length > 200 ? item.substring(0, 200) : item;
                    return redactEnabled ? maskSensitiveStringContent(s, placeholder) : s;
                }
                if (typeof item === 'number' || typeof item === 'boolean') {
                    return item;
                }
                return String(item);
            });
            clean[trimmedKey] = safeArr;
            count++;
        } else if (typeof val === 'object') {
            // Support serializing nested filter objects (e.g. search_performed.filters = { brand: "Mattel" })
            // after recursively sanitizing their keys/values
            var nestedClean = sanitizeEventSegments(val, opts);
            try {
                var jsonStr = JSON.stringify(nestedClean);
                clean[trimmedKey] = jsonStr.length > maxStrLen ? jsonStr.substring(0, maxStrLen) : jsonStr;
                count++;
            } catch (e) {
                // Ignore unserializable objects
            }
        }
    }

    return clean;
}

module.exports = {
    escapeRegExp: escapeRegExp,
    validateAppId: validateAppId,
    sanitizeScalarString: sanitizeScalarString,
    parsePagination: parsePagination,
    parseDateRange: parseDateRange,
    parseUserSearchParams: parseUserSearchParams,
    parseTimelineParams: parseTimelineParams,
    parseLiveStreamParams: parseLiveStreamParams,
    parseBreadcrumbsParams: parseBreadcrumbsParams,
    normalizeEventTypeFilter: normalizeEventTypeFilter,
    sanitizeEventSegments: sanitizeEventSegments,
    isSensitivePropertyKey: isSensitivePropertyKey,
    maskSensitiveStringContent: maskSensitiveStringContent,
    passesLuhnCheck: passesLuhnCheck,
    FORBIDDEN_KEYS: FORBIDDEN_KEYS
};
