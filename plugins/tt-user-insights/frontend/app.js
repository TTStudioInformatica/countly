'use strict';

/**
 * Frontend Express module entry point for tt-user-insights.
 * Follows standard Countly plugin lifecycle (`plugin.init(app, countlyDb, express)`).
 */
(function(plugin) {
    plugin.init = function() {
        // Static assets in frontend/public/ are automatically served by Countly's pluginManager
        // under /tt-user-insights/* and bundled by Grunt.
    };
})(module.exports);

