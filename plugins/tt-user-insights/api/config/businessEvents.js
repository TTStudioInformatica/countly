'use strict';

/**
 * Declarative Business Event Definitions & Initial Categories for tt-user-insights
 * compliant with TT Analytics Tracking Standard v1.
 *
 * IMPORTANT ARCHITECTURAL NOTE:
 * - No hardcoded Italian strings are placed in the business logic.
 * - Every definition references localization keys (`titleKey`, `descriptionKey`, `detailsKey`, `labelKey`)
 *   resolved via Countly's `.properties` localization files (`tt-user-insights.properties` / `tt-user-insights_it.properties`).
 * - Property extraction is purely declarative via `fields` descriptors, so no event properties
 *   are hardcoded inside `BusinessEventRenderer`.
 * - Supports timeline item types (`recordType`):
 *   - `SESSION`: Session start / end events (`[CLY]_session_begin`, `[CLY]_session_end`)
 *   - `VIEW`: Screen / page views (`[CLY]_view`)
 *   - `TT_BUSINESS_EVENT`: Standard TT Analytics business events (`user_login`, `search_performed`, `order_submitted`, etc.)
 *   - `CUSTOM_EVENT`: Generic Countly custom events or SDK actions
 */

var INITIAL_CATEGORIES = [
    {
        key: 'authentication',
        labelKey: 'tt-user-insights.category.authentication',
        icon: 'user-check'
    },
    {
        key: 'navigation',
        labelKey: 'tt-user-insights.category.navigation',
        icon: 'compass'
    },
    {
        key: 'search',
        labelKey: 'tt-user-insights.category.search',
        icon: 'search'
    },
    {
        key: 'catalog',
        labelKey: 'tt-user-insights.category.catalog',
        icon: 'grid'
    },
    {
        key: 'cart',
        labelKey: 'tt-user-insights.category.cart',
        icon: 'shopping-cart'
    },
    {
        key: 'order',
        labelKey: 'tt-user-insights.category.order',
        icon: 'credit-card'
    },
    {
        key: 'error',
        labelKey: 'tt-user-insights.category.error',
        icon: 'alert-triangle'
    },
    {
        key: 'custom',
        labelKey: 'tt-user-insights.category.custom',
        icon: 'activity'
    },
    {
        key: 'system',
        labelKey: 'tt-user-insights.category.system',
        icon: 'cpu'
    }
];

/**
 * Declarative definitions for TT Analytics Tracking Standard v1 business events and Countly system events.
 * Each definition specifies:
 * - key: Countly event key
 * - category: One of the registered categories ('authentication', 'navigation', 'search', 'catalog', 'cart', 'order', 'error', 'custom', 'system')
 * - recordType: 'SESSION' | 'VIEW' | 'TT_BUSINESS_EVENT' | 'CUSTOM_EVENT'
 * - eventType: 'business' | 'system' | 'custom' | 'view' | 'session' (normalized alias)
 * - icon: UI icon identifier
 * - titleKey: Localization property key for the event title
 * - descriptionKey: Localization property key for the primary headline description (e.g. "barbie camper" or "ORD-18527")
 * - detailsKey: Localization property key for secondary details (e.g. "32 risultati" or "€842,50")
 * - fields: Ordered list of segmentation property descriptors to extract and format
 */
