'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = new (require('v-conf'))();
var superagent = require('superagent');
var os = require('os');
var websocket = require('ws');
var path = require('path');
var SpotifyWebApi = require('spotify-web-api-node');
var io = require('socket.io-client');
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;
var NodeCache = require('node-cache');

var spotifyLocalApiEndpointBase = 'http://127.0.0.1:9876';
var stateSocket = undefined;
var currentSpotifyVolume = undefined;
var selectedBitrate;

// Debug
var isDebugMode = false;

// Define the ControllerSpotify class
module.exports = ControllerSpotify;

function ControllerSpotify(context) {
    // This fixed variable will let us refer to 'this' object at deeper scopes
    var self = this;

    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;
    this.isSpotifyPlayingInVolatileMode = false;
    this.resetSpotifyState();
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
    self.stopLibrespotDaemon();
    defer.resolve();
    return defer.promise;
};

ControllerSpotify.prototype.onStart = function () {
    var self = this;
    var defer = libQ.defer();

    self.loadI18n();
    self.browseCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
    self.initializeLibrespotDaemon();
    self.initializeSpotifyBrowsingFacility();
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
        self.logger.info('Error connecting to go-librespot Websocket: ' + error);
        setTimeout(()=>{
            self.logger.info('Trying to reconnect to go-librespot Websocket');
            self.initializeWsConnection();
        }, 2000);
    });

    ws.on('message', function message(data) {
        console.log('received: %s', data);
        self.parseEventState(JSON.parse(data));
    });

    ws.on('open', function () {
        self.initializeSpotifyControls();
    });
};

ControllerSpotify.prototype.initializeSpotifyControls = function () {
    var self = this;

    self.resetSpotifyState();
    self.startSocketStateListener();
};

ControllerSpotify.prototype.resetSpotifyState = function () {
    var self = this;

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
        samplerate: '44.1 KHz',
        bitdepth: '16 bit',
        bitrate: '',
        channels: 2
    };
};

ControllerSpotify.prototype.parseEventState = function (event) {
    var self = this;

    // create a switch case which handles types of events
    // and updates the state accordingly
    switch (event.type) {
        case 'track':
            self.state.title = event.data.name;
            self.state.duration = self.parseDuration(event.data.duration);
            self.state.uri = event.data.uri;
            self.state.artist = self.parseArtists(event.data.artist_names);
            self.state.album = event.data.album_name;
            self.state.albumart = event.data.album_cover_url;
            break;
        case 'playing':
            self.state.status = 'play';
            break;
        case 'paused':
            self.state.status = 'pause';
            break;
        case 'seek':
            self.state.seek = event.data.position;
        break;
        case 'volume':
            try {
                var spotifyLastVolume = parseInt(event.data.value*100);
                self.commandRouter.volumiosetvolume(spotifyLastVolume);
            } catch(e) {
                self.logger.error('Failed to parse Spotify volume event: ' + e);
            }
            break;
        default:
            self.logger.error('Failed to decode event: ' + event.type);
            break;
    }

    if (self.isSpotifyPlayingInVolatileMode) {
        self.pushState(self.state);
    } else {
        self.initializeSpotifyPlaybackInVolatileMode();
    }
};

ControllerSpotify.prototype.initializeSpotifyPlaybackInVolatileMode = function () {
    var self = this;

    self.context.coreCommand.stateMachine.setConsumeUpdateService(undefined);
    self.context.coreCommand.stateMachine.setVolatile({
        service: 'spop',
        callback: self.spotConnUnsetVolatile()
    });

    setTimeout(()=>{
        self.isSpotifyPlayingInVolatileMode = true;
        self.pushState(self.state);
    }, 100)
};

ControllerSpotify.prototype.parseDuration = function (spotifyDuration) {
    var self = this;

    try {
        return parseInt(spotifyDuration/1000);
    } catch(e) {
        return 0;
    }
}

ControllerSpotify.prototype.getCurrentBitrate = function () {
    var self = this;

    return self.selectedBitrate + ' kbps';
}

ControllerSpotify.prototype.parseArtists = function (spotifyArtists) {
    var self = this;

    var artist = '';
    if (spotifyArtists.length > 0) {
        for (var i in spotifyArtists) {
            if (!artist.length) {
                artist = spotifyArtists[i];
            } else {
                artist = artist + ', ' + spotifyArtists[i];
            }
        }
        return artist;
    } else {
        return spotifyArtists;
    }
}


ControllerSpotify.prototype.spotConnUnsetVolatile = function () {
    var self = this;

    console.log('UNSET VOLATILE');

    return this.stop();
}

ControllerSpotify.prototype.getState = function () {
    var self = this;

    return self.state;
};

// Announce updated Spop state
ControllerSpotify.prototype.pushState = function (state) {
    var self = this;

    self.state.bitrate = self.getCurrentBitrate();
    return self.commandRouter.servicePushState(self.state, 'spop');
};

ControllerSpotify.prototype.sendSpotifyLocalApiCommand = function (commandPath) {
    this.logger.info('Sending Spotify command to local API: ' + commandPath);

    superagent.post(spotifyLocalApiEndpointBase + commandPath)
        .accept('application/json')
        .then((results) => {})
        .catch((error) => {
            this.logger.error('Failed to send command to Spotify local API: ' + commandPath  + ': ' + error);
        });
};

ControllerSpotify.prototype.sendSpotifyLocalApiCommandWithPayload = function (commandPath, payload) {
    this.logger.info('Sending Spotify command with payload to local API: ' + commandPath);

    superagent.post(spotifyLocalApiEndpointBase + commandPath)
        .accept('application/json')
        .send(payload)
        .then((results) => {})
        .catch((error) => {
            this.logger.error('Failed to send command to Spotify local API: ' + commandPath  + ': ' + error);
        });
};


ControllerSpotify.prototype.pause = function () {
    this.logger.info('Spotify Received pause');

    this.sendSpotifyLocalApiCommand('/player/pause');
};

ControllerSpotify.prototype.play = function () {
    this.logger.info('Spotify Play');

    if (this.state.status === 'pause') {
        this.sendSpotifyLocalApiCommand('/player/resume');
    } else {
        this.sendSpotifyLocalApiCommand('/player/play');
    }

};

ControllerSpotify.prototype.stop = function () {
    this.logger.info('Spotify Stop');

    this.sendSpotifyLocalApiCommand('/player/pause');
};


ControllerSpotify.prototype.resume = function () {
    this.logger.info('Spotify Resume');

    this.sendSpotifyLocalApiCommand('/player/resume');
};

ControllerSpotify.prototype.next = function () {
    this.logger.info('Spotify next');

    this.sendSpotifyLocalApiCommand('/player/next');
};

ControllerSpotify.prototype.previous = function () {
    this.logger.info('Spotify previous');

    this.sendSpotifyLocalApiCommand('/player/prev');
};

ControllerSpotify.prototype.seek = function (position) {
    this.logger.info('Spotify seek to: ' + position);

    this.sendSpotifyLocalApiCommandWithPayload('/player/seek', { position: position });
};

ControllerSpotify.prototype.setSpotifyVolume = function (volumioVolume) {
    this.logger.info('Spotify volume to: ' + volumioVolume);

    this.currentSpotifyVolume = volumioVolume;
    this.sendSpotifyLocalApiCommandWithPayload('/player/volume', { volume: volumioVolume / 100 });
};

