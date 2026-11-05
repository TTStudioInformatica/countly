'use strict';

/**
 * Default configuration for tt-user-insights plugin.
 * Loaded by Countly pluginManager and optionally customizable via Countly configuration.
 */
var ttUserInsightsConfig = {
    // Enable storing individual user events in app_tt_user_events{app_id}
    store_user_events: true,
    // Enable storing session begin/end/duration milestones in timeline
    track_sessions: true,
    // Enable capturing Countly crash/non-fatal error reports ([CLY]_crash) in timeline
    track_crashes: true,
    // Enable syncing SDK user_details (name, email, username, custom) into app_users{app_id}
    sync_user_details: true,
    // Maximum number of items returned per page in API responses
    max_page_size: 100,
    // Default page size for user search and timeline APIs
    default_page_size: 25,
    // Maximum number of segmentation keys persisted per single event to prevent document bloat
    max_segmentation_keys: 50,
    // Maximum length of a single string value in event segmentation
    max_string_length: 1000,
    // Privacy & PII Redaction configuration:
    // Any event segmentation property or custom user property matching these keys (case-insensitive)
    // or built-in sensitive patterns (passwords, tokens, authorization headers, payment cards)
    // will be automatically masked with `redaction_placeholder`.
    redact_pii: true,
    redaction_placeholder: '[REDACTED]',
    redacted_properties: [
        'password',
        'passwd',
        'pwd',
        'passcode',
        'secret',
        'client_secret',
        'api_key',
        'apikey',
        'token',
        'access_token',
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'csrf_token',
        'jwt',
        'authorization',
        'auth_header',
        'cookie',
        'set_cookie',
        'credit_card',
        'card_number',
        'pan',
        'cvv',
        'cvc',
        'ccv',
        'security_code',
        'iban',
        'bic',
        'pin',
        'ssn',
        'tax_id',
        'codice_fiscale',
        'private_key'
    ]
};

module.exports = ttUserInsightsConfig;
