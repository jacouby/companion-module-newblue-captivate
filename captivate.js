/**
 * @module  companion-module-newblue-captivate
 * @author  NewBlue (https://www.newbluefx.com)
 * @details Connects Companion to Captivate (Titler Live)
 * @version 3.0
 * @license MIT
 * 
 * @typedef {import('@companion-module/base').CompanionActionDefinition} CompanionActionDefinition
 */
const {InstanceBase, Regex, runEntrypoint, InstanceStatus} = require('@companion-module/base')


// Companion Elements
const Configuration = require('./lib/config')
const Actions = require('./lib/actions')
const Feedbacks = require('./lib/feedbacks')
const Presets = require('./lib/presets')
const UpgradeScripts = require('./lib/upgrades')


// We need to use a specific version (5.9) of QWebChannel because 5.15 which ships with CP 2.2.1
// breaks compatibility with Captivate
const QWebChannelEx = require('./contrib/qwebchannel').QWebChannel
const WebSocket = require('ws')
const crypto = require('crypto');
const Jimp = require('jimp');
const {EventEmitter} = require('stream')
const {reject} = require('lodash')

const USE_QWEBCHANNEL = true;

let debug = () => {}

/**
 * Returns a function that will remember its own debounce timer
 * and will only allow the last call per timeout.
 */
debounce = function (func, timeout = 1000) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func(...args);
    }, timeout);
  };
}

makeCacheKeyUsingOptions = function (key, options) {
  let cacheKey = key;

  if (options && Object.keys(options).length) {
    let vals = {...options};
    // delete any params that shouldn't affect the results
    const optionsHash = crypto.createHash('md5').update(JSON.stringify(vals)).digest('hex');
    cacheKey = `${cacheKey}+${optionsHash}`;
  }

  //console.log("our cache key: ", cacheKey);

  return cacheKey;
};

async function promised(func, ...args) {
  return new Promise((resolve, reject) => {
    // for scheduler calls, the last argument is a callback.
    args.push(e => {resolve(e)});
    func(...args)
  });
}

function promiseify(func) {
  return (...args) => {
    return new Promise((resolve, reject) => {
      // for scheduler calls, the last argument is a callback.
      args.push(e => {resolve(e)});
      try {
        func(...args)
      } catch (e) {
        reject(e)
      }
    });
  }
}

let connectionWatchdog = undefined;
let cacheBuilder = undefined;
let allowsFeedbackCacheRebuilding = false;

let scheduler = {};


class CaptivateInstance extends InstanceBase {
  /** @var {Object} sp Version of the scheduler where all the functions have been wrapped with promises */
  sp = {}
  customActions = {} // actions generated here, not defined in captivate

  get instanceName() {
    return this.label;
  }

  constructor (internal) {
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
    this.images = {};

    this.titlesByName = {};
    this.titles = [];
    this.variableNames = [];

    // mapping from varid to {title, varname, value}
    this.varData = {};

  }

  // Called by Companion on connection initialization
  async init(config) {
    this.CHOICES_TITLES = [{id: 0, label: 'no titles loaded yet', play: 'Done'}];
    this.on_air_status = [];
    debug = (s) => this.log('debug', 'CAPTIVATE:\n' + typeof s == 'string' ? s : JSON.stringify(s));

    this.configUpdated(config);
  }

  // Called when module gets deleted
  async destroy() {
    this.log('debug', 'destroy')
  }

  async configUpdated(config) {
    this.config = config
    this.config.needsNewConfig = false;
    debug('Configuration Changed');
    debug(config);
    if (this.USE_QWEBCHANNEL) {
      this.initQWebChannel();
    } else {
      this.refreshIntegrations();
    }
  }

  async refreshIntegrations() {

    this.allowsFeedbackCacheRebuilding = true;

    await this.getCurrentTitles();
    this.setupFeedbacks();
    this.setupActions();
    this.initPresets();
  }

