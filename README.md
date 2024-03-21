# Bitfocus Companion Module for Captivate by NewBlue

Control any Captivate instance on your local network with Bitfocus Companion v3+ using this module.

## Manual Installation

Companion v3+ includes our module by default in their latest shipping versions, but it also allows you to download modules and install them manually in a "development" folder. If you want to download the latest version of this controller, you may use the following method to install it.

If you are downloading one of our [binary releases](https://github.com/NewBlueFX/companion-module-newblue-captivate/releases), here's how to install it:

1. Create a folder anywhere on your computer and name it `Companion Modules` (or anything you want).
2. Download the zip file for the [latest release](https://github.com/NewBlueFX/companion-module-newblue-captivate/releases).
3. Extract the zip file. You should have a folder named `companion-module-newblue-captivate` when you are done.
4. Open the folder and make sure it contains the `captivate.js` file. On some systems, the folder will contain an inner folder named `companion-module-newblue-captivate` and _that_ folder will have the `captivate.js` file. The folder with `captivate.js` is the real one to use.
5. Put the correct `companion-module-newblue-captivate` folder into the `Companion Modules` folder you made earlier.

- The file structure should therefore be:
  - `Companion Modules`
    - `companion-module-newblue-captivate`
      - `captivate.js`

6. Launch Companion and open the GUI.
7. Once you have the companion launcher open, click the cog in the top right. This will reveal a 'Developer modules path' field. Use this to select the `Companion Modules` folder you created earlier. (Similar to their instructions here: [Companion Module Wiki](https://github.com/bitfocus/companion-module-base/wiki#5-launch-and-setup-companion))
8. Companion will auto-detect module folders in that directory and will reload itself if any of those files change.

## Collaboration

If you want to help develop this module, feel free to fork it to your own repository, and clone it to a folder on your local system. Follow the same instructions as for installing it above by putting your repo folder inside a `Companion Modules` parent folder. See [Companion Module Wiki](https://github.com/bitfocus/companion-module-base/wiki#5-launch-and-setup-companion) for more details.

If you make any improvements to our companion module, please send us a pull request. We're eager to see what you do!