ControllerSpotify.prototype.random = function (value) {
    this.logger.info('Spotify Random: ' + value);

    // to implement

};

ControllerSpotify.prototype.repeat = function (value, repeatSingle) {
    // to implement
};

ControllerSpotify.prototype.startSocketStateListener = function () {
    var self = this;

    if (self.stateSocket) {
        self.stateSocket.off();
        self.stateSocket.disconnect();
    }

    self.stateSocket= io.connect('http://localhost:3000');
    self.stateSocket.on('connect', function() {
        self.stateSocket.emit('getState', '');
    });

    self.stateSocket.on('pushState', function (data) {
       if (data && data.volume && data.volume !== self.currentSpotifyVolume) {
           var currentVolume = data.volume;
           if (data.mute === true) {
               currentVolume = 0;
           }
           // TODO FIX THIS, AS USUAL
           //self.logger.info('Aligning Spotify Volume to: ' + currentVolume);
           //self.setSpotifyVolume(currentVolume);
       }
    });
};

ControllerSpotify.prototype.stopSocketStateListener = function () {
    var self = this;

    if (self.stateSocket) {
        self.stateSocket.off();
        self.stateSocket.disconnect();
    }
};


// DAEMON MANAGEMENT

ControllerSpotify.prototype.initializeLibrespotDaemon = function () {
    var self = this;
    var defer = libQ.defer();

    this.selectedBitrate = self.config.get('bitrate_number', '320').toString();

    self.createConfigFile()
        .then(self.startLibrespotDaemon())
        .then(self.initializeWsConnection())
        .then(function () {
            self.logger.info('go-librespot daemon successfully initialized');
            defer.resolve();
        })
        .fail(function (e) {
            defer.reject(e);
            self.logger.error('Error initializing go-librespot daemon: ' + e);
        });

    return defer.promise;
};

ControllerSpotify.prototype.startLibrespotDaemon = function () {
    var self = this;
    var defer = libQ.defer();

    exec("/usr/bin/sudo systemctl restart go-librespot-daemon.service", function (error, stdout, stderr) {
        if (error) {
            self.logger.error('Cannot start Go-librespot Daemon');
            defer.reject(new Error(error));
        } else {
            setTimeout(()=>{
                defer.resolve();
            }, 2000)}
    });

    return defer.promise;

};

ControllerSpotify.prototype.stopLibrespotDaemon = function () {
    var self = this;
    var defer = libQ.defer();

    exec("/usr/bin/sudo systemctl stop go-librespot-daemon.service", function (error, stdout, stderr) {
        if (error) {
            self.logger.error('Cannot stop Go-librespot Daemon');
            defer.reject(new Error(error));
        } else {
            setTimeout(()=>{
                defer.resolve();
            }, 2000)}
    });

    return defer.promise;
};


ControllerSpotify.prototype.createConfigFile = function () {
    var self = this;
    var defer = libQ.defer();

    this.logger.info('Creating Spotify config file');

    var configFileDestinationPath = '/home/volumio/new-spotify-plugin/librespot-go/go-librespot/config.yml';

    try {
        var template = fs.readFileSync(path.join(__dirname, 'config.yml.tmpl'), {encoding: 'utf8'});
    } catch (e) {
        this.logger.error('Failed to read template file: ' + e);
    }

    var devicename = this.commandRouter.sharedVars.get('system.name');
    var selectedBitrate = self.config.get('bitrate_number', '320').toString();
    var icon = self.config.get('icon', 'avr')

    const conf = template.replace('${device_name}', devicename)
        .replace('${bitrate_number}', selectedBitrate)
        .replace('${device_type}', icon);

    fs.writeFile(configFileDestinationPath, conf, (err) => {
        if (err) {
            defer.reject(err);
            this.logger.error('Failed to write spotify config file: ' + err);
        } else {
            defer.resolve('');
            this.logger.info('Spotify config file written');
        }
    });
    return defer.promise;
};

ControllerSpotify.prototype.saveGoLibrespotSettings = function (data, avoidBroadcastUiConfig) {
    var self = this;
    var defer = libQ.defer();

    var broadcastUiConfig = true;
    if (avoidBroadcastUiConfig === true){
        broadcastUiConfig = false;
    }

    if (data.bitrate !== undefined && data.bitrate.value !== undefined) {
        self.config.set('bitrate_number', data.bitrate.value);
    }

    if (data.debug !== undefined) {
        self.config.set('debug', data.debug);
    }
    if (data.icon && data.icon.value !== undefined) {
        self.config.set('icon', data.icon.value);
    }


    self.selectedBitrate = self.config.get('bitrate_number', '320').toString();
    self.initializeLibrespotDaemon();

    return defer.promise;
};

// OAUTH

ControllerSpotify.prototype.refreshAccessToken = function () {
    var self = this;
    var defer = libQ.defer();

    var refreshToken = self.config.get('refresh_token', 'none');
    if (refreshToken !== 'none' && refreshToken !== null && refreshToken !== undefined) {
        superagent.post('https://oauth-performer.dfs.volumio.org/spotify/accessToken')
            .send({refreshToken: refreshToken})
            .then(function (results) {
                if (results && results.body && results.body.accessToken) {
                    defer.resolve(results)
                } else {
                    defer.resject('No access token received');
                }
            })
            .catch(function (err) {
                self.logger.info('An error occurred while refreshing Spotify Token ' + err);
            });
    }

    return defer.promise;
};

ControllerSpotify.prototype.spotifyClientCredentialsGrant = function () {
    var self = this;
    var defer = libQ.defer();
    var d = new Date();
    var now = d.getTime();

    var refreshToken = self.config.get('refresh_token', 'none');
    if (refreshToken !== 'none' && refreshToken !== null && refreshToken !== undefined) {
        self.spotifyApi.setRefreshToken(refreshToken);
        self.refreshAccessToken()
            .then(function (data) {
                self.spotifyAccessToken = data.body['accessToken'];
                console.log('------------------------------------------------------ ACCESS TOKEN ------------------------------------------------------');
                console.log(self.spotifyAccessToken);
                console.log('------------------------------------------------------ ACCESS TOKEN ------------------------------------------------------');
                self.spotifyApi.setAccessToken(self.spotifyAccessToken);
                self.spotifyAccessTokenExpiration = data.body['expiresInSeconds'] * 1000 + now;
                self.logger.info('New Spotify access token = ' + self.spotifyAccessToken);
                defer.resolve();
            }, function (err) {
                self.logger.info('Spotify credentials grant failed with ' + err);
            });
    }

    return defer.promise;
}

ControllerSpotify.prototype.oauthLogin = function (data) {
    var self=this;
    console.log(JSON.stringify(data));
    if (data && data.refresh_token) {
        self.logger.info('Saving Spotify Refresh Token');
        self.config.set('refresh_token', data.refresh_token);
        self.initializeSpotifyBrowsingFacility();

        var config = self.getUIConfig();
        config.then(function(conf) {
            self.commandRouter.broadcastMessage('pushUiConfig', conf);
            self.commandRouter.broadcastMessage('closeAllModals', '');
            defer.resolve(conf)
        });

    } else {
        self.logger.error('Could not receive oauth data');
    }
};

