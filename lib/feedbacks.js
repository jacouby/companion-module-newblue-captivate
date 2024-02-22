

module.exports = {


    setupFeedbacks(self) {

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
        var self = this;

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
                feedback.subscribe = function(feedback) {
                    // prime the value
                    console.log("subscribed", feedback);
                    self.primeFeedbackState(feedback.type, feedback.options);
                };

                // new since 3.0
                feedback.callback = async (event) => {
                    return this.handleFeedback(event);
                };

                feedbacks[feedback.id] = feedback;

                x++;
            });

            console.log("publish feedbacks", feedbacks);
        


            this.setFeedbackDefinitions(feedbacks);
        }
    }


}