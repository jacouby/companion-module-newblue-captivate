/**
 * @module  companion-module-newblue-captivate
 * @author  NewBlue https://www.newbluefx.com
 * @details Connects Companion to Captivate (Titler Live)
 * @version 3.0
 * @license MIT
 */

/**
 * For information on what the companion base module can do, see:
 *
 * https://github.com/bitfocus/companion-module-base/blob/main/CHANGELOG.md
 *
 * and
 *
 * https://github.com/bitfocus/companion-module-base/blob/main/README.md
 */

/**
 * JSDoc types
 *
 * @import {CompanionActionDefinition, CompanionFeedbackDefinition, CompanionFeedbackInfo} from '@companion-module/base'
 *
 * typedef {import('@companion-module/base').CompanionActionDefinition} CompanionActionDefinition
 * typedef {import('@companion-module/base').CompanionFeedbackDefinition} CompanionFeedbackDefinition
 * typedef {import('@companion-module/base').CompanionFeedbackInfo} CompanionFeedbackInfo
 * typedef {import('@companion-module/base').CompanionFeedbackInfo} CompanionFeedbackInfo
 * typedef {import('@companion-module/base').CompanionFeedbackInfo} CompanionFeedbackInfo
 * typedef {import('@companion-module/base').CompanionFeedbackInfo} CompanionFeedbackInfo
 *
 */

/** Imports */
const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')

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
const crypto = require('crypto')
const Jimp = require('jimp')

const USE_QWEBCHANNEL = true

let debug = () => {}
let error = () => {}

/**
 * A hash will be created from the stringified object.
 *
 * @param {string} key the key is usually the full actor/feedback id (ids separated by '~')
 * @param {object} options
 * @returns
 */
function makeCacheKeyUsingOptions(key, options) {
	let cacheKey = key

	if (options && Object.keys(options).length) {
		const optionsHash = crypto.createHash('md5').update(JSON.stringify(options)).digest('hex')
		cacheKey = `${cacheKey}+${optionsHash}`
		// cacheKey = `${cacheKey}+${JSON.stringify(options)}`
	}
	// debug('=== making cache key =================')
	// debug('making cache key for:', key, options)
	// debug(`Cache Key: ${cacheKey}`)
	// debug('=== done =============================')

	return cacheKey
}

function promiseify(func) {
	return (...args) => {
		return new Promise((resolve, reject) => {
			// for scheduler calls, the last argument is a callback.
			args.push((e) => {
				resolve(e)
			})
			try {
				func(...args)
			} catch (e) {
				reject(e)
			}
		})
	}
}

class CaptivateInstance extends InstanceBase {
	/** @var {Object} sp Version of the scheduler where all the functions have been wrapped with promises */
	sp = {}
	customActions = {} // actions generated here, not defined in captivate

	get instanceName() {
		return this.label
	}

	constructor(internal) {
		super(internal)

		Object.assign(this, {
			...Configuration,
			...Actions,
			...Feedbacks,
			...Presets,
		})

		this.USE_QWEBCHANNEL = USE_QWEBCHANNEL
		this.timeOfLastDefinitionUpdates = new Date()
		this.colorIdx = 0

		this.titlesPlayStatus = []
		this.titlesImage = []

		/**
		 * The local feedback cache retains the last feedback state for feedbacks
		 * according to the id of the feedback.
		 */
		this.localFeedbackCache = {}

		/**
		 * The pendingFeedbackChanges object is used to track feedbacks that have changed but haven't been sent to Companion yet.
		 */
		this.pendingFeedbackChanges = new Map()
		this.cacheMisses = new Map()

		/** @type {Map<string, object[]>} - key is the feedbackId, the value is a list of instance ids */
		this.feedbackInstances = new Map()

		this.images = {}

		this.titlesByName = {}
		this.titles = []
		this.variableNames = []

		// mapping from varid to {title, varname, value}
		this.varData = {}
	}

