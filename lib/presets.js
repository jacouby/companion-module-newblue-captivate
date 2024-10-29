class PresetDefinition {
	/** @type {'button'} */
	type = 'button'

	/** @type {string} */
	category = ''

	/** @type {string} */
	name = ''

	/** @type {import("@companion-module/base").CompanionButtonStyleProps} */
	style = {}

	/** @type {import("@companion-module/base").CompanionButtonStyleProps?} */
	previewStyle

	/** @type {import("@companion-module/base").CompanionButtonPresetOptions?} */
	options

	/** @type {import("@companion-module/base").CompanionPresetFeedback[]} */
	feedbacks = []

	/** @type {import("@companion-module/base").CompanionButtonStepActions[]} */
	steps = []

	constructor(category, name, style, feedbacks = [], steps = [], previewStyle = null, options = null) {
		this.category = category
		this.name = name
		this.style = style
		this.feedbacks = feedbacks
		this.steps = steps
		this.previewStyle = previewStyle
		this.options = options
	}

	static fromV2(preset, imageBank = {}) {
		let p = new PresetDefinition()
		p.name = preset.label
		p.category = preset.category

		// The style is defined by the old `bank` field. Get only what we need from it.
		let { alignment = 'center', bgcolor, color, pngalignment, show_topbar = true, size, text } = preset.bank
		p.style = { alignment, bgcolor, color, pngalignment, show_topbar, size, text }

		// get the image data
		if (preset.bank != undefined && preset.bank.imageName != undefined) {
			let imageData = imageBank[`${preset.bank.imageName}`]
			if (imageData != undefined) {
				p.style.png64 = imageData
			}
		}

		// convert v2 actions to v3 steps
		p.steps = preset.actions.map((action) => ({
			down: [
				{
					actionId: action.action,
					options: action.options,
				},
			],
			up: [], // Assuming no actions on 'up' for simplicity; modify as needed
		}))

		// if this was an old-style latch action, add the release actions as more steps
		if (preset.bank.latch) {
			p.steps = preset.release_actions.map((action) => ({
				down: [
					{
						actionId: action.action,
						options: action.options,
					},
				],
				up: [], // Assuming no actions on 'up' for simplicity; modify as needed
			}))
		}

		// migrate type -> feedbackId
		p.feedbacks = preset.feedbacks.map((feedback) => {
			const { type, ...rest } = feedback
			const fb = {
				...rest,
				feedbackId: type,
			}

			// handle boolean types
			if (type.match(/\.boolean\./)) {
				fb.style = {
					color: rgb(0, 0, 0),
					bgcolor: rgb(255, 255, 0),
				}
			}

			return fb
		})

		return p
	}
}

