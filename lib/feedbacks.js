/** These functions will be included in the main class, so it's safe to use "this" */

module.exports = {
	setupFeedbacks() {
		this.requestCompanionDefinition('feedbacks')
			.then((response) => this.publishFeedbacks(response))
			.then((_) => {
				this.checkFeedbacks()
				// disable cache rebuilding
				this.allowsFeedbackCacheRebuilding = false
			})
			.catch((e) => {
				console.error('error requesting feedbacks:', e)
			})
	},

	publishFeedbacks(response) {
		this.debug('--------------------- publishing feedbacks to companion -------------------------')

		if (response != undefined) {
			const feedbacks = {}
			var x = 0
			response.forEach((feedback) => {
				this.debug('publishing feedback: ' + feedback.id)
				// required since 3.0
				// the 'advanced' feedback type takes the data supplied in the feedback
				// and applies it directly to the button style, redefining text, bgcolor, color, etc.
				// Older controllers using `feedback.native` or `feedback.matcher` in their feedbacks
				// expect the 'advanced' type.
				//
				// Newer controllers may also specify the `boolean` feedback type.
				feedback.type = feedback.id.match(/\.boolean\./) ? 'boolean' : 'advanced'
				feedback.name = feedback.label

				// remove older v2 data
				delete feedback.label

				if (feedback.type == 'boolean') {
					feedback.defaultStyle = {
						color: this.rgb(0, 0, 0),
						bgcolor: this.rgb(255, 255, 0),
					}
				}

				// we might not have the value in our local cache, so we will try to prime it when the subscribe is called
				feedback.subscribe = (feedback) => {
					this.debug('subscribed', feedback)

					// store the instance ids in the local feedback instance cache to reduce feedback callbacks
					if (!this.feedbackInstances.has(feedback.feedbackId)) {
						this.feedbackInstances.set(feedback.feedbackId, [])
					}
					this.feedbackInstances.get(feedback.feedbackId).push(feedback.id)

					// prime the value
					this.primeFeedbackState(feedback.type, feedback.options)
				}

				feedback.unsubscribe = (feedback) => {
					this.debug('unsubscribed', feedback)

					// remove from instance cache if we need to
					const instances = this.feedbackInstances.get(feedback.feedbackId)
					if (!instances) return
					const index = instances.indexOf(feedback.id)
					if (index < 0) return
					instances.splice(index, 1)
				}

				// new since 3.0
				feedback.callback = async (event) => {
					// this.debug('-- feedback callback called ---')
					// this.debug(feedback.id)
					return this.handleFeedbackRequest(event) // will look in the cache for data
				}

				feedbacks[feedback.id] = feedback

				x++
			})

			this.addExtraFeedbacks(feedbacks)

			// this.debug("publish feedbacks", feedbacks);

			this.setFeedbackDefinitions(feedbacks)
		}
	},

	// add feedbacks not provided by the captivate binary, but based on the API directly
	addExtraFeedbacks(feedbacks) {
		// add a feedback for visibility and for variable values
		let id = this.makeCustomFeedbackId('boolean', 'isVisible')
		feedbacks[id] = {
			id,
			type: 'boolean',
			name: 'Variable: Is Visible',
			description: 'Change style when the variable is not empty',
			defaultStyle: {
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(255, 255, 0),
			},
			options: [
				{
					id: 'variable',
					type: 'textinput',
					label: 'Variable',
					tooltip: 'What variable to act on?',
					default: '',
					useVariables: true,
				},
			],
			callback: async (feedback, context) => {
				// console.log({logging: 'FEEDBACK CHECK'})
				// console.dir(feedback, {depth: 10});
				let result = !!(await context.parseVariablesInString(feedback.options.variable.trim()))
				// console.log({result})
				return result
			},
		}
	},
}