	// Called by Companion on connection initialization
	async init(config) {
		this.CHOICES_TITLES = [{ id: 0, label: 'no titles loaded yet', play: 'Done' }]
		this.on_air_status = []
		this.debug = debug = (...args) =>
			args.forEach((s) =>
				this.log('debug', 'CAPTIVATE:\n' + typeof s == 'string' ? s : JSON.stringify(s, undefined, 2))
			)
		this.error = error = (...args) =>
			args.forEach((s) =>
				this.log('error', 'CAPTIVATE:\n' + typeof s == 'string' ? s : JSON.stringify(s, undefined, 2))
			)

		this.configUpdated(config)
	}

	// Called when module gets deleted
	async destroy() {
		this.debug('destroy called')
	}

	async configUpdated(config) {
		this.config = config
		this.config.needsNewConfig = false
		this.debug('Configuration Changed')
		this.debug(config)
		if (this.USE_QWEBCHANNEL) {
			this.initQWebChannel()
		} else {
			this.refreshIntegrations()
		}
	}

	async refreshIntegrations() {
		this.allowsFeedbackCacheRebuilding = true // will be changed from feedbacks.js

		await this.getCurrentTitles()
		this.setupFeedbacks() // from feedbacks.js
		this.setupActions() // from actions.js
		this.initPresets() // from presets.js
	}

	/**
	 * Initialize the QWebChannel connection to Captivate and register for events
	 */
	initQWebChannel() {
		this.config.needsNewConfig ??= false
		if (this.config.needsNewConfig) {
			this.log('debug', 'connection needs new configuration')
		}

		this.log('debug', JSON.stringify(this.config))
		let serverUrl = null
		if (this.config.bonjour_host) {
			serverUrl = `ws://${this.config.bonjour_host}` // will contain port
		} else {
			let port = this.config.port // config defaults to 9023
			let host = this.config.host // config defaults to '127.0.0.1'
			if (host && port) {
				serverUrl = `ws://${host}:${port}`
			}
		}
		this.log('debug', `connecting to ${serverUrl}`)
		if (!serverUrl) return

		this.updateStatus(InstanceStatus.Connecting)
		let socket = new WebSocket(serverUrl)

		socket.on('open', () => {
			this.log('debug', 'A Connection to Captivate has been established')

			if (this.connectionWatchdog != undefined) {
				clearTimeout(this.connectionWatchdog)
				this.connectionWatchdog = undefined
			}

			// Establish API connection.
			new QWebChannelEx(socket, async (channel) => {
				// global and class scheduler objects
				this.scheduler = channel.objects.scheduler

				// wrap scheduler functions in promises... do this first!
				this.wrapScheduler()

				// call the other setup functions
				this.connectCallbacks()
				this.getImageSet()
				this.refreshIntegrations()

				// let Captivate know who we are and that we've connected, to customize behaviour and/or trigger startup logic
				let reply = await this.sp.notifyClientConnected('com.newblue.companion-module-captivate', '3.0', {})

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
				this.hostVersionInfo = JSON.parse(reply)
				debug(`Captivate: Host data:`)
				debug(this.hostVersionInfo)

				// tell companion we connected successfully
				this.updateStatus(InstanceStatus.Ok)
			})
		})

		socket.on('error', (data) => {
			this.updateStatus(InstanceStatus.BadConfig)
			this.log('warning', `NewBlue: Captivate: Connection error ${data}.`)
			this.status && this.status(this.STATUS_WARNING, 'Disconnected')
			this.config.needsNewConfig = true
			this.config.port = ''
			this.config.host = ''
		})

		socket.on('close', () => {
			this.updateStatus(InstanceStatus.Disconnected)
			this.log('warning', 'NewBlue: Captivate: Connection closed.')
			this.status && this.status(this.STATUS_WARNING, 'Disconnected')

			if (this.connectionWatchdog == undefined) {
				// let's periodically try to make a connection again
				this.connectionWatchdog = setInterval(() => {
					this.initQWebChannel()
				}, 5000)
			}
		})
	} // end: initQWebChannel