/** These functions will be included in the main class, so it's safe to use "this" */
module.exports = {
	publishPresets(response) {
		this.debug('--------------- publishing presets to companion -----------------------')

		if (response != undefined) {
			const presets = []
			var x = 0
			response.forEach((preset) => {
				// remap custom images

				upgradedPreset = PresetDefinition.fromV2(preset, this.images)

				// console.dir(upgradedPreset, {depth: 10})
				presets.push(upgradedPreset)
				this.debug('publishing preset: ' + upgradedPreset.name)
				x++
			})

			this.addExtraPresets(presets)
			// this.debug('publishing presets', presets);
			this.setPresetDefinitions(presets)
		}
	},

	// add presets that aren't defined in the captivate binary but work by making direct API calls
	addExtraPresets(presets) {
		let defaultButtonColor = this.rgb(0, 0, 40)
		let setButtonColor = this.rgb(0, 0, 80)
		let toggleButtonColor = this.rgb(80, 80, 80)
		let alertButtonColor = this.rgb(200, 0, 0)

		let varButtonStyle = {
			alignment: 'center:center',
			bgcolor: defaultButtonColor,
			color: '16777215',
			pngalignment: 'center:center',
			show_topbar: false,
			size: '10',
		}

		for (let title of this.titles) {
			let titlename = title.name
			for (let variable of title.variables) {
				// don't create presets for color or image variables
				if (variable.type == 'image' || variable.type == 'color') continue
				let varname = variable.variable
				let varLabel = `${title.name}: ${variable.variable}`
				let varid = this.makeVarDefinition(title, variable.variable).variableId
				let fullInternalVarName = `\$(${this.instanceName}:${varid})`
				let varNameWithTitleVarValue = `${varname}\\n${fullInternalVarName}\\n${title.name}`
				let varNameWithTitle = `${varname}\\n\\n${title.name}`

				// add a variable display button for every title's variables
				presets.push(
					new PresetDefinition(
						`Variables: ${titlename}`,
						`A button with the name and value of a variable for but preset actions or feedbacks.`,
						{ ...varButtonStyle, text: varNameWithTitleVarValue },
						[],
						[]
					)
				)

				// add a variable set value button for every title's variable
				let actionId = this.makeCustomActionId('variableSetAction')
				presets.push(
					new PresetDefinition(
						`Variables: ${titlename}`,
						`Set the variable to a specified value.`,
						{ ...varButtonStyle, text: `Set\n${varNameWithTitleVarValue}`, bgcolor: setButtonColor },
						[],
						[
							{
								down: [
									{
										actionId,
										options: {
											varid,
											varvalue: '',
											action: 'update',
										},
									},
								],
								up: [],
							},
						]
					)
				)

				// add a variable toggle button for every title's visibility variables
				if (variable.type == 'visible') {
					let feedbackId = this.makeCustomFeedbackId('boolean', 'isVisible')
					actionId = this.makeCustomActionId('variableToggleAction')
					presets.push(
						new PresetDefinition(
							`Variables: ${titlename}`,
							`Toggle a variable's visibility`,
							{ ...varButtonStyle, text: 'Toggle\n' + varNameWithTitle, bgcolor: toggleButtonColor },
							[
								{
									feedbackId,
									style: {
										color: this.rgb(0, 0, 0),
										bgcolor: this.rgb(255, 255, 0),
									},
									options: {
										variable: fullInternalVarName,
									},
								},
							],
							[
								{
									down: [
										{
											actionId,
											options: {
												varid,
												action: 'update',
											},
										},
									],
									up: [],
								},
							]
						)
					)

					// also add a timed alert action
					actionId = this.makeCustomActionId('variableSetAction')
					presets.push(
						new PresetDefinition(
							`Variables: ${titlename}`,
							`Turn a variable on and off again after a set delay`,
							{ ...varButtonStyle, text: 'Alert\n' + varNameWithTitle, bgcolor: alertButtonColor },
							[
								{
									feedbackId,
									style: {
										color: this.rgb(0, 0, 0),
										bgcolor: this.rgb(255, 255, 0),
									},
									options: {
										variable: fullInternalVarName,
									},
								},
							],
							[
								{
									down: [
										{
											actionId,
											options: {
												varid,
												varvalue: '1',
												action: 'update',
											},
										},
										{
											actionId,
											options: {
												varid,
												varvalue: '',
												action: 'update',
											},
											delay: 4000,
										},
									],
									up: [],
								},
							]
						)
					)
				}

				// add a variable increment button for every title's numeric variables
				if (variable.type == 'text' && variable.value.trim() != '' && !isNaN(variable.value)) {
					actionId = this.makeCustomActionId('variableIncrementAction')
					presets.push(
						new PresetDefinition(
							`Variables: ${titlename}`,
							`Increment variable value by a custom amount.`,
							{ ...varButtonStyle, text: 'Increment\n' + varNameWithTitleVarValue, bgcolor: setButtonColor },
							[],
							[
								{
									down: [
										{
											actionId,
											options: {
												varid,
												varincrement: 1,
												action: 'update',
											},
										},
									],
									up: [],
								},
							]
						)
					)
				}
			}
		}
	},

	initPresets() {
		this.requestCompanionDefinition('presets')
			.then((response) => {
				this.publishPresets(response)
			})
			.catch((e) => {
				console.error('error requesting presets', e)
			})
	},
}

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
