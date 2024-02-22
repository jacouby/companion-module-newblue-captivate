
module.exports = {

    mapActionsToSteps(actions) {
        
        const steps = actions.map(action => ({
          down: [action], 
          up: [] 
        }));
      
        return steps;
    },
    conformPresetTo3_0(preset) {

        console.log(preset);

        let p = preset;

        if (p.bank != undefined && p.bank.imageName != undefined) {
            let imageData = this.images[`${p.bank.imageName}`];
            if (imageData != undefined) {
                p.bank.png64 = imageData;
            }
            delete p.bank.imageName;
        }

        let style = p.bank;

     

        p.type = "button";
        p.name = p.label;
        p.style = style;
        p.steps = this.mapActionsToSteps(p.actions);
        
        // migrate type -> feedbackId
        p.feedbacks = preset.feedbacks.map(feedback => {
            const { type, ...rest } = feedback;
            return {
              ...rest,
              feedbackId: type,
            };
        });

        
        delete p.bank;
        delete p.label;
        delete p.actions;
        delete p.style.style;
  
        return p;
    },
    publishPresets(response) {
        var self = this;

        if (response != undefined) {
            const presets = [];
            var x = 0;
            response.forEach((preset) => {
                // remap custom images
              
                upgradedPreset = this.conformPresetTo3_0(preset);

                console.log(upgradedPreset);

                presets.push(upgradedPreset);
                x++;
            });
            this.setPresetDefinitions(presets);
        }
    },

    initPresets(updates) {
        var self = this;
        this.requestCompanionDefinition("presets")
            .then(response => {
                this.publishPresets(response);
            }).catch((e) => {
                console.error("error requesting presets", e);
            });
    }

}