	/** wrap the scheduler functions in promises so we can use them with async/await paradigms */
	wrapScheduler() {
		this.scheduler.promised = {}
		for (let [k, v] of Object.entries(this.scheduler)) {
			if (typeof v == 'function') {
				this.scheduler.promised[k] = promiseify(v)
			} else {
				this.scheduler.promised[k] = v
			}
		}
		// make sure the scheduler is updated if it needs to be
		if (globalThis.scheduler !== this.scheduler) globalThis.scheduler = this.scheduler
		this.sp = this.scheduler.promised
	}

	/** Requests the automation images from the Captivate backend. */
	async getImageSet() {
		// companion will assume it's png data
		const includeMimePrefix = false
		const reply = await this.sp.getImageSet('automation.glow.base', includeMimePrefix)
		this.images = {}
		Object.assign(this.images, reply)
	}

	/**
	 * Creates a Companion-style variable definition from a Captivate title and variable name.
	 *
	 * @param {string} title A Captivate title object
	 * @param {string} varname A Captivate variable name
	 * @returns
	 */
	makeVarDefinition(title, varname) {
		const name = `${title.name}: ${varname}` // the label
		const variableId = `${title.name}__${varname}`.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_')
		return { name, variableId }
	}

	// only visible to companion, so it doesn't have to follow the entire newblue action schema
	makeCustomActionId(actionName) {
		return `newblue.automation.js.${actionName}`
	}

	// only visible to companion, so it doesn't have to follow the entire newblue action schema
	makeCustomFeedbackId(type, feedbackName) {
		return `newblue.automation.js.feedback.${type}.${feedbackName}`
	}

	/**
	 *
	 * @param {string} shortId
	 * @param {(action:CompanionActionDefinition)=>void} callback
	 */
	registerCustomAction(shortId, callback) {
		let actionId = this.makeCustomActionId(shortId)
		this.customActions[actionId] = callback
	}

	// handle actions that use similar callbacks
	// doAction(actionData) {
	//   this.debug(actionData);
	// }

	/**
	 * Gets all the information for the current project titles and uses that information to
	 * - cache the icons for each title -- TODO
	 * - set up companion variables for each title variable
	 * - set up companion variables for each data controller variable
	 */
	async getCurrentTitles() {
		const varDefinitions = []
		this.varData = {}
		this.varValues = {}
		const reply = await this.sp.scheduleCommand('getTitleControlInfo', { icon: 1, height: 72, width: 72 }, {})
		try {
			const data = JSON.parse(reply)
			let varnames = new Set()
			this.titlesByName = {}
			this.titlesById = {}
			this.titles.reverse() // they always come in backward
			this.titles = data.titles ?? []
			this.titles.reverse()
			for (let title of this.titles) {
				this.titlesByName[title.name] = title
				this.titlesById[title.id] = title

				for (let variable of title.variables) {
					let def = this.makeVarDefinition(title, variable.variable)
					varDefinitions.push(def)
					this.varData[def.variableId] = { title, varname: variable.variable, value: variable.value }
					this.varValues[def.variableId] = variable.value
					varnames.add(variable.variable)
				}
			}
			this.variableNames = [...varnames.values()]
			this.variableNames.sort()

			// setting variables doesn't seem to work
			// this.debug(varDefinitions);
			// this.debug(varValues);
			this.setVariableDefinitions(varDefinitions)
			this.setVariableValues(this.varValues)
			// this.setVariableDefinitions([{name: 'cool variable', variableId: 'cool_variable'}]);
			// this.setVariableValues({'cool_variable': 'hello'})
		} catch (e) {
			this.error(e)
			throw e
		}
	}