ControllerSpotify.prototype.externalOauthLogin = function (data) {
    var self=this;
    var defer = libQ.defer();

    if (data && data.refresh_token) {
        self.logger.info('Saving Spotify Refresh Token');
        self.config.set('refresh_token', data.refresh_token);
        self.spopDaemonConnect();
        setTimeout(()=>{
            defer.resolve('');
        },150);
    } else {
        self.logger.error('Could not receive oauth data');
        defer.resolve('');
    }
    return defer.promise
};

ControllerSpotify.prototype.spotifyApiConnect = function () {
    var self = this;
    var defer = libQ.defer();
    var d = new Date();

    self.spotifyApi = new SpotifyWebApi();

    // Retrieve an access token
    self.spotifyClientCredentialsGrant()
        .then(function (data) {
                self.logger.info('Spotify credentials grant success - running version from March 24, 2019');
                defer.resolve();
            }, function (err) {
                self.logger.info('Spotify credentials grant failed with ' + err);
                defer.reject(err);
            }
        );

    return defer.promise;
}

ControllerSpotify.prototype.refreshAccessToken = function () {
    var self = this;
    var defer = libQ.defer();

    var refreshToken = self.config.get('refresh_token', 'none');
    if (refreshToken !== 'none' && refreshToken !== null && refreshToken !== undefined) {
        superagent.post('https://oauth-performer.dfs.volumio.org/spotify/accessToken')
            .send({refreshToken: refreshToken})
            .then(function (results) {
                if (results && results.body && results.body.accessToken) {
                    defer.resolve(results)
                } else {
                    defer.resject('No access token received');
                }
            })
            .catch(function (err) {
                self.logger.info('An error occurred while refreshing Spotify Token ' + err);
            });
    }

    return defer.promise;
};

ControllerSpotify.prototype.spotifyCheckAccessToken = function () {
    var self = this;
    var defer = libQ.defer();
    var d = new Date();
    var now = d.getTime();

    if (self.spotifyAccessTokenExpiration < now) {
        self.refreshAccessToken()
            .then(function (data) {
                self.spotifyAccessToken = data.body.accessToken;
                self.spotifyApi.setAccessToken(data.body.accessToken);
                self.spotifyAccessTokenExpiration = data.body.expiresInSeconds * 1000 + now;
                self.logger.info('New access token = ' + self.spotifyAccessToken);
                defer.resolve();
            });
    } else {
        defer.resolve();
    }

    return defer.promise;

};

ControllerSpotify.prototype.initializeSpotifyBrowsingFacility = function () {
    var self = this;

    var refreshToken = self.config.get('refresh_token', 'none');
    if (refreshToken !== 'none' && refreshToken !== null && refreshToken !== undefined) {
        self.spotifyApiConnect()
            .then(()=>{
                self.logger.info('Spotify Successfully logged in');
                self.isLoggedIn = true;
                self.getRoot();
                self.addToBrowseSources();
            }).fail(function (err) {
                self.logger.info('An error occurred while initializing Spotify Browsing facility: ' + err);
            });
    }
}

// CACHE

ControllerSpotify.prototype.flushCache = function() {
    var self=this

    self.browseCache.flushAll();
}

// ALBUMART

ControllerSpotify.prototype._getAlbumArt = function (item) {

    var albumart = '';
    if (item.hasOwnProperty('images') && item.images.length > 0) {
        albumart = item.images[0].url;
    }
    return albumart;
};

ControllerSpotify.prototype.getAlbumArt = function (data, path) {

    var artist, album;

    if (data != undefined && data.path != undefined) {
        path = data.path;
    }

    var web;

    if (data != undefined && data.artist != undefined) {
        artist = data.artist;
        if (data.album != undefined)
            album = data.album;
        else album = data.artist;

        web = '?web=' + encodeURIComponent(artist) + '/' + encodeURIComponent(album) + '/large'
    }

    var url = '/albumart';

    if (web != undefined)
        url = url + web;

    if (web != undefined && path != undefined)
        url = url + '&';
    else if (path != undefined)
        url = url + '?';

    if (path != undefined)
        url = url + 'path=' + encodeURIComponent(path);

    return url;
};

// TRANSLATIONS

ControllerSpotify.prototype.loadI18n = function () {
    var self=this;

    try {
        var language_code = this.commandRouter.sharedVars.get('language_code');
        self.i18n=fs.readJsonSync(__dirname+'/i18n/strings_'+language_code+".json");
    } catch(e) {
        self.i18n=fs.readJsonSync(__dirname+'/i18n/strings_en.json');
    }

    self.i18nDefaults=fs.readJsonSync(__dirname+'/i18n/strings_en.json');
};

ControllerSpotify.prototype.getI18n = function (key) {
    var self=this;

    if (key.indexOf('.') > 0) {
        var mainKey = key.split('.')[0];
        var secKey = key.split('.')[1];
        if (self.i18n[mainKey][secKey] !== undefined) {
            return self.i18n[mainKey][secKey];
        } else {
            return self.i18nDefaults[mainKey][secKey];
        }

    } else {
        if (self.i18n[key] !== undefined) {
            return self.i18n[key];
        } else {
            return self.i18nDefaults[key];
        }

    }
};


// BROWSING

ControllerSpotify.prototype.addToBrowseSources = function () {
    var data = {
        name: 'Spotify',
        uri: 'spotify',
        plugin_type: 'music_service',
        plugin_name: 'spop',
        albumart: '/albumart?sourceicon=music_service/spop/spotify.png'
    };
    this.commandRouter.volumioAddToBrowseSources(data);
};

ControllerSpotify.prototype.removeToBrowseSources = function () {

    this.commandRouter.volumioRemoveToBrowseSources('Spotify');
};


ControllerSpotify.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    self.commandRouter.logger.info('In handleBrowseUri, curUri=' + curUri);
    var response;

    if (curUri.startsWith('spotify')) {
        if (curUri == 'spotify') {
            response = self.getRoot();
        } else if (curUri.startsWith('spotify/playlists')) {
            if (curUri == 'spotify/playlists')
                response = self.getMyPlaylists(curUri); // use the Spotify Web API instead of the spop service
            else {
                response = self.listWebPlaylist(curUri); // use the function to list playlists returned from the Spotify Web API
            }
        } else if (curUri.startsWith('spotify/myalbums')) {
            response = self.getMyAlbums(curUri);
        } else if (curUri.startsWith('spotify/mytracks')) {
            response = self.getMyTracks(curUri);
        } else if (curUri.startsWith('spotify/mytopartists')) {
            response = self.getTopArtists(curUri);
        } else if (curUri.startsWith('spotify/mytoptracks')) {
            response = self.getTopTracks(curUri);
        } else if (curUri.startsWith('spotify/myrecentlyplayedtracks')) {
            response = self.getRecentTracks(curUri);
        } else if (curUri.startsWith('spotify/featuredplaylists')) {
            response = self.featuredPlaylists(curUri);
        } else if (curUri.startsWith('spotify:user:')) {
            response = self.listWebPlaylist(curUri);
        } else if (curUri.startsWith('spotify:playlist:')) {
            var uriSplitted = curUri.split(':');
            response = self.listWebPlaylist('spotify:user:spotify:playlist:' + uriSplitted[2]);
        } else if (curUri.startsWith('spotify/new')) {
            response = self.listWebNew(curUri);
        } else if (curUri.startsWith('spotify/categories')) {
            response = self.listWebCategories(curUri);
        } else if (curUri.startsWith('spotify:album')) {
            response = self.listWebAlbum(curUri);
        } else if (curUri.startsWith('spotify/category')) {
            response = self.listWebCategory(curUri);
        } else if (curUri.startsWith('spotify:artist:')) {
            response = self.listWebArtist(curUri);
        }
        else {
            self.logger.info('************* Bad browse Uri:' + curUri);
        }
    }

    return response;
};

