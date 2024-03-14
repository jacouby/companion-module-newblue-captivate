/** These functions will be included in the main class, so it's safe to use "this" */

module.exports = {

	setupFeedbacks() {

		this.requestCompanionDefinition("feedbacks")
			.then(response => this.publishFeedbacks(response))
			.then(response => {
				this.checkFeedbacks();
				// disable cache rebuilding 
				this.allowsFeedbackCacheRebuilding = false;
			})
			.catch((e) => {
				console.error("error requesting feedbacks:", e);
			});
	},

	publishFeedbacks(response) {
		console.log("publishing feedbacks");

		if (response != undefined) {
			const feedbacks = {};
			var x = 0;
			response.forEach((feedback) => {

				//delete action.target;

				// required since 3.0
				feedback.type = 'advanced';
				feedback.name = feedback.label;

				delete feedback.label;

				// we might not have the value in our local cache, so we will try to prime it

				feedback.subscribe = (feedback) => {
					// prime the value
					console.log("subscribed", feedback);
					this.primeFeedbackState(feedback.type, feedback.options);
				};

				// new since 3.0
				feedback.callback = async (event) => {
					return this.handleFeedback(event);
				};

				feedbacks[feedback.id] = feedback;

				x++;
			});

			this.addExtraFeedbacks(feedbacks);

			console.log("publish feedbacks", feedbacks);

			this.setFeedbackDefinitions(feedbacks);
		}
	},

	// add feedbacks not provided by the captivate binary, but based on the API directly
	addExtraFeedbacks(feedbacks) {
		// add a feedback for visibility and for variable values
		let id = this.makeCustomFeedbackId('isVisible');
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
				return result;
			}
		}
	}


}