	connectCallbacks() {
		// connect our callbacks

		let refresh_debounce = 0
		this.sp._cmp_v1_handleActorRegistryChangeEvent.connect((elementId) => {
			// this method runs the first one and then ignores all subsequent calls for 1000ms
			if (refresh_debounce) return //clearTimeout(refresh_debounce)
			console.log(`****Registry updated`, elementId)
			this.refreshIntegrations()
			refresh_debounce = setTimeout(() => {
				refresh_debounce = 0
			}, 1000)
		})

		// When Captivate changes a feedback item.
		this.sp._cmp_v1_handleFeedbackChangeEvent.connect(async (actorId, feedbackId, options, state) => {
			const feedbackKey = `${actorId}~${feedbackId}`
			// this.debug(`handle feedback change: '${feedbackKey}'`, options)
			// this.debug({state})

			// transform the state into a format that Companion can use
			if (Object.keys(state).length > 0) {
				state = await this._handleFeedbackState(state)
			}

			// put this state into the cache
			this.cacheStore(actorId, feedbackId, options, state)

			this.pendingFeedbackChanges.set(feedbackKey, true)

			// this.debug(this._getAllFeedbacks());

			// checkFeedbacksById expects to be called with the actual, internal ids
			// of each feedback instance, not the `feedbackId` that we created for the
			// feedback type, that's why we update feedbacks this way.
			this.checkFeedbacks()
		})

		// When Captivate issues a data event
		this.sp.onNotify.connect(this.handleNotification.bind(this))
		this.sp.scheduleCommand('subscribe', { events: 'play,data' }, {})
	}

	handleNotification(msg) {
		try {
			let { event, id, variables } = JSON.parse(msg)
			if (event == 'data' && id && variables && this.titlesById[id]) {
				let title = this.titlesById[id]
				for (let { name, value } of variables) {
					this.setVar({ title, name, value })
				}
			}

			// this.debug(data);
		} catch (e) {
			this.debug(e)
		}
	}

	setVar({ varid, title, name, value }) {
		if (title && name && !varid) {
			varid = this.makeVarDefinition(title, name).variableId
		}
		if (varid in this.varData) {
			this.varData[varid].value = value
			this.varValues[varid] = value
			title = this.varData[varid].title
		}
		this.setVariableValues({ [varid]: value })

		// this doesn't seem needed since we are tracking the variables internally
		// but it could be helpful and doesn't seem too wasteful
		for (let titlevar of title.variables) {
			if (titlevar.variable == name) {
				titlevar.value = value
				break
			}
		}
	}

	/**
	 * Request actions, presets, feedbacks, etc from Captivate. These will be parsed into real
	 * action, preset, feedback objects, and will be registered in the Companion system.
	 *
	 * @param {'actions'|'presets'|'feedbacks'|'lastUpdateTimestamp'} kind gets current data from Captivate for presets, etc.
	 * @returns
	 */
	async requestCompanionDefinition(kind) {
		// kind = 'actions' | 'presets' | 'feedbacks'
		let reply = await this.sp._cmp_v1_query(kind)
		this.log(reply)
		try {
			if (kind == 'actions') return reply.companion_actions
			else if (kind == 'presets') return reply.companion_presets
			else if (kind == 'feedbacks') return reply.companion_feedbacks
			else if (kind == 'lastUpdateTimestamp') return reply.lastUpdateTimestamp
			else {
				throw 'Type not supported'
			}
		} catch (e) {
			this.error(e)
			throw e
		}
	}

	async _handleFeedbackOverlayPlayStates(state) {
		// query for our layer play states, we will use this to fold into our feedback state
		const playStates = await this.sp.getValueForKey('newblue.automation.layerstate')

		// did the feedback data include a dynamic image?
		if (state.hasOwnProperty('overlayQueryKey')) {
			let s = playStates[state.overlayQueryKey]
			if (s == undefined || !s.hasOwnProperty('playState')) {
				// we have a property
				s = {}
				s.playState = 'unknown'
			}

			if (state.hasOwnProperty('overlayImageName_running')) {
				if (s.playState === 'running') {
					state.overlayImageName = state.overlayImageName_running
				}
				delete state.overlayImageName_running
			}

			if (state.hasOwnProperty('overlayImageName_paused')) {
				if (s.playState === 'paused') {
					state.overlayImageName = state.overlayImageName_paused
				}
				delete state.overlayImageName_paused
			}

			// done
			delete state.overlayQueryKey
		}

		if (state.hasOwnProperty('pngQueryKey')) {
			let s = playStates[state.pngQueryKey]
			if (s == undefined || !s.hasOwnProperty('playState')) {
				s = {}
				s.playState = 'unknown'
			}

			// we have a property

			if (state.hasOwnProperty('png_running')) {
				if (s.playState === 'running') {
					state.png_running = state.png_running
				}
				delete state.png_running
			}

			if (state.hasOwnProperty('png_paused')) {
				if (s.playState === 'paused') {
					state.png = state.png_paused
				}
				delete state.png_paused
			}

			// done
			delete state.pngQueryKey
		}
		return state
	}

