'use strict';

/**
 * Extensible Registry for Business Event Definitions and Custom Renderers.
 *
 * Allows tt-user-insights or future TT Analytics modules to dynamically register:
 * 1. Declarative business event definitions (`registerEventDefinition` / `registerEventDefinitions`)
 * 2. Custom event renderer callbacks (`registerEventRenderer`)
 * 3. Event categories (`registerCategory`)
 *
 * Supports the 4 timeline record types required by User Activity Timeline:
 * - `SESSION`
 * - `VIEW`
 * - `TT_BUSINESS_EVENT`
 * - `CUSTOM_EVENT`
 */
var defaultConfig = require('../config/businessEvents.js');

var VALID_FORMATS = ['string', 'number', 'currency', 'integer', 'boolean'];
var VALID_EVENT_TYPES = ['business', 'system', 'custom'];
var VALID_RECORD_TYPES = ['SESSION', 'VIEW', 'TT_BUSINESS_EVENT', 'CUSTOM_EVENT'];

function EventRegistry() {
    this._categories = new Map();
    this._definitions = new Map();
    this._customRenderers = new Map();
    this.resetToDefaults();
}

/**
 * Resets registry to the initial built-in categories and business events.
 */
EventRegistry.prototype.resetToDefaults = function() {
    var self = this;
    this._categories.clear();
    this._definitions.clear();
    this._customRenderers.clear();

    defaultConfig.INITIAL_CATEGORIES.forEach(function(cat) {
        self.registerCategory(cat);
    });

    defaultConfig.INITIAL_BUSINESS_EVENTS.forEach(function(def) {
        self.registerEventDefinition(def);
    });
};

/**
 * Registers or updates a timeline category.
 * @param {Object} category - { key, labelKey, icon }
 */
EventRegistry.prototype.registerCategory = function(category) {
    if (!category || typeof category.key !== 'string' || !category.key.trim()) {
        throw new Error('Invalid category definition: "key" must be a non-empty string');
    }
    var cleanKey = category.key.trim().toLowerCase();
    this._categories.set(cleanKey, {
        key: cleanKey,
        labelKey: typeof category.labelKey === 'string' && category.labelKey.trim()
            ? category.labelKey.trim()
            : 'tt-user-insights.category.' + cleanKey,
        icon: typeof category.icon === 'string' && category.icon.trim()
            ? category.icon.trim()
            : 'tag'
    });
    return this._categories.get(cleanKey);
};

/**
 * Resolves the canonical `recordType` ('SESSION' | 'VIEW' | 'TT_BUSINESS_EVENT' | 'CUSTOM_EVENT')
 * for a given definition or event key.
 */
function resolveRecordType(key, explicitRecordType, eventType) {
    if (typeof explicitRecordType === 'string' && VALID_RECORD_TYPES.indexOf(explicitRecordType.toUpperCase()) !== -1) {
        return explicitRecordType.toUpperCase();
    }
    if (key === '[CLY]_session_begin' || key === '[CLY]_session_end') {
        return 'SESSION';
    }
    if (key === '[CLY]_view') {
        return 'VIEW';
    }
    if (eventType === 'business') {
        return 'TT_BUSINESS_EVENT';
    }
    return 'CUSTOM_EVENT';
}

/**
 * Registers or updates a declarative business event definition.
 * @param {Object} definition - Declarative business event definition
 */
EventRegistry.prototype.registerEventDefinition = function(definition) {
    if (!definition || typeof definition.key !== 'string' || !definition.key.trim()) {
        throw new Error('Invalid event definition: "key" must be a non-empty string');
    }

    var key = definition.key.trim();
    var category = typeof definition.category === 'string' && definition.category.trim()
        ? definition.category.trim().toLowerCase()
        : 'custom';

    if (!this._categories.has(category)) {
        this.registerCategory({
            key: category,
            labelKey: 'tt-user-insights.category.' + category,
            icon: 'folder'
        });
    }

    var eventType = VALID_EVENT_TYPES.indexOf(definition.eventType) !== -1
        ? definition.eventType
        : (key.indexOf('[CLY]_') === 0 ? 'system' : 'business');

    var recordType = resolveRecordType(key, definition.recordType, eventType);

    var normalizedFields = [];
    if (Array.isArray(definition.fields)) {
        definition.fields.forEach(function(field) {
            if (field && typeof field.prop === 'string' && field.prop.trim()) {
                var propName = field.prop.trim();
                var aliases = Array.isArray(field.aliases)
                    ? field.aliases.filter(function(a) { return typeof a === 'string' && a.trim(); })
                    : [];
                normalizedFields.push({
                    prop: propName,
                    aliases: aliases,
                    labelKey: typeof field.labelKey === 'string' && field.labelKey.trim()
                        ? field.labelKey.trim()
                        : 'tt-user-insights.field.' + propName,
                    format: VALID_FORMATS.indexOf(field.format) !== -1 ? field.format : 'string',
                    primary: Boolean(field.primary),
                    detail: Boolean(field.detail)
                });
            }
        });
    }

    var normalized = {
        key: key,
        category: category,
        eventType: eventType,
        recordType: recordType,
        icon: typeof definition.icon === 'string' && definition.icon.trim() ? definition.icon.trim() : 'activity',
        titleKey: typeof definition.titleKey === 'string' && definition.titleKey.trim()
            ? definition.titleKey.trim()
            : 'tt-user-insights.event.' + key + '.title',
        descriptionKey: typeof definition.descriptionKey === 'string' && definition.descriptionKey.trim()
            ? definition.descriptionKey.trim()
            : 'tt-user-insights.event.' + key + '.description',
        detailsKey: typeof definition.detailsKey === 'string' && definition.detailsKey.trim()
            ? definition.detailsKey.trim()
            : 'tt-user-insights.event.' + key + '.details',
        fields: normalizedFields
    };

    this._definitions.set(key, normalized);

    if (typeof definition.renderer === 'function') {
        this._customRenderers.set(key, definition.renderer);
    }

    return normalized;
};

