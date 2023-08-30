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

    const conf = template.replace('${device_name}', devicename)
        .replace('${bitrate_number}', selectedBitrate);

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
        self.commandRouter.pushToastMessage('success', self.getI18n('SPOTIFY_LOGIN'), self.getI18n('SUCCESSFULLY_AUTHORIZED'));
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
            }
        );

    return defer.promise;
}

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
            })
    }
}

// BROWSING
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


// New function that uses the Spotify Web API to get a user's playlists.  Must be authenticated ahead of time and using an access token that asked for the proper scopes
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
                    .set("Authorization", "Bearer " + self.spotifyAccessToken)
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

