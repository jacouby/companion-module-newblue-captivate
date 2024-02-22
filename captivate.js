/**
 * @module  companion-module-newblue-captivate
 * @author  NewBlue (https://www.newbluefx.com)
 * @details Connects Companion to Captivate (Titler Live)
 * @version 3.0
 * @license MIT  
 */
const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')

// Companion Elements
const Configuration = require('./lib/config')
const Actions = require('./lib/actions')
const Feedbacks = require('./lib/feedbacks')
const Presets = require('./lib/presets')
const UpgradeScripts = require('./lib/upgrades')


// We need to use a specific version (5.9) of QWebChannel because 5.15 which ships with CP 2.2.1
// breaks compatibility with Titler live
const QWebChannelEx = require('./contrib/qwebchannel').QWebChannel
const WebSocket = require('ws')
const crypto = require('crypto');
const Jimp = require('jimp');
const { EventEmitter } = require('stream')
const { reject } = require('lodash')

const USE_QWEBCHANNEL = true;

let debug = () => {}

debounce = function(func, timeout = 1000) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            func.apply(this, args);
        }, timeout);
    };
}

makeCacheKeyUsingOptions = function(key, options) {
    let cacheKey = key;

    if (options && Object.keys(options).length) {
        let vals = {...options };
        // delete any params that shouldn't affect the results
        const optionsHash = crypto.createHash('md5').update(JSON.stringify(vals)).digest('hex');
        cacheKey = `${cacheKey}+${optionsHash}`;
    }

    //console.log("our cache key: ", cacheKey);

    return cacheKey;
};

let connectionWatchdog = undefined;
let cacheBuilder = undefined;
let allowsFeedbackCacheRebuilding = false;

let scheduler = {};


class CaptivateInstance extends InstanceBase {

    constructor(internal) {
        super(internal)

        Object.assign(this, {
            ...Configuration,
            ...Actions,
            ...Feedbacks,
            ...Presets
        });

        this.USE_QWEBCHANNEL = USE_QWEBCHANNEL;
        this.timeOfLastDefinitionUpdates = new Date();
        this.colorIdx = 0;

        this.titlesPlayStatus = []
        this.titlesImage = []

        this.localFeedbackCache = {};
        this.pendingFeedbackChanges = {};

        this.cacheMisses = [];
    }

    async init(config) {

        this.config = config;
        this.CHOICES_TITLES = [{ id: 0, label: 'no titles loaded yet', play: 'Done' }];
        this.on_air_status = [];
        debug = this.debug;
        this.updateStatus(InstanceStatus.Connecting);
        
        if (this.USE_QWEBCHANNEL) {
            this.initQWebChannel();
        } else {
            this.refreshIntegrations();
        }
    }

    // When module gets deleted
    async destroy() {
        this.log('debug', 'destroy')
    }

    async configUpdated(config) {
        this.config = config
    }

    refreshIntegrations(self) {

        this.allowsFeedbackCacheRebuilding = true;
        
        this.setupFeedbacks(self);
        this.setupActions(self);
        this.initPresets(self);
    }