/**
 * Registers multiple business event definitions at once.
 * @param {Array<Object>} definitions
 */
EventRegistry.prototype.registerEventDefinitions = function(definitions) {
    if (!Array.isArray(definitions)) {
        throw new Error('registerEventDefinitions expects an array of definitions');
    }
    var self = this;
    return definitions.map(function(def) {
        return self.registerEventDefinition(def);
    });
};

/**
 * Registers a custom programmatic renderer function for a specific event key.
 * @param {string} eventKey
 * @param {Function} rendererFn - function(rawEvent, definition, defaultRendered) => partial rendered object
 */
EventRegistry.prototype.registerEventRenderer = function(eventKey, rendererFn) {
    if (typeof eventKey !== 'string' || !eventKey.trim()) {
        throw new Error('eventKey must be a non-empty string');
    }
    if (typeof rendererFn !== 'function') {
        throw new Error('rendererFn must be a function');
    }
    this._customRenderers.set(eventKey.trim(), rendererFn);
};

/**
 * Retrieves the definition for an event key, or null if not registered.
 * @param {string} eventKey
 * @returns {Object|null}
 */
EventRegistry.prototype.getDefinition = function(eventKey) {
    if (typeof eventKey !== 'string') {
        return null;
    }
    return this._definitions.get(eventKey) || null;
};

/**
 * Retrieves a custom renderer function for an event key, if registered.
 * @param {string} eventKey
 * @returns {Function|null}
 */
EventRegistry.prototype.getCustomRenderer = function(eventKey) {
    if (typeof eventKey !== 'string') {
        return null;
    }
    return this._customRenderers.get(eventKey) || null;
};

/**
 * Resolves the category, eventType, and recordType for a given event key at ingestion or query time.
 * @param {string} eventKey
 * @returns {{ category: string, eventType: string, recordType: string }}
 */
EventRegistry.prototype.classifyEventKey = function(eventKey) {
    var def = this.getDefinition(eventKey);
    if (def) {
        return {
            category: def.category,
            eventType: def.eventType,
            recordType: def.recordType
        };
    }
    if (typeof eventKey === 'string') {
        if (eventKey === '[CLY]_session_begin' || eventKey === '[CLY]_session_end') {
            return {
                category: 'navigation',
                eventType: 'system',
                recordType: 'SESSION'
            };
        }
        if (eventKey === '[CLY]_view') {
            return {
                category: 'navigation',
                eventType: 'system',
                recordType: 'VIEW'
            };
        }
        if (eventKey === '[CLY]_crash') {
            return {
                category: 'error',
                eventType: 'system',
                recordType: 'CUSTOM_EVENT'
            };
        }
        if (eventKey.indexOf('[CLY]_') === 0) {
            return {
                category: 'navigation',
                eventType: 'system',
                recordType: 'CUSTOM_EVENT'
            };
        }
    }
    return {
        category: 'custom',
        eventType: 'custom',
        recordType: 'CUSTOM_EVENT'
    };
};

/**
 * Returns all registered event definitions as a serializable array.
 * @returns {Array<Object>}
 */
EventRegistry.prototype.getAllDefinitions = function() {
    return Array.from(this._definitions.values());
};

/**
 * Returns all registered categories as a serializable array.
 * @returns {Array<Object>}
 */
EventRegistry.prototype.getCategories = function() {
    return Array.from(this._categories.values());
};

/**
 * Checks whether a category key is registered.
 * @param {string} categoryKey
 * @returns {boolean}
 */
EventRegistry.prototype.isValidCategory = function(categoryKey) {
    if (typeof categoryKey !== 'string') {
        return false;
    }
    return this._categories.has(categoryKey.trim().toLowerCase());
};

var defaultRegistry = new EventRegistry();

module.exports = {
    EventRegistry: EventRegistry,
    registry: defaultRegistry,
    VALID_RECORD_TYPES: VALID_RECORD_TYPES
};
