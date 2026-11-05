'use strict';

/**
 * Plugin uninstallation script for tt-user-insights.
 * Drops the plugin-owned per-app collections (app_tt_user_events{app_id}) while leaving
 * Countly core collections (app_users{app_id}, events_data{app_id}, etc.) intact.
 */
var async = require('async');
var pluginManager = require('../pluginManager.js');
var repository = require('./api/lib/repository.js');

console.log('Uninstalling tt-user-insights plugin...');

var countlyDb = pluginManager.dbConnection();

countlyDb.collection('apps').find({}).toArray(function(err, apps) {
    if (err || !apps || !apps.length) {
        console.log('tt-user-insights plugin uninstalled.');
        countlyDb.close();
        return;
    }

    function cleanApp(app, done) {
        console.log('Removing tt-user-insights timeline collection for ' + app.name);
        repository.dropAppData(countlyDb, app._id, function() {
            done();
        });
    }

    async.forEach(apps, cleanApp, function() {
        console.log('tt-user-insights plugin uninstalled successfully.');
        countlyDb.close();
    });
});