ControllerSpotify.prototype.getRoot = function () {
    var self = this;
    var defer = libQ.defer();

    self.browseCache.get('root',function( err, value ){
        if( !err ){
            // Root has not been cached yet
            if(value == undefined){
                self.listRoot().then((data)=>{
                    // Set root cache
                    self.browseCache.set('root',data)
                    defer.resolve(data)
                });
            } else {
                // Cached Root
                defer.resolve(value)
            }
        } else {
            self.logger.error('Could not fetch root spotify folder cached data: ' + err);
        }
    });

    return defer.promise
};

ControllerSpotify.prototype.listRoot = function (curUri) {
    var self = this;
    var defer = libQ.defer();

    var response = {
        navigation: {
            lists: [
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('MY_MUSIC'),
                    "items": [
                        {
                            service: 'spop',
                            type: 'streaming-category',
                            title: self.getI18n('MY_PLAYLISTS'),
                            artist: '',
                            album: '',
                            albumart: '/albumart?sourceicon=music_service/spop/icons/playlist.png',
                            uri: 'spotify/playlists'
                        },
                        {
                            service: 'spop',
                            type: 'streaming-category',
                            title: self.getI18n('MY_ALBUMS'),
                            artist: '',
                            album: '',
                            albumart: '/albumart?sourceicon=music_service/spop/icons/album.png',
                            uri: 'spotify/myalbums'
                        },
                        {
                            service: 'spop',
                            type: 'streaming-category',
                            title: self.getI18n('MY_TRACKS'),
                            artist: '',
                            album: '',
                            albumart: '/albumart?sourceicon=music_service/spop/icons/track.png',
                            uri: 'spotify/mytracks'
                        },
                        {
                            service: 'spop',
                            type: 'streaming-category',
                            title: self.getI18n('MY_TOP_ARTISTS'),
                            artist: '',
                            album: '',
                            albumart: '/albumart?sourceicon=music_service/spop/icons/artist.png',
                            uri: 'spotify/mytopartists'
                        },
                        {
                            service: 'spop',
                            type: 'streaming-category',
                            title: self.getI18n('MY_TOP_TRACKS'),
                            artist: '',
                            album: '',
                            albumart: '/albumart?sourceicon=music_service/spop/icons/track.png',
                            uri: 'spotify/mytoptracks'
                        },
                        {
                            service: 'spop',
                            type: 'streaming-category',
                            title: self.getI18n('MY_RECENTLY_PLAYED_TRACKS'),
                            artist: '',
                            album: '',
                            albumart: '/albumart?sourceicon=music_service/spop/icons/track.png',
                            uri: 'spotify/myrecentlyplayedtracks'
                        }
                    ]
                }
            ]
        }
    }

    var spotifyRootArray = [self.featuredPlaylists('spotify/featuredplaylists'),self.listWebNew('spotify/new'),self.listWebCategories('spotify/categories')];
    libQ.all(spotifyRootArray)
        .then(function (results) {

            var discoveryArray = [
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('FEATURED_PLAYLISTS'),
                    "items": results[0].navigation.lists[0].items
                },
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('WHATS_NEW'),
                    "items": results[1].navigation.lists[0].items
                },
                {
                    "availableListViews": [
                        "grid","list"
                    ],
                    "type": "title",
                    "title": self.getI18n('GENRES_AND_MOODS'),
                    "items": results[2].navigation.lists[0].items
                }
            ];
            response.navigation.lists = response.navigation.lists.concat(discoveryArray);
            defer.resolve(response);
        })
        .fail(function (err) {
            self.logger.info('An error occurred while getting Spotify ROOT Discover Folders: ' + err);
            defer.resolve(response);
        });

    return defer.promise;
}


ControllerSpotify.prototype.getMyPlaylists = function (curUri) {
    var self = this;
    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {


                var response = {
                    navigation: {
                        prev: {
                            uri: 'spotify'
                        },
                        "lists": [
                            {
                                "availableListViews": [
                                    "list",
                                    "grid"
                                ],
                                "items": []
                            }
                        ]
                    }
                };

                superagent.get('https://api.spotify.com/v1/me/playlists')
                    .set("Content-Type", "application/json")
                    .set("Authorization", "Bearer " + self.accessToken)
                    .query({limit: 50})
                    .accept('application/json')
                    .then(function (results) {
                        //  self.logger.info('Playlist result is: ' + JSON.stringify(results.body));
                        for (var i in results.body.items) {
                            var playlist = results.body.items[i];
                            response.navigation.lists[0].items.push({
                                service: 'spop',
                                type: 'playlist',
                                title: playlist.name,
                                albumart: self._getAlbumArt(playlist),
                                uri: 'spotify:user:spotify:playlist:' + playlist.id
                            });
                        }

                        defer.resolve(response);
                    })
                    .catch(function (err) {
                        self.logger.info('An error occurred while listing Spotify getMyPlaylists ' + err.message);
                    });
            }
        );

    return defer.promise;
};

ControllerSpotify.prototype.getMyAlbums = function (curUri) {
    var self = this;
    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
                var spotifyDefer = self.spotifyApi.getMySavedAlbums({limit: 50});
                spotifyDefer.then(function (results) {
                    var response = {
                        navigation: {
                            prev: {
                                uri: 'spotify'
                            },
                            "lists": [
                                {
                                    "availableListViews": [
                                        "list",
                                        "grid"
                                    ],
                                    "items": []
                                }
                            ]
                        }
                    };

                    for (var i in results.body.items) {
                        var album = results.body.items[i].album;
                        response.navigation.lists[0].items.push({
                            service: 'spop',
                            type: 'folder',
                            title: album.name,
                            albumart: self._getAlbumArt(album),
                            uri: album.uri
                        });
                    }
                    defer.resolve(response);
                }, function (err) {
                    self.logger.error('An error occurred while listing Spotify my albums ' + err);
                    self.handleBrowsingError(err);
                    defer.reject('');
                });
            }
        );

    return defer.promise;
};

ControllerSpotify.prototype.getMyTracks = function (curUri) {
    var self = this;
    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
                var spotifyDefer = self.spotifyApi.getMySavedTracks({limit: 50});
                spotifyDefer.then(function (results) {
                    var response = {
                        navigation: {
                            prev: {
                                uri: 'spotify'
                            },
                            "lists": [
                                {
                                    "availableListViews": [
                                        "list"
                                    ],
                                    "items": []
                                }
                            ]
                        }
                    };

                    for (var i in results.body.items) {
                        var track = results.body.items[i].track;
                        if (self.isTrackAvailableInCountry(track)) {
                            response.navigation.lists[0].items.push({
                                service: 'spop',
                                type: 'song',
                                title: track.name,
                                artist: track.artists[0].name || null,
                                album: track.album.name || null,
                                albumart: self._getAlbumArt(track.album),
                                uri: track.uri
                            });
                        }
                    }
                    defer.resolve(response);
                }, function (err) {
                    self.logger.error('An error occurred while listing Spotify my tracks ' + err);
                    self.handleBrowsingError(err);
                    defer.reject('');
                });
            }
        );

    return defer.promise;
};