    /**
     * Initializes the QWebChannel connection to TitlerLiver and register for events
     */
    initQWebChannel() {

        var self = this;

        let ip = this.config.host || "localhost"
        let port = this.config.port || 9023;

        if (!ip || !port) {
            return this
        }

        this.log("debug", `connecting to ws://${ip}:${port}`);

        let socket = new WebSocket(`ws://${ip}:${port}`);

        socket.on('open', () => {

            this.log("debug", "A Connection to Captivate has been established");

            if (connectionWatchdog != undefined) {
                clearTimeout(connectionWatchdog);
                connectionWatchdog = undefined;
            }

            // Establish API connection.
            new QWebChannelEx(socket, (channel) => {

                scheduler = channel.objects.scheduler;
                this.scheduler = scheduler;

                var self = this;

                // companion will assume it's png data
                let includeMimePrefix = false;

                // fetch our base image set
                scheduler.getImageSet("automation.glow.base", includeMimePrefix, (reply) => {
                    this.images = {};
                    Object.assign(this.images, reply);
                });

                self.requestCompanionDefinition = function(kind) {
                    const promise = new Promise((resolve, reject) => {

                        //kind = 'actions' | 'presets' | 'feedbacks'
                        scheduler._cmp_v1_query(kind, (reply) => {

                            try {
                                if (kind == "actions") resolve(reply.companion_actions);
                                else if (kind == "presets") resolve(reply.companion_presets);
                                else if (kind == "feedbacks") resolve(reply.companion_feedbacks);
                                else if (kind == "lastUpdateTimestamp") resolve(reply.lastUpdateTimestamp);
                                else {
                                    throw "Type not supported";
                                }
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });
                    return promise;
                };

                const refreshCompanionDefinitions = debounce(() => self.refreshIntegrations(self));

                scheduler._cmp_v1_handleActorRegistryChangeEvent.connect((elementId) => {
                    console.log(`****Registry updated`, elementId);
                    refreshCompanionDefinitions();
                });

                // Titler has informed us that a feedback has changed
                scheduler._cmp_v1_handleFeedbackChangeEvent.connect((actorId, feedbackId, options, state) => {

                    var feedbackKey = `${actorId}~${feedbackId}`;
                    console.log(`handle change: '${feedbackKey}'`, options);
                    self.pendingFeedbackChanges[feedbackKey] = "stale";
                 
                    //checkFeedbacksById doesn't seem to work.. lets brute force it for now
                    //self.checkFeedbacksById( [feedbackKey]);
                    self.checkFeedbacks();
                });

                this.queryFeedbackState = function(actorId, feedbackId, options) {

                    var self = this;
                    const promise = new Promise((resolve, reject) => {

                        scheduler._cmp_v1_queryFeedbackState(actorId, feedbackId, options, (reply) => {
                            try {
                                var value = JSON.parse(reply);

                                //console.log(`_cmp_v1_queryFeedbackState ${actorId} reply: `, reply);

                                // query for our layer play states, we will use this to fold into our feedback state
                                scheduler.getValueForKey("newblue.automation.layerstate", (playStates) => {

                                    //console.log(`playStates for ${actorId}`, playStates);

                                    // do we have a dynamic image properties?
                                    if (value.hasOwnProperty("overlayQueryKey")) {
                                        let s = playStates[value.overlayQueryKey];
                                        if (s == undefined || !s.hasOwnProperty('playState')) {
                                            // we have a property
                                            s = {};
                                            s.playState = "unknown"
                                        }

                                        if (value.hasOwnProperty("overlayImageName_running")) {
                                            if (s.playState === 'running') {
                                                value.overlayImageName = value.overlayImageName_running;
                                            }
                                            delete value.overlayImageName_running;
                                        }

                                        if (value.hasOwnProperty("overlayImageName_paused")) {
                                            if (s.playState === 'paused') {
                                                value.overlayImageName = value.overlayImageName_paused;
                                            }
                                            delete value.overlayImageName_paused;
                                        }

                                        // done
                                        delete value.overlayQueryKey;
                                    }

                                    if (value.hasOwnProperty("pngQueryKey")) {
                                        let s = playStates[value.pngQueryKey];
                                        if (s == undefined || !s.hasOwnProperty('playState')) {
                                            s = {};
                                            s.playState = "unknown";
                                        }

                                        // we have a property

                                        if (value.hasOwnProperty("png_running")) {
                                            if (s.playState === 'running') {
                                                value.png_running = value.png_running;
                                            }
                                            delete value.png_running;
                                        }

                                        if (value.hasOwnProperty("png_paused")) {
                                            if (s.playState === 'paused') {
                                                value.png = value.png_paused;
                                            }
                                            delete value.png_paused;
                                        }

                                        // done
                                        delete value.pngQueryKey;
                                    }
                                    resolve(value);

                                });
                            } catch (e) {
                                console.log(`Error parsing response for ${feedbackId}`);
                                reject("Bogus response");
                            }
                        });

                    });
                    return promise;
                }


                this.queryFeedbackDetails = function(actorId, feedbackId, options) {
                    //console.log("Query feedback details", feedbackId);
                    let self = this;
                    const promise = new Promise((resolve, reject) => {
                        try {
                            self.queryFeedbackState(actorId, feedbackId, options)
                                .then((state) => {
                                    //console.log("_cmp_v1_queryFeedbackState: ", feedbackId, state);

                                    if (state.hasOwnProperty("overlayImageName")) {
                                        let layerImageData = this.images[`${state.overlayImageName}`];
                                        delete state.layerImageName;

                                        if (!layerImageData) {
                                            //console.log("bad layer data");
                                        } else if (state.hasOwnProperty("png64")) {
                                            const baseImage = Buffer.from(state.png64, 'base64');
                                            const overlayImage = Buffer.from(layerImageData, 'base64');

                                            /*
                                            const output = sharp(baseImage)
                                                .composite([
                                                    { input: overlayImage, tile: true, blend: 'over' }
                                                ]).toBuffer()
                                                .then((buffer) => {
                                                    let base64data = buffer.toString('base64');
                                                    state.png64 = base64data;
                                                    resolve(state);
                                                }).catch((e) => {
                                                    resolve(state);
                                                });
                                                */

                                                // Load the base image
                                                Jimp.read(baseImage)
                                                .then(base => {
                                                    // Load the overlay image
                                                    Jimp.read(overlayImage).then(overlay => {
                                                        // Resize overlay to match base image, if necessary
                                                        overlay.resize(base.bitmap.width, Jimp.AUTO);

                                                        // Composite the overlay onto the base image
                                                        base.composite(overlay, 0, 0, {
                                                            mode: Jimp.BLEND_SOURCE_OVER,
                                                            opacitySource: 1.0,
                                                            opacityDest: 1.0
                                                        })
                                                        // Convert to buffer
                                                        .getBuffer(Jimp.MIME_PNG, (err, buffer) => {
                                                            if (err) {
                                                                reject(err);
                                                            } else {
                                                                // Convert buffer to base64
                                                                let base64data = buffer.toString('base64');
                                                                state.png64 = base64data;
                                                                resolve(state);
                                                            }
                                                        });
                                                    }).catch(e => {
                                                        console.error("Error loading overlay image:", e);
                                                        resolve(state);
                                                    });
                                                })
                                                .catch(e => {
                                                    console.error("Error loading base image:", e);
                                                    resolve(state);
                                                });
                                            return;

                                        } else {
                                            // fall back
                                            state.png64 = this.layerImageData;
                                        }

                                    } else if (state.hasOwnProperty("imageName")) {
                                        state.png64 = this.images[`${state.imageName}`];
                                        delete state.imageName;
                                    }
                                    resolve(state);
                                });
                        } catch (e) {
                            console.log("An error occurred", e);
                            reject(e);
                        }
                    });
                    return promise;
                };

                this.refreshIntegrations();
                this.updateStatus(InstanceStatus.Ok);

                // let Captivate know who we are and that we've connected, to customize behaviour and/or trigger startup logic
                scheduler.notifyClientConnected("com.newblue.companion-module-captivate", "3.0", {}, (reply) => {
                    
                    // don't do anything with the reply
                    var hostVersionInfo = JSON.parse(reply);
                    this.log("debug", `Captivate: Host version: ${hostVersionInfo.version}`);
                });

            });

            var self = this;


        });

        socket.on('error', (data) => {
            console.warn(`NewBlue: TitlerLive: Connection error: ${data}`)
        })

        socket.on('close', () => {
            //console.warn('NewBlue: TitlerLive: Connection closed.')

            if (connectionWatchdog == undefined) {

                this.status(this.STATUS_WARNING, 'Disconnected');

                // let's periodically try to make a connection again
                connectionWatchdog =
                    setInterval(() => {
                        self.initQWebChannel();
                    }, 5000);
            }

        })
    } // end: initQWebChannel

    removeAllKeysWithPrefix(prefix) {
        for (const key in this.localFeedbackCache) {
            if (key.startsWith(prefix)) delete this.localFeedbackCache[key];
        }
    }

    /**
     * @brief Query Titler Live to determine if there have been updates to the actions/presets/feedbacks
     * @returns an ISO timestamp that's recorded when definitions were last updated
     * @details
     *  This makes a lightweight call to the automation registry to look for any changes.
     */
    checkForDefinitionUpdates() {

        var self = this;

        if (this.USE_QWEBCHANNEL) {
            this.requestCompanionDefinition("lastUpdateTimestamp")
                .then((response) => {
                    console.log(response);
                    var lastUpdate = new Date(response.lastUpdate);
                    if (lastUpdate >= self.timeOfLastDefinitionUpdates) {
                        self.timeOfLastDefinitionUpdates = lastUpdate;
                        self.refreshIntegrations();
                    }
                });
        }

    }

    primeFeedbackState(feedbackId, options) {
        let cacheKey = makeCacheKeyUsingOptions(feedbackId, options);

        let result = this.localFeedbackCache[cacheKey];

        if (result == undefined) {
            console.log("not in the cache");
            this.cacheMisses.push({ id: feedbackId, options });
        }
    }


    rebuildFeedbackCache() {

        //console.log("Rebuild feedback cache");

        let promises = [];

        var self = this;

        while (this.cacheMisses.length > 0) {
            let miss = this.cacheMisses.pop();
            console.log("Miss:::", miss);

            if (!miss.id === undefined) continue;

            // clear out our pending feedback changes
            delete this.pendingFeedbackChanges[miss.id];

            const components = miss.id.split("~");
            if (components != undefined && components.length >= 2) {
                const actorId = components[0];
                const feedbackId = components[1];

                let promise = new Promise((resolve, reject) => {

                    this.queryFeedbackDetails(actorId, feedbackId, miss.options)
                        .then((reply) => {

                            var feedbackKey = `${actorId}~${feedbackId}`;

                            var cacheKey = makeCacheKeyUsingOptions(feedbackKey, miss.options);

                            //console.log("received reply");
                            //console.log(JSON.stringify(reply));
                            // cache local results
                            self.localFeedbackCache[cacheKey] = reply;
                            resolve();

                        }).catch((error) => {
                            resolve();
                        });
                });

                promises.push(promise);
            }

        }

        if (promises.length > 0) {
            Promise.allSettled(promises).then((values) => {
                console.log("All promises resolved.. check feedbacks again!");
                self.checkFeedbacks();
            });

        }
        if (this.cacheBuilder) {
            delete this.cacheBuilder;
            this.cacheBuilder = undefined;
        }
    }



    async handleFeedback(event) {

        let options = event.options

        console.log("~~~~~~~~~~~~~");
        console.log("--> in FeedBack", event);
        console.log("~~~~~~~~~~~~~");


        let cacheKey = makeCacheKeyUsingOptions(event.feedbackId, event.options);

        // lookup content in our local cache

        let result = this.localFeedbackCache[cacheKey];

        if (result != undefined) {

            console.log("found in cache");

            if (result.hasOwnProperty("imageName")) {
                var processedResult = {};
                Object.assign(processedResult, {...result });
                delete processedResult.imageName;
                let imageData = this.images[`${result.imageName}`];
                //console.log('image data', imageData);
                if (imageData != undefined) {
                    processedResult['png64'] = imageData;
                }
                //console.log("returning processed result", processedResult);
                result = processedResult;
            }

            if (this.pendingFeedbackChanges[event.feedbackId]) {
                this.cacheMisses.push({ id: event.feedbackId, options: event.options });
                console.log(`not in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`);
            }
            else {
                console.log(`found in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`);
            }

        } else {
            // not in our cache, possibly because we've just started up
            // Ask Titler live to push it back to us, which will trigger a refresh
            this.cacheMisses.push({ id: event.feedbackId, options: event.options });
            console.log(`not in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`);
        }

     
        if (this.cacheMisses.length > 0) {

            if (this.cacheBuilder != undefined) {
                clearTimeout(this.cacheBuilder);
                delete this.cacheBuilder;
                this.cacheBuilder = undefined;
            }

            let self = this;

            // let's periodically try to make a connection again
            cacheBuilder =
                setInterval(() => {
                    self.rebuildFeedbackCache();
                }, 500);
        }

        return result;
    }

} // end: CaptivateInstance

runEntrypoint(CaptivateInstance, UpgradeScripts)