	async _handleFeedbackOverlayImage(state) {
		// If the feedback specified an image name, attempt to load it from our local image cache.
		if (state.hasOwnProperty('overlayImageName')) {
			let layerImageData = this.images[`${state.overlayImageName}`]
			delete state.overlayImageName

			if (!layerImageData) {
				debug('bad layer data')
			} else if (state.hasOwnProperty('png64')) {
				const baseImage = Buffer.from(state.png64, 'base64')
				const overlayImage = Buffer.from(layerImageData, 'base64')

				await new Promise((resolve, reject) => {
					// Load the base image
					Jimp.read(baseImage)
						.then((base) => {
							// Load the overlay image
							Jimp.read(overlayImage)
								.then((overlay) => {
									// Resize overlay to match base image, if necessary
									overlay.resize(base.bitmap.width, Jimp.AUTO)

									// Composite the overlay onto the base image
									base
										.composite(overlay, 0, 0, {
											mode: Jimp.BLEND_SOURCE_OVER,
											opacitySource: 1.0,
											opacityDest: 1.0,
										})
										// Convert to buffer
										.getBase64(Jimp.MIME_PNG, (result) => {
											state.png64 = result
											resolve(state)
										})
								})
								.catch((e) => {
									this.error('Error loading overlay image:', e)
									resolve(state)
								})
						})
						.catch((e) => {
							this.error('Error loading base image:', e)
							resolve(state)
						})
				})
			} else {
				// fall back
				state.png64 = this.layerImageData
			}
		} else if (state.hasOwnProperty('imageName') && state.imageName) {
			state.png64 = this.images[`${state.imageName}`]
			delete state.imageName
		}
		return state
	}

	/**
	 * This function takes the feedback state that comes from Captivate, and does the following:
	 * 1. convert the Captivate feedback data into a format that Companion can use
	 * 2. if the feedback data includes an image, handle it.
	 *
	 * @param {*} state
	 * @returns
	 */
	async _handleFeedbackState(state) {
		// first, handle the items that are Captivate Specific
		if (state.overlayQueryKey || state.pngQueryKey) {
			state = await this._handleFeedbackOverlayPlayStates(state)
			debug('state with overlay information', state)
		}
		if (state.overlayImageName || state.imageName) {
			state = await this._handleFeedbackOverlayImage(state)
		}

		return this._adaptToCompanionFeedback(state)
	}

	/**
	 *
	 * The advanced feedbacks can also take an `imageBuffer` (Uint8Array), and an `imagePosition` value. See the `CompanionAdvancedFeedbackResult` type for more.
	 * @param {*} state The state that comes from Captivate. It could have any number of fields, but we only care about the ones that are relevant to Companion.
	 * @returns {import('@companion-module/base').CompanionFeedbackButtonStyleResult|import('@companion-module/base').CompanionAdvancedFeedbackResult}
	 */
	async _adaptToCompanionFeedback(state) {
		let result = {}
		for (let property of [
			'text',
			'size',
			'color',
			'bgcolor',
			'alignment',
			'png64',
			'pngalignment',
			'show_topbar',
			/* advanced only */
			'imageBuffer',
			'imagePosition',
			/* boolean feedbacks only use `value` */
			'value',
		]) {
			if (state.hasOwnProperty(property)) {
				result[property] = state[property]
			}
		}

		// we can pass raw base 64 image data to Companion using the image64 property
		if (state.image64) {
			result.png64 = state.image64
		}

		// we can pass other image data to Companion using imageNames, imagePath, or imageUrl (png64 will take precedence)
		let imageKey = state.imageName || state.imageUrl || state.imagePath
		if (imageKey) {
			this.debug('requesting image data from cache', imageKey)
			const imageData = await this.getCachedImageData(imageKey)
			this.debug('image data', imageData)
			if (imageData != undefined) {
				result.png64 ??= imageData
			}
		}

		return result
	}