ControllerSpotify.prototype.getTopArtists = function (curUri) {

    var self = this;

    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
                var spotifyDefer = self.spotifyApi.getMyTopArtists({limit: 50});
                spotifyDefer.then(function (results) {
                    var response = {
                        navigation: {
                            prev: {
                                uri: 'spotify'
                            },
                            "lists": [
                                {
                                    "availableListViews": [
                                        "list",
                                        "grid"
                                    ],
                                    "items": []
                                }
                            ]
                        }
                    };

                    for (var i in results.body.items) {
                        var artist = results.body.items[i];
                        response.navigation.lists[0].items.push({
                            service: 'spop',
                            type: 'folder',
                            title: artist.name,
                            albumart: self._getAlbumArt(artist),
                            uri: artist.uri
                        });
                    }
                    defer.resolve(response);
                }, function (err) {
                    self.logger.error('An error occurred while listing Spotify my artists ' + err);
                    self.handleBrowsingError(err);
                    defer.reject('');
                });
            }
        );

    return defer.promise;
};

ControllerSpotify.prototype.getTopTracks = function (curUri) {

    var self = this;

    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
                var spotifyDefer = self.spotifyApi.getMyTopTracks({limit: 50});
                spotifyDefer.then(function (results) {
                    var response = {
                        navigation: {
                            prev: {
                                uri: 'spotify'
                            },
                            "lists": [
                                {
                                    "availableListViews": [
                                        "list"
                                    ],
                                    "items": []
                                }
                            ]
                        }
                    };

                    for (var i in results.body.items) {
                        var track = results.body.items[i];
                        if (self.isTrackAvailableInCountry(track)) {
                            response.navigation.lists[0].items.push({
                                service: 'spop',
                                type: 'song',
                                title: track.name,
                                artist: track.artists[0].name || null,
                                album: track.album.name || null,
                                albumart: self._getAlbumArt(track.album),
                                uri: track.uri
                            });
                        }
                    }
                    defer.resolve(response);
                }, function (err) {
                    self.logger.error('An error occurred while listing Spotify top tracks ' + err);
                    self.handleBrowsingError(err);
                    defer.reject('');
                });
            }
        );

    return defer.promise;
};

ControllerSpotify.prototype.getRecentTracks = function (curUri) {

    var self = this;

    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
                var spotifyDefer = self.spotifyApi.getMyRecentlyPlayedTracks({limit: 50});
                spotifyDefer.then(function (results) {
                    var response = {
                        navigation: {
                            prev: {
                                uri: 'spotify'
                            },
                            "lists": [
                                {
                                    "availableListViews": [
                                        "list"
                                    ],
                                    "items": []
                                }
                            ]
                        }
                    };

                    for (var i in results.body.items) {
                        var track = results.body.items[i].track;
                        if (self.isTrackAvailableInCountry(track)) {
                            response.navigation.lists[0].items.push({
                                service: 'spop',
                                type: 'song',
                                title: track.name,
                                artist: track.artists[0].name || null,
                                album: track.album.name || null,
                                albumart: self._getAlbumArt(track.album),
                                uri: track.uri
                            });
                        }
                    }
                    defer.resolve(response);
                }, function (err) {
                    self.logger.error('An error occurred while listing Spotify recent tracks ' + err);
                    self.handleBrowsingError(err);
                    defer.reject('');
                });
            }
        );

    return defer.promise;
};

ControllerSpotify.prototype.featuredPlaylists = function (curUri) {

    var self = this;

    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
                var spotifyDefer = self.spotifyApi.getFeaturedPlaylists();
                spotifyDefer.then(function (results) {
                    var response = {
                        navigation: {
                            prev: {
                                uri: 'spotify'
                            },
                            "lists": [
                                {
                                    "availableListViews": [
                                        "list",
                                        "grid"
                                    ],
                                    "items": []
                                }
                            ]
                        }
                    };

                    for (var i in results.body.playlists.items) {
                        var playlist = results.body.playlists.items[i];
                        response.navigation.lists[0].items.push({
                            service: 'spop',
                            type: 'playlist',
                            title: playlist.name,
                            albumart: self._getAlbumArt(playlist),
                            uri: playlist.uri
                        });
                    }
                    defer.resolve(response);
                }, function (err) {
                    self.logger.error('An error occurred while listing Spotify featured playlists ' + err);
                    self.handleBrowsingError(err);
                    defer.reject('');
                });
            }
        );

    return defer.promise;
};

ControllerSpotify.prototype.listWebPlaylist = function (curUri) {
    var self = this;

    var defer = libQ.defer();

    var uriSplitted = curUri.split(':');

    var spotifyDefer = self.getPlaylistTracks(uriSplitted[2], uriSplitted[4]);
    spotifyDefer.then(function (results) {
        var response = {
            navigation: {
                prev: {
                    uri: 'spotify'
                },
                "lists": [
                    {
                        "availableListViews": [
                            "list"
                        ],
                        "items": []
                    }
                ]
            }
        };
        for (var i in results) {
            response.navigation.lists[0].items.push(results[i]);
        }
        var playlistInfo = self.getPlaylistInfo(uriSplitted[2], uriSplitted[4]);
        playlistInfo.then(function (results) {
            response.navigation.info = results;
            response.navigation.info.uri = curUri;
            response.navigation.info.service = 'spop';
            defer.resolve(response);
        })
    });

    return defer.promise;
};

ControllerSpotify.prototype.listWebNew = function (curUri) {

    var self = this;

    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getNewReleases({limit: 50});
            spotifyDefer.then(function (results) {

                var response = {
                    navigation: {
                        prev: {
                            uri: 'spotify'
                        },
                        "lists": [
                            {
                                "availableListViews": [
                                    "list",
                                    "grid"
                                ],
                                "items": []
                            }
                        ]
                    }
                };

                for (var i in results.body.albums.items) {
                    var album = results.body.albums.items[i];
                    response.navigation.lists[0].items.push({
                        service: 'spop',
                        type: 'folder',
                        title: album.name,
                        albumart: self._getAlbumArt(album),
                        uri: album.uri
                    });
                }
                defer.resolve(response);
            }, function (err) {
                self.logger.error('An error occurred while listing Spotify new albums ' + err);
                self.handleBrowsingError(err);
                defer.reject('');
            });
        });

    return defer.promise;
};

ControllerSpotify.prototype.listWebAlbum = function (curUri) {
    var self = this;
    var defer = libQ.defer();
    var uriSplitted = curUri.split(':');

    var spotifyDefer = self.getAlbumTracks(uriSplitted[2], {limit: 50});
    spotifyDefer.then(function (results) {
        var response = {
            navigation: {
                "prev": {
                    "uri": 'spotify'
                },
                "lists": [
                    {
                        "availableListViews": [
                            "list"
                        ],
                        "items": []
                    }
                ]
            }
        };

        for (var i in results) {
            response.navigation.lists[0].items.push(results[i]);
        }
        var albumInfo = self.getAlbumInfo(uriSplitted[2]);
        albumInfo.then(function (results) {
            response.navigation.info = results;
            response.navigation.info.uri = curUri;
            response.navigation.info.service = 'spop';
            defer.resolve(response);
        })
    });

    return defer.promise;
};


