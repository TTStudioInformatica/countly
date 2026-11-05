'use strict';

/**
 * Plugin installation script for tt-user-insights.
 * Ensures compound indexes exist on all existing Countly apps without modifying Countly core schemas.
 */
var async = require('async');
var pluginManager = require('../pluginManager.js');
var repository = require('./api/lib/repository.js');

console.log('Installing tt-user-insights plugin...');

var countlyDb = pluginManager.dbConnection();

countlyDb.collection('apps').find({}).toArray(function(err, apps) {
    if (err || !apps || !apps.length) {
        if (err) {
            console.error('Error fetching apps during tt-user-insights install:', err);
        }
        console.log('tt-user-insights plugin installed.');
        countlyDb.close();
        return;
    }

    function upgradeApp(app, done) {
        console.log('Ensuring tt-user-insights indexes for ' + app.name + ' (' + app._id + ')');
        repository.ensureIndexesForApp(countlyDb, app._id, function(indexErr) {
            if (indexErr) {
                console.error('Warning ensuring indexes for app ' + app._id + ':', indexErr);
            }
            done();
        });
    }

    async.forEach(apps, upgradeApp, function() {
        console.log('tt-user-insights plugin installed successfully.');
        countlyDb.close();
    });
});