	/**
	 * This asks Captivate what the current value of this feedback should be.
	 * If the current feedback value should be an image, Captivate can push it to us.
	 *
	 * This is the lower-level version of the call. In most cases, you want to use
	 * queryFeedbackDetails
	 *
	 * @param {string} actorId the actor id will be connected to the feedbackId by a '~'
	 * @param {string} feedbackId
	 * @param {object} options The options as they are set in the feedback object
	 * @returns {Promise<{[key: string]: string|number|boolean}>}
	 * @throws {string}
	 */
	async _queryFeedbackState(actorId, feedbackId, options) {
		// console.log('Asking Captivate for feedback state:', actorId, feedbackId, options)
		const reply = await this.sp._cmp_v1_queryFeedbackState(actorId, feedbackId, options)
		try {
			var state = JSON.parse(reply)
			this.debug({ actorId, feedbackId, options, result: state })
			return await this._handleFeedbackState(state)
		} catch (e) {
			this.debug(`Error parsing response for ${feedbackId}`)
			throw 'Bogus response'
		}
	}

	/**
	 * This is the higher level call to get feedback data from Captivate.
	 *
	 * @param {string} actorId the actor id will be connected to the feedbackId by a '~'
	 * @param {string} feedbackId
	 * @param {object} options The options as they are set in the feedback object
	 * @returns {Promise<{[key: string]: string|number|boolean}>}
	 * @throws {string}
	 */
	async queryFeedbackDetails(actorId, feedbackId, options) {
		let state
		try {
			state = await this._queryFeedbackState(actorId, feedbackId, options)
		} catch (e) {
			this.debug('An error occurred', e)
			throw e
		}
		return state
	}

	/**
	 * @brief Query Captivate to determine if there have been updates to the actions/presets/feedbacks
	 * @returns an ISO timestamp that's recorded when definitions were last updated
	 * @details
	 *  This makes a lightweight call to the automation registry to look for any changes.
	 */
	async checkForDefinitionUpdates() {
		if (this.USE_QWEBCHANNEL) {
			let response = await this.requestCompanionDefinition('lastUpdateTimestamp')
			this.debug(response)
			var lastUpdate = new Date(response.lastUpdate)
			if (lastUpdate >= this.timeOfLastDefinitionUpdates) {
				this.timeOfLastDefinitionUpdates = lastUpdate
				this.refreshIntegrations(this)
			}
		}
	}

	cacheRemoveKeysWithPrefix(prefix) {
		for (const key in this.localFeedbackCache) {
			if (key.startsWith(prefix)) delete this.localFeedbackCache[key]
		}
	}

	cacheStoreFromFullId(actorFeedbackId, options, state) {
		const cachekey = makeCacheKeyUsingOptions(actorFeedbackId, options)
		this.localFeedbackCache[cachekey] = state
	}

	cacheStore(actorId, feedbackId, options, state) {
		const afid = [actorId, feedbackId].join('~')
		this.cacheStoreFromFullId(afid, options, state)
	}

	cacheGetFromFullId(actorFeedbackId, options) {
		const cachekey = makeCacheKeyUsingOptions(actorFeedbackId, options)
		return [cachekey, this.localFeedbackCache[cachekey]]
	}

	cacheGet(actorId, feedbackId, options) {
		const afid = [actorId, feedbackId].join('~')
		return this.cacheGetFromFullId(afid, options)
	}

	/**
	 *
	 * @param {string} actorFeedbackId the actor feedback id is a full actorId with feedbackId separated by ~
	 * @param {object} options any arbitrary set of data
	 */
	primeFeedbackState(actorFeedbackId, options) {
		const [cacheKey, result] = this.cacheGetFromFullId(actorFeedbackId, options)

		if (result == undefined) {
			this.debug('not in the cache')
			this.cacheMisses.set(cacheKey, { id: actorFeedbackId, options })
		}
	}