ControllerSpotify.prototype.listWebCategories = function (curUri) {

    var self = this;

    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getCategories({limit: 50});
            spotifyDefer.then(function (results) {

                var response = {
                    navigation: {
                        prev: {
                            uri: 'spotify'
                        },
                        "lists": [
                            {
                                "availableListViews": [
                                    "list",
                                    "grid"
                                ],
                                "items": []
                            }
                        ]
                    }
                };

                for (var i in results.body.categories.items) {
                    response.navigation.lists[0].items.push({
                        service: 'spop',
                        type: 'spotify-category',
                        title: results.body.categories.items[i].name,
                        albumart: results.body.categories.items[i].icons[0].url,
                        uri: 'spotify/category/' + results.body.categories.items[i].id
                    });
                }
                defer.resolve(response);
            }, function (err) {
                self.logger.error('An error occurred while listing Spotify categories ' + err);
                self.handleBrowsingError(err);
                defer.reject('');
            });
        });

    return defer.promise;
};

ControllerSpotify.prototype.listWebCategory = function (curUri) {

    var self = this;

    var defer = libQ.defer();

    var uriSplitted = curUri.split('/');

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getPlaylistsForCategory(uriSplitted[2], {limit: 50});
            spotifyDefer.then(function (results) {

                var response = {
                    navigation: {
                        prev: {
                            uri: 'spotify/categories'
                        },
                        "lists": [
                            {
                                "availableListViews": [
                                    "list",
                                    "grid"
                                ],
                                "items": []
                            }
                        ]
                    }
                };

                for (var i in results.body.playlists.items) {
                    var playlist = results.body.playlists.items[i];
                    response.navigation.lists[0].items.push({
                        service: 'spop',
                        type: 'folder',
                        title: playlist.name,
                        albumart: self._getAlbumArt(playlist),
                        uri: playlist.uri
                    });
                }
                defer.resolve(response);
            }, function (err) {
                self.logger.error('An error occurred while listing Spotify playlist category ' + err);
                self.handleBrowsingError(err);
                defer.reject('');
            });
        });

    return defer.promise;
};

ControllerSpotify.prototype.listWebArtist = function (curUri) {

    var self = this;

    var defer = libQ.defer();

    var uriSplitted = curUri.split(':');

    var artistId = uriSplitted[2];

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var response = {
                navigation: {
                    prev: {
                        uri: 'spotify'
                    },
                    "lists": [
                        {
                            "availableListViews": [
                                "list"
                            ],
                            "items": [],
                            "title": "Top tracks"
                        },
                        {
                            "availableListViews": [
                                "list",
                                "grid"
                            ],
                            "items": [],
                            "title": "Albums"
                        },
                        {
                            "availableListViews": [
                                "list"
                            ],
                            "items": [],
                            "title": "Related Artists"
                        }
                    ]
                }
            };
            var spotifyDefer = self.listArtistTracks(artistId);
            spotifyDefer.then(function (results) {
                for (var i in results) {
                    response.navigation.lists[0].items.push(results[i]);
                }
                return response;
            })
                .then(function (results) {
                    return self.listArtistAlbums(artistId);
                })
                .then(function (results) {
                    for (var i in results) {
                        response.navigation.lists[1].items.push(results[i]);
                    }
                    return response;
                })
                .then(function (results) {
                    return self.getArtistInfo(artistId);
                })
                .then(function (results) {
                    response.navigation.info = results;
                    response.navigation.info.uri = curUri;
                    response.navigation.info.service = 'spop';


                    return response;
                })
                .then(function (results) {
                    return self.getArtistRelatedArtists(artistId);
                })
                .then(function (results) {
                    for (var i in results) {
                        response.navigation.lists[2].items.push(results[i]);
                    }
                    defer.resolve(response);
                    return response;
                })
                .catch(function (error) {
                    defer.resolve(response);
                });
        });

    return defer.promise;
};

ControllerSpotify.prototype.listArtistTracks = function (id) {

    var self = this;

    var defer = libQ.defer();

    var list = [];

    var spotifyDefer = self.getArtistTopTracks(id);
    spotifyDefer.then(function (data) {
        for (var i in data) {
            list.push(data[i]);
        }
        defer.resolve(list);
    });

    return defer.promise;
};

ControllerSpotify.prototype.listArtistAlbums = function (id) {

    var self = this;

    var defer = libQ.defer();

    var spotifyDefer = self.spotifyApi.getArtistAlbums(id);
    spotifyDefer.then(function (results) {
        var response = [];
        for (var i in results.body.items) {
            var album = results.body.items[i];
            response.push({
                service: 'spop',
                type: 'folder',
                title: album.name,
                albumart: self._getAlbumArt(album),
                uri: album.uri,
            });
        }
        defer.resolve(response);
    })


    return defer.promise;
};

ControllerSpotify.prototype.getArtistTracks = function (id) {

    var self = this;

    var defer = libQ.defer();

    var list = [];

    var spotifyDefer = self.getArtistTopTracks(id);
    spotifyDefer.then(function (data) {
        for (var i in data) {
            list.push(data[i]);
        }
        return list;
    })
        .then(function (data) {
            var spotifyDefer = self.getArtistAlbumTracks(id);
            spotifyDefer.then(function (results) {
                var response = data;
                for (var i in results) {
                    response.push(results[i]);
                }
                defer.resolve(response);
            });
        });

    return defer.promise;
};

ControllerSpotify.prototype.getArtistAlbumTracks = function (id) {

    var self = this;

    var defer = libQ.defer();

    var list = [];

    var spotifyDefer = self.spotifyApi.getArtistAlbums(id);
    spotifyDefer.then(function (results) {
        //	var response = data;
        var response = [];
        return results.body.items.map(function (a) {
            return a.id
        });
    })
        .then(function (albums) {
            var spotifyDefer = self.spotifyApi.getAlbums(albums);
            spotifyDefer.then(function (data) {
                var results = data;
                var response = [];
                for (var i in results.body.albums) {
                    var album = results.body.albums[i];
                    for (var j in album.tracks.items) {
                        var track = album.tracks.items[j];
                        if (self.isTrackAvailableInCountry(track)) {
                            response.push({
                                service: 'spop',
                                type: 'song',
                                name: track.name,
                                title: track.name,
                                artist: track.artists[0].name,
                                album: album.name,
                                albumart: self._getAlbumArt(album),
                                uri: track.uri
                            });
                        }
                    }
                }
                defer.resolve(response);
            });
        });


    return defer.promise;
};

ControllerSpotify.prototype.getArtistAlbums = function (artistId) {

    var self = this;

    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getArtistAlbums(artistId);
            spotifyDefer.then(function (results) {
                var response = [];
                for (var i in results.body.items) {
                    var album = results.body.items[i];
                    response.push({
                        service: 'spop',
                        type: 'folder',
                        title: album.name,
                        albumart: self._getAlbumArt(album),
                        uri: album.uri
                    });
                }
                defer.resolve(response);
            });
        });
    return defer.promise;
};

