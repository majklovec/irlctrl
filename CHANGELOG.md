# [1.16.0](https://github.com/majklovec/irlctrl/compare/v1.15.0...v1.16.0) (2026-10-29)


### Features

* **broadcaster:** align table headers and data to the right for better readability ([0fdde78](https://github.com/majklovec/irlctrl/commit/0fdde78e81010bf94267ecc5df47195a069bad9f))

# [1.15.0](https://github.com/majklovec/irlctrl/compare/v1.14.0...v1.15.0) (2026-10-29)


### Features

* **broadcaster:** implement SRTLA keepalive tracking and UI display ([97b44cc](https://github.com/majklovec/irlctrl/commit/97b44cc79fad124d531991794ee6f1672666b969))

# [1.14.0](https://github.com/majklovec/irlctrl/compare/v1.13.0...v1.14.0) (2026-10-29)


### Bug Fixes

* **broadcaster:** update RTMP URL for Kick server ([37d22ae](https://github.com/majklovec/irlctrl/commit/37d22ae031af11f8404604c0c17a10a1b7f09f72))


### Features

* **broadcaster:** enhance stream lifecycle tracking in device summary ([605f3aa](https://github.com/majklovec/irlctrl/commit/605f3aa606521899640b4638bc143a82ced2318a))
* **chat:** implement banned messages feature with moderation handling ([f4de822](https://github.com/majklovec/irlctrl/commit/f4de822870b9be6317fcf6338fe40fdd9d1f89cd))
* **docker:** add extra_hosts for broadcaster resolution in relay container ([b83d2c5](https://github.com/majklovec/irlctrl/commit/b83d2c502666191b327028e7d71c09aa43a4251d))

# [1.13.0](https://github.com/majklovec/irlctrl/compare/v1.12.0...v1.13.0) (2026-10-29)


### Features

* **broadcaster:** add autostart configuration command to manage boot behavior ([b68aa98](https://github.com/majklovec/irlctrl/commit/b68aa98ed987bcef5ed6a12732f5b1c4020cfd66))
* **dashboards:** add color customization for dashboards ([53bfad3](https://github.com/majklovec/irlctrl/commit/53bfad3475a08852e97b1fa6030e208aa055352c))
* **database:** consolidate migration logic into db.ts and remove migrate.ts ([13d560b](https://github.com/majklovec/irlctrl/commit/13d560b1f120d0c64e94d636abbe838517c251eb))
* **database:** implement database migration system and refactor auth initialization ([a4e41c5](https://github.com/majklovec/irlctrl/commit/a4e41c58e936d35a77f1cf3f73d35a63529d79e9))

# [1.12.0](https://github.com/majklovec/irlctrl/compare/v1.11.0...v1.12.0) (2026-10-29)


### Features

* **broadcaster:** implement RTMP destination management and UI ([4ef38f9](https://github.com/majklovec/irlctrl/commit/4ef38f9e6998fa27063186f89c7ec7d8eae10d17))

# [1.11.0](https://github.com/majklovec/irlctrl/compare/v1.10.0...v1.11.0) (2026-10-29)


### Features

* **srtla2platform:** implement RTMP service catalog and settings UI ([01b7a97](https://github.com/majklovec/irlctrl/commit/01b7a97d393d27b89467cb9aad22da8f4de24c8e))

# [1.10.0](https://github.com/majklovec/irlctrl/compare/v1.9.0...v1.10.0) (2026-10-28)


### Bug Fixes

* **encoder:** force I420 before x264enc to stop High 4:4:4 output ([f9b54e7](https://github.com/majklovec/irlctrl/commit/f9b54e7ccd50673ed0de76053232d5f2152fd94b))
* **encoder:** re-emit SPS/PPS on every IDR to fix green video on Kick ([bf1da11](https://github.com/majklovec/irlctrl/commit/bf1da11a782380db03c3615c9ad2f26b29602030))


### Features

* add srtla2platform agent with install script and main functionality ([f823b99](https://github.com/majklovec/irlctrl/commit/f823b99584a58b3b241e08dc1b760d37b410305a))
* **chat:** add text-to-speech (TTS) functionality for chat messages ([e08fa1f](https://github.com/majklovec/irlctrl/commit/e08fa1fc1570e8f4810553ca59d941ba7bdcdf8a))
* **srtla2platform:** add SRT-LA→SRT→RTMP relay module with web UI ([87f7105](https://github.com/majklovec/irlctrl/commit/87f710567b7385d22a6d20e13621f95bf5e1d95d))
* **srtla2platform:** migrate legacy UUID to config file and mask RTMP key in logs ([537b25c](https://github.com/majklovec/irlctrl/commit/537b25c8150debd95d69540c5c614919e9232f4e))
* **srtla2platform:** replace ffmpeg pipeline mids with file-based output profiles ([a2ff782](https://github.com/majklovec/irlctrl/commit/a2ff782d65341e9d3071f535381e7a7f5c716f9c))

# [1.9.0](https://github.com/majklovec/irlctrl/compare/v1.8.0...v1.9.0) (2026-10-27)


### Features

* **srtla:** add start action and localization for SRTLA control ([086894e](https://github.com/majklovec/irlctrl/commit/086894e478b5a6017160ab9269eb693192d48ad4))

# [1.8.0](https://github.com/majklovec/irlctrl/compare/v1.7.0...v1.8.0) (2026-10-27)


### Features

* add SceneTracker and corresponding tests for OBS scene management ([a66202a](https://github.com/majklovec/irlctrl/commit/a66202acc7cb2a50eb2deb308083c0cf5dafb741))
* **buttons:** add editor row reservation for draggable keys in grid layout ([5532997](https://github.com/majklovec/irlctrl/commit/5532997263a6e69f9c48aee741ae396f7e1933c7))
* **buttons:** enhance button configurations with grid layout support ([5baf560](https://github.com/majklovec/irlctrl/commit/5baf56069b032056255edbfc06dfed64d4cf1799))
* **deck:** implement button configuration and layout management ([c94356e](https://github.com/majklovec/irlctrl/commit/c94356e17971b7d59fcec4998dd2e07fa148c671))

# [1.8.0](https://github.com/majklovec/irlctrl/compare/v1.7.0...v1.8.0) (2026-10-27)


### Features

* add SceneTracker and corresponding tests for OBS scene management ([a66202a](https://github.com/majklovec/irlctrl/commit/a66202acc7cb2a50eb2deb308083c0cf5dafb741))
* **buttons:** add editor row reservation for draggable keys in grid layout ([5532997](https://github.com/majklovec/irlctrl/commit/5532997263a6e69f9c48aee741ae396f7e1933c7))
* **buttons:** enhance button configurations with grid layout support ([5baf560](https://github.com/majklovec/irlctrl/commit/5baf56069b032056255edbfc06dfed64d4cf1799))
* **deck:** implement button configuration and layout management ([c94356e](https://github.com/majklovec/irlctrl/commit/c94356e17971b7d59fcec4998dd2e07fa148c671))

# [1.7.0](https://github.com/majklovec/irlctrl/compare/v1.6.1...v1.7.0) (2026-10-27)


### Features

* add dashboard buttons ([c4db7ec](https://github.com/majklovec/irlctrl/commit/c4db7ecc2a3f1b04052b964fbf4a372858c323e0))
* implement audio source tracking for OBS and update dashboard actions ([124e66e](https://github.com/majklovec/irlctrl/commit/124e66e63d759671a09c09070e5d5d2c3b2b0e7c))

## [1.6.1](https://github.com/majklovec/irlctrl/compare/v1.6.0...v1.6.1) (2026-10-27)


### Bug Fixes

* normalize file paths for i18n manifest generation on Windows ([f888343](https://github.com/majklovec/irlctrl/commit/f8883434b262f02660a3980eb20e780b147228b1))

# [1.6.0](https://github.com/majklovec/irlctrl/compare/v1.5.0...v1.6.0) (2026-10-27)


### Features

* add footer component with app version and enhance login/register pages ([f5a7ed8](https://github.com/majklovec/irlctrl/commit/f5a7ed8f64c8ca08afdf2e65e86a61ea3032a7d7))