var INITIAL_BUSINESS_EVENTS = [
    // =========================================================================
    // AUTHENTICATION (TT Analytics Tracking Standard v1 + backward aliases)
    // =========================================================================
    {
        key: 'user_login',
        category: 'authentication',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'log-in',
        titleKey: 'tt-user-insights.event.user_login.title',
        descriptionKey: 'tt-user-insights.event.user_login.description',
        detailsKey: 'tt-user-insights.event.user_login.details',
        fields: [
            { prop: 'method', aliases: ['auth_method', 'provider'], labelKey: 'tt-user-insights.field.method', format: 'string', primary: true },
            { prop: 'customer_type', aliases: ['role', 'user_type'], labelKey: 'tt-user-insights.field.customer_type', format: 'string', detail: true }
        ]
    },
    {
        key: 'login',
        category: 'authentication',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'log-in',
        titleKey: 'tt-user-insights.event.login.title',
        descriptionKey: 'tt-user-insights.event.login.description',
        detailsKey: 'tt-user-insights.event.login.details',
        fields: [
            { prop: 'method', aliases: ['auth_method', 'provider'], labelKey: 'tt-user-insights.field.method', format: 'string', primary: true },
            { prop: 'customer_type', aliases: ['role', 'user_type'], labelKey: 'tt-user-insights.field.customer_type', format: 'string', detail: true }
        ]
    },
    {
        key: 'user_logout',
        category: 'authentication',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'log-out',
        titleKey: 'tt-user-insights.event.user_logout.title',
        descriptionKey: 'tt-user-insights.event.user_logout.description',
        detailsKey: 'tt-user-insights.event.user_logout.details',
        fields: [
            { prop: 'reason', labelKey: 'tt-user-insights.field.reason', format: 'string', primary: true }
        ]
    },
    {
        key: 'logout',
        category: 'authentication',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'log-out',
        titleKey: 'tt-user-insights.event.logout.title',
        descriptionKey: 'tt-user-insights.event.logout.description',
        detailsKey: 'tt-user-insights.event.logout.details',
        fields: [
            { prop: 'reason', labelKey: 'tt-user-insights.field.reason', format: 'string', primary: true }
        ]
    },

    // =========================================================================
    // SEARCH (TT Analytics Tracking Standard v1)
    // =========================================================================
    {
        key: 'search_performed',
        category: 'search',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'search',
        titleKey: 'tt-user-insights.event.search_performed.title',
        descriptionKey: 'tt-user-insights.event.search_performed.description',
        detailsKey: 'tt-user-insights.event.search_performed.details',
        fields: [
            { prop: 'query', aliases: ['search_query', 'term', 'keyword'], labelKey: 'tt-user-insights.field.query', format: 'string', primary: true },
            { prop: 'results_count', aliases: ['results', 'count'], labelKey: 'tt-user-insights.field.results_count', format: 'integer', detail: true },
            { prop: 'category', aliases: ['search_category'], labelKey: 'tt-user-insights.field.category', format: 'string' },
            { prop: 'filters', aliases: ['active_filters', 'applied_filters'], labelKey: 'tt-user-insights.field.filters', format: 'string' }
        ]
    },

    // =========================================================================
    // CATALOG & CONTENT (TT Analytics Tracking Standard v1)
    // =========================================================================
    {
        key: 'product_viewed',
        category: 'catalog',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'eye',
        titleKey: 'tt-user-insights.event.product_viewed.title',
        descriptionKey: 'tt-user-insights.event.product_viewed.description',
        detailsKey: 'tt-user-insights.event.product_viewed.details',
        fields: [
            { prop: 'name', aliases: ['product_name', 'title'], labelKey: 'tt-user-insights.field.name', format: 'string', primary: true },
            { prop: 'sku', aliases: ['product_sku', 'code'], labelKey: 'tt-user-insights.field.sku', format: 'string', detail: true },
            { prop: 'product_id', aliases: ['item_id', 'id'], labelKey: 'tt-user-insights.field.product_id', format: 'string' },
            { prop: 'category', aliases: ['product_category'], labelKey: 'tt-user-insights.field.category', format: 'string' },
            { prop: 'brand', aliases: ['manufacturer'], labelKey: 'tt-user-insights.field.brand', format: 'string' },
            { prop: 'price', aliases: ['unit_price'], labelKey: 'tt-user-insights.field.price', format: 'currency' },
            { prop: 'currency', labelKey: 'tt-user-insights.field.currency', format: 'string' }
        ]
    },
    {
        key: 'content_viewed',
        category: 'catalog',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'file-text',
        titleKey: 'tt-user-insights.event.content_viewed.title',
        descriptionKey: 'tt-user-insights.event.content_viewed.description',
        detailsKey: 'tt-user-insights.event.content_viewed.details',
        fields: [
            { prop: 'title', aliases: ['name', 'content_title'], labelKey: 'tt-user-insights.field.title', format: 'string', primary: true },
            { prop: 'content_id', aliases: ['id', 'slug'], labelKey: 'tt-user-insights.field.content_id', format: 'string', detail: true },
            { prop: 'content_type', aliases: ['type'], labelKey: 'tt-user-insights.field.content_type', format: 'string' },
            { prop: 'category', labelKey: 'tt-user-insights.field.category', format: 'string' }
        ]
    },
    {
        key: 'filter_applied',
        category: 'catalog',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'filter',
        titleKey: 'tt-user-insights.event.filter_applied.title',
        descriptionKey: 'tt-user-insights.event.filter_applied.description',
        detailsKey: 'tt-user-insights.event.filter_applied.details',
        fields: [
            { prop: 'filter_name', aliases: ['filter', 'type', 'facet'], labelKey: 'tt-user-insights.field.filter_name', format: 'string', primary: true },
            { prop: 'filter_value', aliases: ['value', 'selected'], labelKey: 'tt-user-insights.field.filter_value', format: 'string', primary: true },
            { prop: 'category', labelKey: 'tt-user-insights.field.category', format: 'string' },
            { prop: 'results_count', aliases: ['count'], labelKey: 'tt-user-insights.field.results_count', format: 'integer', detail: true }
        ]
    },

    // =========================================================================
    // CART (TT Analytics Tracking Standard v1)
    // =========================================================================
    {
        key: 'cart_created',
        category: 'cart',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'shopping-bag',
        titleKey: 'tt-user-insights.event.cart_created.title',
        descriptionKey: 'tt-user-insights.event.cart_created.description',
        detailsKey: 'tt-user-insights.event.cart_created.details',
        fields: [
            { prop: 'cart_id', aliases: ['id'], labelKey: 'tt-user-insights.field.cart_id', format: 'string', primary: true },
            { prop: 'currency', labelKey: 'tt-user-insights.field.currency', format: 'string' }
        ]
    },
    {
        key: 'product_added_to_cart',
        category: 'cart',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'plus-circle',
        titleKey: 'tt-user-insights.event.product_added_to_cart.title',
        descriptionKey: 'tt-user-insights.event.product_added_to_cart.description',
        detailsKey: 'tt-user-insights.event.product_added_to_cart.details',
        fields: [
            { prop: 'sku', aliases: ['product_sku', 'item_id'], labelKey: 'tt-user-insights.field.sku', format: 'string', primary: true },
            { prop: 'name', aliases: ['product_name'], labelKey: 'tt-user-insights.field.name', format: 'string' },
            { prop: 'product_id', labelKey: 'tt-user-insights.field.product_id', format: 'string' },
            { prop: 'quantity', aliases: ['qty'], labelKey: 'tt-user-insights.field.quantity', format: 'integer', detail: true },
            { prop: 'cart_id', labelKey: 'tt-user-insights.field.cart_id', format: 'string' },
            { prop: 'price', aliases: ['unit_price'], labelKey: 'tt-user-insights.field.price', format: 'currency' },
            { prop: 'currency', labelKey: 'tt-user-insights.field.currency', format: 'string' }
        ]
    },
    {
        key: 'product_removed_from_cart',
        category: 'cart',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'minus-circle',
        titleKey: 'tt-user-insights.event.product_removed_from_cart.title',
        descriptionKey: 'tt-user-insights.event.product_removed_from_cart.description',
        detailsKey: 'tt-user-insights.event.product_removed_from_cart.details',
        fields: [
            { prop: 'sku', aliases: ['product_sku', 'item_id'], labelKey: 'tt-user-insights.field.sku', format: 'string', primary: true },
            { prop: 'name', aliases: ['product_name'], labelKey: 'tt-user-insights.field.name', format: 'string' },
            { prop: 'product_id', labelKey: 'tt-user-insights.field.product_id', format: 'string' },
            { prop: 'quantity', aliases: ['qty'], labelKey: 'tt-user-insights.field.quantity', format: 'integer', detail: true },
            { prop: 'cart_id', labelKey: 'tt-user-insights.field.cart_id', format: 'string' },
            { prop: 'price', aliases: ['unit_price'], labelKey: 'tt-user-insights.field.price', format: 'currency' }
        ]
    },

    // =========================================================================
    // ORDER & CHECKOUT (TT Analytics Tracking Standard v1)
    // =========================================================================
    {
        key: 'checkout_started',
        category: 'order',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'credit-card',
        titleKey: 'tt-user-insights.event.checkout_started.title',
        descriptionKey: 'tt-user-insights.event.checkout_started.description',
        detailsKey: 'tt-user-insights.event.checkout_started.details',
        fields: [
            { prop: 'cart_id', labelKey: 'tt-user-insights.field.cart_id', format: 'string', primary: true },
            { prop: 'products_count', aliases: ['items_count', 'quantity'], labelKey: 'tt-user-insights.field.products_count', format: 'integer', detail: true },
            { prop: 'amount', aliases: ['total', 'value'], labelKey: 'tt-user-insights.field.amount', format: 'currency', detail: true },
            { prop: 'currency', labelKey: 'tt-user-insights.field.currency', format: 'string' }
        ]
    },
    {
        key: 'order_submitted',
        category: 'order',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'shopping-cart',
        titleKey: 'tt-user-insights.event.order_submitted.title',
        descriptionKey: 'tt-user-insights.event.order_submitted.description',
        detailsKey: 'tt-user-insights.event.order_submitted.details',
        fields: [
            { prop: 'order_id', aliases: ['id', 'order_number'], labelKey: 'tt-user-insights.field.order_id', format: 'string', primary: true },
            { prop: 'amount', aliases: ['total', 'revenue'], labelKey: 'tt-user-insights.field.amount', format: 'currency', detail: true },
            { prop: 'products_count', aliases: ['items_count', 'quantity'], labelKey: 'tt-user-insights.field.products_count', format: 'integer' },
            { prop: 'currency', labelKey: 'tt-user-insights.field.currency', format: 'string' },
            { prop: 'customer_type', aliases: ['segment', 'b2b_tier'], labelKey: 'tt-user-insights.field.customer_type', format: 'string' }
        ]
    },
    {
        key: 'order_status_viewed',
        category: 'order',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'package',
        titleKey: 'tt-user-insights.event.order_status_viewed.title',
        descriptionKey: 'tt-user-insights.event.order_status_viewed.description',
        detailsKey: 'tt-user-insights.event.order_status_viewed.details',
        fields: [
            { prop: 'order_id', aliases: ['id', 'order_number'], labelKey: 'tt-user-insights.field.order_id', format: 'string', primary: true },
            { prop: 'status', aliases: ['order_status'], labelKey: 'tt-user-insights.field.status', format: 'string', detail: true }
        ]
    },

    // =========================================================================
    // ERRORS (TT Analytics Tracking Standard v1 + Countly Crash / Error Reports)
    // =========================================================================
    {
        key: 'application_error',
        category: 'error',
        recordType: 'TT_BUSINESS_EVENT',
        eventType: 'business',
        icon: 'alert-triangle',
        titleKey: 'tt-user-insights.event.application_error.title',
        descriptionKey: 'tt-user-insights.event.application_error.description',
        detailsKey: 'tt-user-insights.event.application_error.details',
        fields: [
            { prop: 'error_message', aliases: ['message', 'error', 'reason'], labelKey: 'tt-user-insights.field.error_message', format: 'string', primary: true },
            { prop: 'error_code', aliases: ['code', 'status_code', 'http_status'], labelKey: 'tt-user-insights.field.error_code', format: 'string', detail: true },
            { prop: 'error_type', aliases: ['type', 'name'], labelKey: 'tt-user-insights.field.error_type', format: 'string' },
            { prop: 'screen', aliases: ['view', 'page'], labelKey: 'tt-user-insights.field.view_name', format: 'string' },
            { prop: 'fatal', labelKey: 'tt-user-insights.field.fatal', format: 'boolean' }
        ]
    },
    {
        key: '[CLY]_crash',
        category: 'error',
        recordType: 'CUSTOM_EVENT',
        eventType: 'system',
        icon: 'alert-octagon',
        titleKey: 'tt-user-insights.event.cly_crash.title',
        descriptionKey: 'tt-user-insights.event.cly_crash.description',
        detailsKey: 'tt-user-insights.event.cly_crash.details',
        fields: [
            { prop: 'name', aliases: ['error', 'message'], labelKey: 'tt-user-insights.field.error_message', format: 'string', primary: true },
            { prop: 'type', labelKey: 'tt-user-insights.field.error_type', format: 'string', detail: true },
            { prop: 'view', labelKey: 'tt-user-insights.field.view_name', format: 'string' },
            { prop: 'nonfatal', labelKey: 'tt-user-insights.field.nonfatal', format: 'boolean' }
        ]
    },

    // =========================================================================
    // NAVIGATION, VIEWS & SESSIONS (Countly Native SDK Events)
    // =========================================================================
    {
        key: '[CLY]_view',
        category: 'navigation',
        recordType: 'VIEW',
        eventType: 'system',
        icon: 'layout',
        titleKey: 'tt-user-insights.event.cly_view.title',
        descriptionKey: 'tt-user-insights.event.cly_view.description',
        detailsKey: 'tt-user-insights.event.cly_view.details',
        fields: [
            { prop: 'name', aliases: ['view', 'page'], labelKey: 'tt-user-insights.field.view_name', format: 'string', primary: true },
            { prop: 'segment', aliases: ['platform'], labelKey: 'tt-user-insights.field.platform', format: 'string' }
        ]
    },
    {
        key: '[CLY]_session_begin',
        category: 'navigation',
        recordType: 'SESSION',
        eventType: 'system',
        icon: 'play-circle',
        titleKey: 'tt-user-insights.event.session_begin.title',
        descriptionKey: 'tt-user-insights.event.session_begin.description',
        detailsKey: 'tt-user-insights.event.session_begin.details',
        fields: []
    },
    {
        key: '[CLY]_session_end',
        category: 'navigation',
        recordType: 'SESSION',
        eventType: 'system',
        icon: 'stop-circle',
        titleKey: 'tt-user-insights.event.session_end.title',
        descriptionKey: 'tt-user-insights.event.session_end.description',
        detailsKey: 'tt-user-insights.event.session_end.details',
        fields: [
            { prop: 'duration', labelKey: 'tt-user-insights.field.duration', format: 'integer', detail: true }
        ]
    },
    {
        key: '[CLY]_action',
        category: 'navigation',
        recordType: 'CUSTOM_EVENT',
        eventType: 'system',
        icon: 'mouse-pointer',
        titleKey: 'tt-user-insights.event.cly_action.title',
        descriptionKey: 'tt-user-insights.event.cly_action.description',
        detailsKey: 'tt-user-insights.event.cly_action.details',
        fields: [
            { prop: 'type', labelKey: 'tt-user-insights.field.action_type', format: 'string', primary: true },
            { prop: 'view', aliases: ['url'], labelKey: 'tt-user-insights.field.url', format: 'string', detail: true }
        ]
    }
];

module.exports = {
    INITIAL_CATEGORIES: INITIAL_CATEGORIES,
    INITIAL_BUSINESS_EVENTS: INITIAL_BUSINESS_EVENTS
};
