module.exports = {

    publishActions(response) {
        if (response != undefined) {
            const actions = {};
            var x = 0;
            response.forEach((action) => {
                
                // target is the name of action
                const { target } = action;

                // 3.0 change
                action.name = action.label;
                delete action.label;

                // remove this from the definition, since it's Captivate specific
                delete action.target;

               // since 3.0, actions need an explicit callback
               action.callback = async (event) => {
                    // alternatively, event.actionId = target
                    this.scheduler._cmp_v1_performAction(target, event.options);
                }

                actions[target] = action;
                x++;
            });
            //console.log("actions", actions);    
            this.setActionDefinitions(actions);
        }
    },

    setupActions(self) {
        var config = this.config;
        this.requestCompanionDefinition("actions")
            .then(response => this.publishActions(response))
            .catch((e) => {
                console.error("error requesting actions", e);
        });
    }


}