ControllerSpotify.prototype.getArtistRelatedArtists = function (artistId) {

    var self = this;

    var defer = libQ.defer();

    var list = [];

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getArtistRelatedArtists(artistId);
            spotifyDefer.then(function (results) {
                for (var i in results.body.artists) {
                    var albumart = '';
                    var artist = results.body.artists[i];
                    var albumart = self._getAlbumArt(artist);
                    var item = {
                        service: 'spop',
                        type: 'folder',
                        title: artist.name,
                        albumart: albumart,
                        uri: artist.uri
                    };
                    if (albumart == '') {
                        item.icon = 'fa fa-user';
                    }
                    list.push(item);
                }
                defer.resolve(list);
            })
        });

    return defer.promise;
};

ControllerSpotify.prototype.getAlbumTracks = function (id) {
    var self = this;
    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
                var spotifyDefer = self.spotifyApi.getAlbum(id);
                spotifyDefer.then(function (results) {
                    var response = [];
                    var album = results.body.name;
                    var albumart = results.body.images[0].url;
                    for (var i in results.body.tracks.items) {
                        var track = results.body.tracks.items[i];
                        if (self.isTrackAvailableInCountry(track)) {
                            response.push({
                                service: 'spop',
                                type: 'song',
                                title: track.name,
                                name: track.name,
                                artist: track.artists[0].name,
                                album: album,
                                albumart: albumart,
                                uri: track.uri,
                                samplerate: self.getCurrentBitrate(),
                                bitdepth: '16 bit',
                                bitrate: '',
                                trackType: 'spotify',
                                duration: Math.trunc(track.duration_ms / 1000)
                            });
                        }
                    }
                    defer.resolve(response);
                }, function (err) {
                    self.logger.error('An error occurred while listing Spotify album tracks ' + err);
                    self.handleBrowsingError(err);
                    defer.reject('');
                });
            }
        );

    return defer.promise;
};


ControllerSpotify.prototype.getPlaylistTracks = function (userId, playlistId) {
    var self = this;
    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getPlaylist(playlistId);
            spotifyDefer.then(function (results) {

                var response = [];

                for (var i in results.body.tracks.items) {
                    var track = results.body.tracks.items[i].track;
                    if (self.isTrackAvailableInCountry(track)) {
                        try {
                            var item = {
                                service: 'spop',
                                type: 'song',
                                name: track.name,
                                title: track.name,
                                artist: track.artists[0].name,
                                album: track.album.name,
                                uri: track.uri,
                                samplerate: self.getCurrentBitrate(),
                                bitdepth: '16 bit',
                                bitrate: '',
                                trackType: 'spotify',
                                albumart: (track.album.hasOwnProperty('images') && track.album.images.length > 0 ? track.album.images[0].url : ''),
                                duration: Math.trunc(track.duration_ms / 1000)
                            };
                            response.push(item);
                        } catch(e) {}
                    }
                }
                defer.resolve(response);
            }, function (err) {
                self.logger.error('An error occurred while exploding listing Spotify playlist tracks ' + err);
                self.handleBrowsingError(err);
                defer.reject(err);
            });
        });

    return defer.promise;
};

ControllerSpotify.prototype.getArtistTopTracks = function (id) {
    var self = this;
    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getArtistTopTracks(id, 'GB');
            spotifyDefer.then(function (results) {
                var response = [];
                for (var i in results.body.tracks) {
                    var albumart = '';
                    var track = results.body.tracks[i];
                    if (track.album.hasOwnProperty('images') && track.album.images.length > 0) {
                        albumart = track.album.images[0].url;
                    }
                    if (self.isTrackAvailableInCountry(track)) {
                        response.push({
                            service: 'spop',
                            type: 'song',
                            name: track.name,
                            title: track.name,
                            artist: track.artists[0].name,
                            album: track.album.name,
                            albumart: albumart,
                            duration: parseInt(track.duration_ms / 1000),
                            samplerate: self.getCurrentBitrate(),
                            bitdepth: '16 bit',
                            bitrate: '',
                            trackType: 'spotify',
                            uri: track.uri
                        });
                    }
                }
                defer.resolve(response);
            }), function (err) {
                self.logger.error('An error occurred while listing Spotify artist tracks ' + err);
                self.handleBrowsingError(err);
                defer.reject('');
            }
        });

    return defer.promise;
};

ControllerSpotify.prototype.getArtistInfo = function (id) {
    var self = this;
    var defer = libQ.defer();

    var info = {};
    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getArtist(id);
            spotifyDefer.then(function (results) {
                if (results && results.body && results.body.name) {
                    info.title = results.body.name;
                    info.albumart = results.body.images[0].url;
                    info.type = 'artist';
                }
                defer.resolve(info);
            }), function (err) {
                self.logger.info('An error occurred while listing Spotify artist informations ' + err);
                defer.resolve(info);
            }
        });

    return defer.promise;
}

ControllerSpotify.prototype.getAlbumInfo = function (id) {
    var self = this;
    var defer = libQ.defer();

    var info = {};
    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getAlbum(id);
            spotifyDefer.then(function (results) {
                if (results && results.body && results.body.name) {
                    info.album = results.body.name;
                    info.artist = results.body.artists[0].name;

                    info.albumart = results.body.images[0].url;
                    info.type = 'album';
                }
                return results.body.artists[0].id;
            }).then(function (artist) {
                return self.spotifyApi.getArtist(artist);
            }).then(function (artistResults) {
                if (artistResults && artistResults.body && artistResults.body.name) {
                    info.artistImage = artistResults.body.images[0].url;
                    info.artistUri = artistResults.body.uri;
                }
                defer.resolve(info);
            }), function (err) {
                self.logger.error('An error occurred while listing Spotify album informations ' + err);
                self.handleBrowsingError(err);
                defer.resolve(info);
            }
        });

    return defer.promise;
}

ControllerSpotify.prototype.getPlaylistInfo = function (userId, playlistId) {
    var self = this;
    var defer = libQ.defer();

    var info = {};
    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getPlaylist(playlistId);
            spotifyDefer.then(function (results) {
                if (results && results.body && results.body.name) {
                    info.title = results.body.name;
                    info.albumart = results.body.images[0].url;
                    info.type = 'album';
                    info.service = 'spop';
                }
                defer.resolve(info);
            }, function (err) {
                defer.resolve(info);
                self.logger.error('An error occurred while getting Playlist info: ' + err);
                self.handleBrowsingError(err);
            });
        });

    return defer.promise;
}

ControllerSpotify.prototype.getTrack = function (id) {
    var self = this;
    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.getTrack(id);
            spotifyDefer.then(function (results) {

                var response = [];
                var artist = '';
                var album = '';
                var title = '';
                var albumart = '';

                if (results.body.artists.length > 0) {
                    artist = results.body.artists[0].name;
                }

                if (results.body.hasOwnProperty('album') && results.body.album.hasOwnProperty('name')) {
                    album = results.body.album.name;
                }

                if (results.body.album.hasOwnProperty('images') && results.body.album.images.length > 0) {
                    albumart = results.body.album.images[0].url;
                } else {
                    albumart = '';
                }

                var item = {
                    uri: results.body.uri,
                    service: 'spop',
                    name: results.body.name,
                    artist: artist,
                    album: album,
                    type: 'song',
                    duration: parseInt(results.body.duration_ms / 1000),
                    albumart: albumart,
                    samplerate: self.getCurrentBitrate(),
                    bitdepth: '16 bit',
                    bitrate: '',
                    trackType: 'spotify'
                };
                response.push(item);
                self.debugLog('GET TRACK: ' + response)
                defer.resolve(response);
            });
        });

    return defer.promise;
};

