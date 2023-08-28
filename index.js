'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = new (require('v-conf'))();
var superagent = require('superagent');
var os = require('os');
var websocket = require('ws');
var path = require('path');
var SpotifyWebApi = require('spotify-web-api-node');

// Define the ControllerSpotify class
module.exports = ControllerSpotify;

function ControllerSpotify(context) {
    // This fixed variable will let us refer to 'this' object at deeper scopes
    var self = this;

    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;

    this.state = {
        status: 'stop',
        service: 'spop',
        title: '',
        artist: '',
        album: '',
        albumart: '/albumart',
        uri: '',
        // icon: 'fa fa-spotify',
        trackType: 'spotify',
        seek: 0,
        duration: 0,
        samplerate: '',
        bitdepth: '16 bit',
        bitrate: '',
        channels: 2
    };
}


ControllerSpotify.prototype.onVolumioStart = function () {
    var self = this;
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    return libQ.resolve();
}

ControllerSpotify.prototype.getConfigurationFiles = function () {
    return ['config.json'];
}

ControllerSpotify.prototype.onStop = function () {
    var self = this;
    var defer = libQ.defer();

    defer.resolve();
    return defer.promise;
};

ControllerSpotify.prototype.onStart = function () {
    var self = this;
    var defer = libQ.defer();
    self.initializeWsConnection();
    defer.resolve();
    return defer.promise;
};


ControllerSpotify.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;

    var lang_code = self.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function (uiconf) {
            defer.resolve(uiconf);
        })
        .fail(function (error) {
            self.logger.error('Cannot populate Spotify configuration: ' + error);
            defer.reject(new Error());
        });

    return defer.promise;
};

// Controls

ControllerSpotify.prototype.initializeWsConnection = function () {
    var self = this;

    // This is the websocket event listener for the Spotify service
    var ws = new websocket('ws://localhost:9876/events');
    ws.on('error', function(error){
        console.error(error);
    });

    ws.on('message', function message(data) {
        console.log('received: %s', data);
        self.parseEventState(JSON.parse(data));
    });
};

ControllerSpotify.prototype.parseEventState = function (event) {
    var self = this;

    // create a switch case which handles types of events
// and updates the state accordingly
    switch (event.type) {
        case 'track':
            self.state.title = event.data.name;
            break;
        case 'playing':
            self.state.status = 'play';
            break;
        case 'paused':
            self.state.status = 'pause';
            break;
        case 'seek':
            self.state.seek = event.data.seek;
        break;
        default:
            self.logger.error('Failed to decode event: ' + event.type);
            break;
    }
    self.pushState(self.state);
};

ControllerSpotify.prototype.getState = function () {
    var self = this;

    return self.state;
};

// Announce updated Spop state
ControllerSpotify.prototype.pushState = function (state) {
    var self = this;

    return self.commandRouter.servicePushState(self.state, 'spop');
};


ControllerSpotify.prototype.pause = function () {
    this.logger.info('Spotify Received pause');

    // to implement
};

ControllerSpotify.prototype.play = function () {
    this.logger.info('Spotify Play');

    // to implement
};

ControllerSpotify.prototype.resume = function () {
    this.logger.info('Spotify Resume');

    // to implement
};

ControllerSpotify.prototype.next = function () {
    this.logger.info('Spotify next');
    // to implement
};

ControllerSpotify.prototype.previous = function () {
    this.logger.info('Spotify previous');
    // to implement
};

ControllerSpotify.prototype.seek = function (position) {
    this.logger.info('Spotify seek to: ' + position);
    // to implement
};

ControllerSpotify.prototype.random = function (value) {
    this.logger.info('Spotify Random: ' + value);

    // to implement

};

ControllerSpotify.prototype.repeat = function (value, repeatSingle) {
    // to implement
};