	/**
	 * Will ask Captivate for the current state of each registered feedback
	 * that isn't already in the cache.
	 *
	 * This function doesn't send feedbacks to companion, it just updates the cache.
	 */
	async requestMissingFeedbacks() {
		if (this.doingRebuild) return
		this.doingRebuild = true

		let promises = []

		// clear out any previously pending feedback changes since we are loading a new version now
		this.pendingFeedbackChanges.clear()
		while (this.cacheMisses.size > 0) {
			for (let cacheKey of this.cacheMisses.keys()) {
				const miss = this.cacheMisses.get(cacheKey) ?? {}
				this.cacheMisses.delete(cacheKey)
				if (!miss.id) continue

				console.log('rebuildFeedbackCache for: ' + miss.id)

				// parse the id of the missing item
				const [actorId, feedbackId] = miss.id.split('~', 2)

				// do we have a valid feedback id?
				if (actorId && feedbackId && feedbackId.match(/\.feedback\./)) {
					let promise = new Promise((resolve, _) => {
						// Ask Captivate for the latest details
						this.queryFeedbackDetails(actorId, feedbackId, miss.options)
							.then((reply) => {
								this.debug('feedback state received', reply)
								this.cacheStoreFromFullId(miss.id, miss.options, reply)
								resolve(miss.id)
							})
							.catch((error) => {
								this.debug(error)
								resolve(null)
							})
					})

					promises.push(promise)
				}
			}
		}

		if (promises.length > 0) {
			await Promise.all(promises).then((successfulIds) => {
				// console.log('Feedback cache has been rebuilt... running checkFeedbacks again!')
				// this.checkFeedbacks()
				successfulIds = successfulIds.filter((e) => e != null)
				this.checkFeedbacksById(successfulIds)
			})
		}

		this.doingRebuild = false
	}

	async getCachedImageData(namePathOrUrl, { label = 'hello' } = {}) {
		console.log('getCachedImageData', namePathOrUrl)
		if (this.images[namePathOrUrl]) {
			return this.images[namePathOrUrl]
		}

		let image
		try {
			image = await Jimp.read(namePathOrUrl) // jimp can do urls, paths, and base64
		} catch (e) {
			// console.log(e)
			console.error('Error loading image:', namePathOrUrl)
			return undefined
		}

		if (image) {
			image.cover(72, 72)
			if (label) {
				// for future use... this is how you fill an area with alpha so that
				// our nice blue background can shine through
				// fill rectangle with black
				// image.scan(0, 72 - 14, 72, 14, function (x, y, offset) {
				// 	this.bitmap.data.writeUInt32BE(0x00000088, offset, true)
				// })
			}
			const base64 = await image.getBase64Async(Jimp.MIME_PNG)
			this.images[namePathOrUrl] = base64
			return base64
		}
	}