  /**
   * Initialize the QWebChannel connection to Captivate and register for events
   */
  initQWebChannel() {
    this.config.needsNewConfig ??= false;
    if (this.config.needsNewConfig) {
      this.log('debug', 'connection needs new configuration')
    }

    this.log('debug', JSON.stringify(this.config))
    let serverUrl = null;
    if (this.config.bonjour_host) {
      serverUrl = `ws://${this.config.bonjour_host}` // will contain port
    } else {
      let port = this.config.port; // config defaults to 9023
      let host = this.config.host; // config defaults to '127.0.0.1'
      if (host && port) {
        serverUrl = `ws://${host}:${port}`;
      }
    }
    this.log("debug", `connecting to ${serverUrl}`);
    if (!serverUrl) return;

    this.updateStatus(InstanceStatus.Connecting);
    let socket = new WebSocket(serverUrl);

    socket.on('open', () => {

      this.log("debug", "A Connection to Captivate has been established");

      if (this.connectionWatchdog != undefined) {
        clearTimeout(this.connectionWatchdog);
        this.connectionWatchdog = undefined;
      }

      // Establish API connection.
      new QWebChannelEx(socket, async (channel) => {
        // global and class scheduler objects
        this.scheduler = scheduler = channel.objects.scheduler;

        // wrap scheduler functions in promises... do this first!
        this.wrapScheduler();

        // call the other setup functions
        this.connectCallbacks();
        this.getImageSet();
        this.refreshIntegrations(this);

        // let Captivate know who we are and that we've connected, to customize behaviour and/or trigger startup logic
        let reply = await this.sp.notifyClientConnected("com.newblue.companion-module-captivate", "3.0", {});

        //host version reply will look like this:
        /*
          {
              "buildDate": "Feb 13 2024",
              "buildTime": "15:25:17",
              "host": "TitlerLive",
              "platform": "macos",
              "sku": "SKUTL5BR",
              "version": "5.9.240213"
          }
        */
        this.hostVersionInfo = JSON.parse(reply);
        this.log("debug", `Captivate: Host data:`);
        this.log("debug", reply);

        // tell companion we connected successfully
        this.updateStatus(InstanceStatus.Ok);
      });
    });

    socket.on('error', (data) => {
      this.updateStatus(InstanceStatus.BadConfig);
      this.log('warning', `NewBlue: Captivate: Connection error ${data}.`)
      this.status && this.status(this.STATUS_WARNING, 'Disconnected');
      this.config.needsNewConfig = true;
      this.config.port = ''
      this.config.host = ''
    })

    socket.on('close', () => {
      this.updateStatus(InstanceStatus.Disconnected);
      this.log('warning', 'NewBlue: Captivate: Connection closed.')
      this.status && this.status(this.STATUS_WARNING, 'Disconnected');

      if (this.connectionWatchdog == undefined) {
        // let's periodically try to make a connection again
        this.connectionWatchdog =
          setInterval(() => {
            this.initQWebChannel();
          }, 5000);
      }
    })

  } // end: initQWebChannel

  wrapScheduler() {
    this.scheduler.promised = {}
    for (let [k, v] of Object.entries(this.scheduler)) {
      if (typeof v == 'function') {
        this.scheduler.promised[k] = promiseify(v)
      } else {
        this.scheduler.promised[k] = v;
      }
    }
    // make sure the scheduler is updated if it needs to be
    if (globalThis.scheduler !== this.scheduler) globalThis.scheduler = this.scheduler;
    this.sp = this.scheduler.promised;
  }

  async getImageSet() {
    // companion will assume it's png data
    const includeMimePrefix = false;
    const reply = await this.sp.getImageSet("automation.glow.base", includeMimePrefix);
    this.images = {}
    Object.assign(this.images, reply);
  }

  makeVarDefinition(title, varname) {
    const name = `${title.name}: ${varname}` // the label
    const variableId = `${title.name}__${varname}`.toLowerCase().replace(/[{}: ]/g, '_')
    return {name, variableId}
  }


  makeCustomActionId(shortId) {
    return 'newblue.automation.js.' + shortId;
  }
  makeCustomFeedbackId(shortId) {
    return 'newblue.automation.js.feedback.' + shortId;
  }

