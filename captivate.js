const { runEntrypoint } = require('@companion-module/base')

const UpgradeScripts = require('./lib/upgrades')
const CaptivateInstance = require('./lib/captivate')

runEntrypoint(CaptivateInstance, UpgradeScripts)
