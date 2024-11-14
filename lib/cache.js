const crypto = require('crypto')
const Jimp = require('jimp')

class LocalCache {
	_data_cache = new Map()
	_image_cache = new Map()

	/**
	 * A hash will be created from the stringified object.
	 *
	 * @param {string} key the key is usually the full actor/feedback id (ids separated by '~')
	 * @param {object} options
	 * @returns
	 */
	makeKeyWithOptions(key, options) {
		let cacheKey = key

		if (options && Object.keys(options).length) {
			const optionsHash = crypto.createHash('md5').update(JSON.stringify(options)).digest('hex')
			cacheKey = `${cacheKey}+${optionsHash}`
			// cacheKey = `${cacheKey}+${JSON.stringify(options)}`
		}

		return cacheKey
	}

	removeKeysWithPrefix(prefix) {
		for (const key of this._data_cache.keys()) {
			if (key.startsWith(prefix)) this._data_cache.delete(key)
		}
	}

	storeFromFullId(actorFeedbackId, options, state) {
		const cachekey = this.makeKeyWithOptions(actorFeedbackId, options)
		this._data_cache.set(cachekey, state)
		return cachekey
	}

	store(actorId, feedbackId, options, state) {
		const afid = [actorId, feedbackId].join('~')
		return this.storeFromFullId(afid, options, state)
	}

	getFromFullId(actorFeedbackId, options) {
		const cachekey = this.makeKeyWithOptions(actorFeedbackId, options)
		return [cachekey, this._data_cache.get(cachekey)]
	}

	get(actorId, feedbackId, options) {
		const afid = [actorId, feedbackId].join('~')
		return this.getFromFullId(afid, options)
	}

	remove(actorId, feedbackId, options) {
		const afid = [actorId, feedbackId].join('~')
		const cachekey = this.makeKeyWithOptions(afid, options)
		this._data_cache.delete(cachekey)
	}

	async getImageData(namePathOrUrl, { label = 'hello' } = {}) {
		// console.log('getCachedImageData', namePathOrUrl)
		if (this._image_cache.has(namePathOrUrl)) {
			return this._image_cache.get(namePathOrUrl)
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
			this._image_cache.set(namePathOrUrl, base64)
			return base64
		}
	}

	setImageData(name, data) {
		this._image_cache.set(name, data)
	}
}

module.exports = LocalCache