  /**
   * 
   * @param {string} shortId 
   * @param {(action:CompanionActionDefinition)=>void} callback 
   */
  registerCustomAction(shortId, callback) {
    let actionId = this.makeCustomActionId(shortId);
    this.customActions[actionId] = callback;
  }

  // handle actions that use similar callbacks
  doAction(actionData) {
    console.log(actionData);
  }

  async getCurrentTitles() {
    const varDefinitions = [];
    this.varData = {};
    this.varValues = {};
    const reply = await this.sp.scheduleCommand('getTitleControlInfo', {}, {});
    try {
      const data = JSON.parse(reply)
      let varnames = new Set();
      this.titlesByName = {};
      this.titlesById = {};
      this.titles = data.titles ?? []
      for (let title of this.titles) {
        this.titlesByName[title.name] = title;
        this.titlesById[title.id] = title;
        for (let variable of title.variables) {
          let def = this.makeVarDefinition(title, variable.variable);
          varDefinitions.push(def);
          this.varData[def.variableId] = {title, varname: variable.variable, value: variable.value};
          this.varValues[def.variableId] = variable.value;
          varnames.add(variable.variable)
        }
      }
      this.variableNames = [...varnames.values()];
      this.variableNames.sort();


      // setting variables doesn't seem to work
      // console.log(varDefinitions);
      // console.log(varValues);
      this.setVariableDefinitions(varDefinitions);
      this.setVariableValues(this.varValues);
      // this.setVariableDefinitions([{name: 'cool variable', variableId: 'cool_variable'}]);
      // this.setVariableValues({'cool_variable': 'hello'})
    } catch (e) {
      throw e;
    }
  }

  connectCallbacks() {
    // connect our callbacks
    const refreshCompanionDefinitions = debounce(this.refreshIntegrations.bind(this));

    // When Captivate's Companion registry changes
    this.sp._cmp_v1_handleActorRegistryChangeEvent.connect((elementId) => {
      console.log(`****Registry updated`, elementId);
      refreshCompanionDefinitions();
    });

    // When Captivate changes a feedback item.
    this.sp._cmp_v1_handleFeedbackChangeEvent.connect((actorId, feedbackId, options, state) => {

      var feedbackKey = `${actorId}~${feedbackId}`;
      console.log(`handle change: '${feedbackKey}'`, options);
      console.log(state);

      this.pendingFeedbackChanges[feedbackKey] = "stale";

      //checkFeedbacksById doesn't seem to work.. lets brute force it for now
      //this.checkFeedbacksById( [feedbackKey]);
      this.checkFeedbacks();
    });

    // When Captivate issues a data event
    this.sp.onNotify.connect(this.handleNotification.bind(this))
    this.sp.scheduleCommand('subscribe', {events: 'play,data'}, {});
  }

  handleNotification(msg) {
    try {
      let {command, event, id, variables} = JSON.parse(msg);
      if (event == 'data' && id && variables && this.titlesById[id]) {
        let title = this.titlesById[id]
        for (let {name, value} of variables) {
          this.setVar({title, name, value});
        }
      }

      // console.log(data);
    } catch (e) {console.log(e)}
  }


  setVar({varid, title, name, value}) {
    if (title && name && !varid) {
      varid = this.makeVarDefinition(title, name).variableId;
    }
    if (varid in this.varData) {
      this.varData[varid].value = value;
      this.varValues[varid] = value;
      title = this.varData[varid].title;
    }
    this.setVariableValues({[varid]: value});

    // this doesn't seem needed since we are tracking the variables internally
    // but it could be helpful and doesn't seem too wasteful
    for (let titlevar of title.variables) {
      if (titlevar.variable == name) {
        titlevar.value = value;
        break;
      }
    }
  }

  async requestCompanionDefinition(kind) {
    // kind = 'actions' | 'presets' | 'feedbacks'
    let reply = await this.sp._cmp_v1_query(kind);
    this.log(reply)
    try {
      if (kind == "actions") return reply.companion_actions;
      else if (kind == "presets") return reply.companion_presets;
      else if (kind == "feedbacks") return reply.companion_feedbacks;
      else if (kind == "lastUpdateTimestamp") return reply.lastUpdateTimestamp;
      else {
        throw "Type not supported";
      }
    } catch (e) {
      throw e;
    }
  }