	/**
	 * This will be used as the callback for a companion feedback.
	 *
	 * @param {import('@companion-module/base').CompanionFeedbackBooleanEvent|import('@companion-module/base').CompanionFeedbackAdvancedEvent} event
	 * @returns
	 */
	async handleFeedbackRequest(event) {
		// if (!this.pendingFeedbackChanges.get(event.feedbackId)) return {}
		// delete this.pendingFeedbackChanges[event.feedbackId]

		// debug('~~~~~~~~~~ Feedback Callback ~~~~~~~~~~~~')
		// debug(event)
		// debug('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~')

		// the feedbackId will be the full actor/feedback id (actorId~feedbackId)
		// let cacheKey = makeCacheKeyUsingOptions(event.feedbackId, event.options)

		// lookup content in our local cache
		let [cacheKey, result] = this.cacheGetFromFullId(event.feedbackId, event.options)

		// if (result == undefined || this.pendingFeedbackChanges[event.feedbackId]) {
		// 	// this was a cache miss...
		// 	// not in our cache, possibly because we've just started up
		// 	// Ask Captivate to push it back to us, which will trigger a refresh
		// 	this.cacheMisses.set(event.feedbackId, { id: event.feedbackId, options: event.options })
		// 	this.debug(
		// 		`not in cache or cache out of date, scheduling for later lookup: ${event.feedbackId} - ${JSON.stringify(
		// 			event.options
		// 		)}`
		// 	)
		// 	return event.type == 'boolean' ? false : {}
		// } else {
		// 	debug(`found in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`)
		// }

		/**
		 * The following code was used to coerce the cache result into a format that Companion can use. However,
		 * This caused images to be processed too often. This has been refactored so that processing is done
		 * before the data gets stored in our local cache.
		 */
		if (result != undefined) {
			let imageKey = result.imageName || result.imageUrl || result.imagePath
			if (imageKey) {
				var processedResult = {}
				Object.assign(processedResult, { ...result })
				delete processedResult.imageName
				let imageData = await this.getCachedImageData(imageKey)
				// this.debug('image data', imageData)
				if (imageData != undefined) {
					processedResult['png64'] = imageData
				}
				// this.debug('returning processed result', processedResult)
				result = processedResult
			}

			// if (this.pendingFeedbackChanges[event.feedbackId]) {
			// 	this.cacheMisses.set(event.feedbackId, { id: event.feedbackId, options: event.options })
			// 	debug(`updating cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`)
			// } else {
			// 	// debug(`found in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`)
			// }
		} else {
			// not in our cache, possibly because we've just started up
			// Ask Captivate to push it back to us, which will trigger a refresh
			this.cacheMisses.set(cacheKey, { id: event.feedbackId, options: event.options })
			debug(`not in the cache: ${event.feedbackId} - ${JSON.stringify(event.options)}`)
		}

		this.startCacheChecker() // does nothing unless there are cache misses

		if (result != undefined) {
			// debug('feedback state: ')
			// debug(result)
		}
		return event.type == 'boolean' ? !!result?.value : result
	}

	stopCacheChecker() {
		if (this.cacheBuilder != undefined) {
			clearTimeout(this.cacheBuilder)
			delete this.cacheBuilder
			this.cacheBuilder = undefined
		}
	}

	startCacheChecker() {
		this.stopCacheChecker()

		if (this.cacheMisses.size > 0) {
			// let's periodically try to make a connection again
			this.cacheBuilder = setTimeout(() => {
				this.requestMissingFeedbacks()
				this.startCacheChecker()
			}, 500)
		}
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

/**
 * Combine rgb components to a 24bit value (copied from lib/Resources/Util.js)
 * @param {number | string} r 0-255
 * @param {number | string} g 0-255
 * @param {number | string} b 0-255
 * @param {number} base
 * @returns {number | false}
 */
function rgb(r, g, b, base = 10) {
	// @ts-ignore
	r = parseInt(r, base)
	// @ts-ignore
	g = parseInt(g, base)
	// @ts-ignore
	b = parseInt(b, base)

	if (isNaN(r) || isNaN(g) || isNaN(b)) return false
	return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

class CompanionFeedbackState {}

class CompanionFeedback {
	/** @type {string} */
	id = '' // the unique id used by companion to identify this feedback

	/** @type {'boolean'|'advanced'} */
	type = 'boolean'

	/** @type {string} */
	name = 'Unnamed' // displayed to the user

	/** @type {{bgcolor: number|string, color: number|string}} */
	defaultStyle = {} // used whenever the feedback doesn't specify a style

	/** @type {Array<{type: string, label: string, id: string, default: any}>} */
	options = [] // options that can be set by the user to identify when this feedback should be used

	/** @type {(feedback: any, context: any|undefined) => (boolean|object)|null} */
	callback // will be called by companion to get the feedback state

	constructor({ type = 'boolean', name = 'Unnamed', defaultStyle = {}, options = {}, callback = null }) {
		this.type = type || 'boolean'
		this.name = name || 'My first feedback'
		this.defaultStyle = defaultStyle || {
			bgcolor: rgb(255, 0, 0),
			color: rgb(0, 0, 0),
		}
		this.options = options || [
			{
				type: 'number',
				label: 'Source',
				id: 'source',
				default: 1,
			},
		]
		this.callback = callback
	}

	static fromCaptivateState(state) {
		return new CompanionFeedback({
			type: state.type,
			name: state.name,
			defaultStyle: state.defaultStyle,
			options: state.options,
			callback: state.callback,
		})
	}
}

runEntrypoint(CaptivateInstance, UpgradeScripts)