// SEARCH FUNCTIONS
ControllerSpotify.prototype.search = function (query) {
    var self = this;
    var defer = libQ.defer();

    self.spotifyCheckAccessToken()
        .then(function (data) {
            var spotifyDefer = self.spotifyApi.search(query.value, ['artist', 'album', 'playlist', 'track']);
            spotifyDefer.then(function (results) {
                var list = [];
                // Show artists, albums, playlists then tracks
                if (results.body.hasOwnProperty('artists') && results.body.artists.items.length > 0) {
                    var artistlist = [];
                    var artists = self._searchArtists(results);
                    for (var i in artists) {
                        artistlist.push(artists[i]);
                    }
                    list.push({
                        type: 'title',
                        title: 'Spotify ' + self.commandRouter.getI18nString('COMMON.SEARCH_ARTIST_SECTION'),
                        availableListViews: ["list", "grid"],
                        items: artistlist
                    });
                }
                if (results.body.hasOwnProperty('albums') && results.body.albums.items.length > 0) {
                    var albumlist = [];
                    var albums = self._searchAlbums(results);
                    for (var i in albums) {
                        albumlist.push(albums[i]);
                    }
                    list.push({
                        type: 'title',
                        title: 'Spotify ' + self.commandRouter.getI18nString('COMMON.SEARCH_ALBUM_SECTION'),
                        availableListViews: ["list", "grid"],
                        items: albumlist
                    });
                }
                if (results.body.hasOwnProperty('playlists') && results.body.playlists.items.length > 0) {
                    var playlistlist = [];
                    var playlists = self._searchPlaylists(results);
                    for (var i in playlists) {
                        playlistlist.push(playlists[i]);
                    }
                    list.push({
                        type: 'title',
                        title: 'Spotify ' + self.commandRouter.getI18nString('COMMON.PLAYLISTS'),
                        availableListViews: ["list", "grid"],
                        items: playlistlist
                    });
                }
                if (results.body.hasOwnProperty('tracks') && results.body.tracks.items.length > 0) {
                    var songlist = [];
                    var tracks = self._searchTracks(results);
                    for (var i in tracks) {
                        songlist.push(tracks[i]);
                    }
                    list.push({type: 'title', title: 'Spotify ' + self.commandRouter.getI18nString('COMMON.TRACKS'), availableListViews: ["list"], items: songlist});
                }
                defer.resolve(list);
            }, function (err) {
                self.logger.error('An error occurred while searching ' + err);
                self.handleBrowsingError(err);
                defer.reject('');
            });
        });

    return defer.promise;
};

ControllerSpotify.prototype._searchArtists = function (results) {

    var list = [];

    for (var i in results.body.artists.items) {
        var albumart = '';
        var artist = results.body.artists.items[i];
        if (artist.hasOwnProperty('images') && artist.images.length > 0) {
            albumart = artist.images[0].url;
        }
        ;
        var item = {
            service: 'spop',
            type: 'folder',
            title: artist.name,
            albumart: albumart,
            uri: artist.uri
        };
        if (albumart == '') {
            item.icon = 'fa fa-user';
        }
        list.push(item);
    }

    return list;

};

ControllerSpotify.prototype._searchAlbums = function (results) {
    var list = [];

    for (var i in results.body.albums.items) {
        var albumart = '';
        var album = results.body.albums.items[i];
        if (album.hasOwnProperty('images') && album.images.length > 0) {
            albumart = album.images[0].url;
        }
        var artist = '';
        if (album.artists && album.artists[0] && album.artists[0].name) {
            artist = album.artists[0].name;
        }

        list.push({
            service: 'spop',
            type: 'folder',
            title: album.name,
            artist: artist,
            albumart: albumart,
            uri: album.uri,
        });
    }

    return list;
};

ControllerSpotify.prototype._searchPlaylists = function (results) {

    var list = [];

    for (var i in results.body.playlists.items) {
        var albumart = '';
        var playlist = results.body.playlists.items[i];
        if (playlist.hasOwnProperty('images') && playlist.images.length > 0) {
            albumart = playlist.images[0].url;
        }
        ;
        list.push({
            service: 'spop',
            type: 'folder',
            title: playlist.name,
            albumart: albumart,
            uri: playlist.uri
        });
    }

    return list;
};

ControllerSpotify.prototype._searchTracks = function (results) {

    var list = [];

    for (var i in results.body.tracks.items) {
        var albumart = '';
        var track = results.body.tracks.items[i];
        if (track.album.hasOwnProperty('images') && track.album.images.length > 0) {
            albumart = track.album.images[0].url;
        }
        ;
        list.push({
            service: 'spop',
            type: 'song',
            title: track.name,
            artist: track.artists[0].name,
            album: track.album.name,
            albumart: albumart,
            uri: track.uri
        });
    }

    return list;
};

// PLUGIN FUNCTIONS

ControllerSpotify.prototype.debugLog = function (stringToLog) {
    var self = this;

    if (isDebugMode) {
        console.log('SPOTIFY ' + stringToLog);
    }
};

ControllerSpotify.prototype.isTrackAvailableInCountry = function (currentTrackObj) {
    var self = this;

    if (self.userCountry && self.userCountry.length && currentTrackObj && currentTrackObj.available_markets && currentTrackObj.available_markets.length) {
        if (currentTrackObj.available_markets.includes(self.userCountry)) {
            return true;
        } else {
            return false;
        }
    } else {
        return true;
    }
};

ControllerSpotify.prototype.explodeUri = function (uri) {
    var self = this;

    self.debugLog('EXPLODING URI:' + uri);

    var defer = libQ.defer();

    var uriSplitted;

    var response;

    if (uri.startsWith('spotify/playlists')) {
        response = self.getMyPlaylists();
        defer.resolve(response);
    } else if (uri.startsWith('spotify:playlist:')) {
        uriSplitted = uri.split(':');
        response = self.getPlaylistTracks(uriSplitted[0], uriSplitted[2]);
        defer.resolve(response);
    } else if (uri.startsWith('spotify:artist:')) {
        uriSplitted = uri.split(':');
        response = self.getArtistTracks(uriSplitted[2]);
        defer.resolve(response);
    } else if (uri.startsWith('spotify:album:')) {
        uriSplitted = uri.split(':');
        response = self.getAlbumTracks(uriSplitted[2]);
        defer.resolve(response);
    } else if (uri.startsWith('spotify:user:')) {
        uriSplitted = uri.split(':');
        response = self.getPlaylistTracks(uriSplitted[2], uriSplitted[4]);
        defer.resolve(response);
    } else if (uri.startsWith('spotify:track:')) {
        uriSplitted = uri.split(':');
        response = self.getTrack(uriSplitted[2]);
        defer.resolve(response);
    } else {
        self.logger.info('Bad URI while exploding Spotify URI: ' + uri);
    }

    return defer.promise;
};