  async queryFeedbackState(actorId, feedbackId, options) {
    const reply = await this.sp._cmp_v1_queryFeedbackState(actorId, feedbackId, options);
    try {
      var value = JSON.parse(reply);

      //console.log(`_cmp_v1_queryFeedbackState ${actorId} reply: `, reply);

      // query for our layer play states, we will use this to fold into our feedback state
      const playStates = await this.sp.getValueForKey("newblue.automation.layerstate")

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
      return value;
    } catch (e) {
      console.log(`Error parsing response for ${feedbackId}`);
      throw "Bogus response";
    }
  }

  async queryFeedbackDetails(actorId, feedbackId, options) {
    //console.log("Query feedback details", feedbackId);
    let state;
    try {
      state = await this.queryFeedbackState(actorId, feedbackId, options);
    } catch (e) {
      console.log("An error occurred", e);
      throw e;
    }
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
    return state;
  }

  removeAllKeysWithPrefix(prefix) {
    for (const key in this.localFeedbackCache) {
      if (key.startsWith(prefix)) delete this.localFeedbackCache[key];
    }
  }

  /**
   * @brief Query Captivate to determine if there have been updates to the actions/presets/feedbacks
   * @returns an ISO timestamp that's recorded when definitions were last updated
   * @details
   *  This makes a lightweight call to the automation registry to look for any changes.
   */
  async checkForDefinitionUpdates() {

    if (this.USE_QWEBCHANNEL) {
      let response = await this.requestCompanionDefinition("lastUpdateTimestamp")
      console.log(response);
      var lastUpdate = new Date(response.lastUpdate);
      if (lastUpdate >= this.timeOfLastDefinitionUpdates) {
        this.timeOfLastDefinitionUpdates = lastUpdate;
        this.refreshIntegrations(this);
      }
    }

  }

  primeFeedbackState(feedbackId, options) {
    let cacheKey = makeCacheKeyUsingOptions(feedbackId, options);

    let result = this.localFeedbackCache[cacheKey];

    if (result == undefined) {
      console.log("not in the cache");
      this.cacheMisses.push({id: feedbackId, options});
    }
  }


  rebuildFeedbackCache() {

    //console.log("Rebuild feedback cache");
    let promises = [];

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
              this.localFeedbackCache[cacheKey] = reply;
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
        this.checkFeedbacks();
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
        Object.assign(processedResult, {...result});
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
        this.cacheMisses.push({id: event.feedbackId, options: event.options});
        console.log(`not in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`);
      }
      else {
        console.log(`found in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`);
      }

    } else {
      // not in our cache, possibly because we've just started up
      // Ask Captivate to push it back to us, which will trigger a refresh
      this.cacheMisses.push({id: event.feedbackId, options: event.options});
      console.log(`not in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`);
    }


    if (this.cacheMisses.length > 0) {

      if (this.cacheBuilder != undefined) {
        clearTimeout(this.cacheBuilder);
        delete this.cacheBuilder;
        this.cacheBuilder = undefined;
      }

      // let's periodically try to make a connection again
      cacheBuilder =
        setInterval(() => {
          this.rebuildFeedbackCache();
        }, 500);
    }

    return result;
  }

  /**
 * Combine rgb components to a 24bit value (copied from lib/Resources/Util.js)
 * @param {number | string} r 0-255
 * @param {number | string} g 0-255
 * @param {number | string} b 0-255
 * @param {number} base
 * @returns {number | false}
 */
  rgb(r, g, b, base = 10) {
    // @ts-ignore
    r = parseInt(r, base)
    // @ts-ignore
    g = parseInt(g, base)
    // @ts-ignore
    b = parseInt(b, base)

    if (isNaN(r) || isNaN(g) || isNaN(b)) return false
    return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
  }


} // end: CaptivateInstance



runEntrypoint(CaptivateInstance, UpgradeScripts)
