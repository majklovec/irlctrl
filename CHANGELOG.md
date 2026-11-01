# [2.2.0](https://github.com/majklovec/irlctrl/compare/v2.1.0...v2.2.0) (2026-11-01)


### Features

* implement runtime URL dialog with copy and rotate functionality ([5e4ec81](https://github.com/majklovec/irlctrl/commit/5e4ec81c309a31a75047997e4667a5fb66843966))

# [2.1.0](https://github.com/majklovec/irlctrl/compare/v2.0.0...v2.1.0) (2026-11-01)


### Bug Fixes

* **handles:** add CSS variable for counter-scaling handles based on zoom ([108f239](https://github.com/majklovec/irlctrl/commit/108f239ccc0948883c5186b5fdfa11abf19bbd90))
* **handles:** adjust border width for overlay handles ([0957a84](https://github.com/majklovec/irlctrl/commit/0957a847575cf937a954f51f9fca408a548ae4a2))
* **overlay:** improve CSS inlining for first paint and adjust progress bar layout ([cd86bda](https://github.com/majklovec/irlctrl/commit/cd86bda8e1eb78ed2c85d1e3628de36f71f69834))
* **setup:** role diagrams ([d6d7d88](https://github.com/majklovec/irlctrl/commit/d6d7d8837d6d15421875dcf47123c63bc96ac6a3))


### Features

* enhance alert handling with payload validation and persistence in project variables ([fd055c0](https://github.com/majklovec/irlctrl/commit/fd055c017b68d1cb118e458f3b5b0e85dfa0e3d9))
* implement alert element with trigger-driven overlays ([c9f07bf](https://github.com/majklovec/irlctrl/commit/c9f07bf4226ac3c6281bc41811616182d25f02d4))
* introduce dedicated alert trigger endpoint and update variable handling ([d6e3879](https://github.com/majklovec/irlctrl/commit/d6e387939e6b5d8faae2cffb5de5455f3a7005dc))
* update variable handling in overlays ([f106b42](https://github.com/majklovec/irlctrl/commit/f106b42d55517117c8093144f87c0322568233eb))

# [2.0.0](https://github.com/majklovec/irlctrl/compare/v1.21.0...v2.0.0) (2026-11-01)


* refactor!: snake_case file names, rename srtla→relay and obs-controller→obs, add combined module ([6bcb371](https://github.com/majklovec/irlctrl/commit/6bcb37157c40dfaabae149f6a96fc51fb09a3ea3))


### Bug Fixes

* **boot:** regenerate generated/ before the application graph loads ([05cde65](https://github.com/majklovec/irlctrl/commit/05cde655c2f490143343808cac18b4cc914762ed))
* **control-server:** overlay editor duplication, selection, z-order ([f17a048](https://github.com/majklovec/irlctrl/commit/f17a0480e1a27659dba15f64fe4c213d72211cdf))
* **line:** implement line diagonal flipping based on drag delta and add tests ([03f435c](https://github.com/majklovec/irlctrl/commit/03f435c0d28c1ea8dc2ae2231e8e63e25a2b5380))
* **overlays:** add line endpoint handles for shape elements and adjust overflow behavior ([ec4ed1b](https://github.com/majklovec/irlctrl/commit/ec4ed1b1e80601ec045ca46294e3cb0ccdcff328))
* **overlays:** add server-managed monotonic counter to Scene for handling stale WS pushes ([3eae414](https://github.com/majklovec/irlctrl/commit/3eae4142b4b2fe8b532d6ad879349eedbfd01830))
* **overlays:** enhance drag snapping logic for element resizing and clamping ([c94e638](https://github.com/majklovec/irlctrl/commit/c94e6387cb57195c5710a01371591b0b33859616))
* **overlays:** stroke element-row chevron with currentColor ([d3124ea](https://github.com/majklovec/irlctrl/commit/d3124ea35af35d4e609f80ee5d67d1e86e7ff367))
* **resize:**  redraw on moce, implement variable revalue via token-authenticated URL and update documentation ([c15e2d9](https://github.com/majklovec/irlctrl/commit/c15e2d93bb50705adae96c560c8b4e3af2d53332))


### Features

* add progress overlay element with properties and bindings ([f54decf](https://github.com/majklovec/irlctrl/commit/f54decf8b466e1558cb39d6f3e261c6cd90d6782))
* **control-server:** inline canvas text editing + row collapse toggle ([fad7fd5](https://github.com/majklovec/irlctrl/commit/fad7fd5121f8682f60f79fa0b9fb211dedd58bb4))
* **control-server:** inspector element list + header z-order arrows ([cc286b7](https://github.com/majklovec/irlctrl/commit/cc286b7792dfc6eb86fcfa89904098a8ab9dc624))
* **control-server:** OBS overlay editor (M1) ([b0038bb](https://github.com/majklovec/irlctrl/commit/b0038bb0c491245cb037e301c6e8fcde05a09530))
* **control-server:** per-element collapsible inspector rows with own z-order buttons ([2517514](https://github.com/majklovec/irlctrl/commit/25175147b661a621b358afb1a4b405e925571236))
* **control-server:** remove redundant Scenes rail from overlay editor ([f99e722](https://github.com/majklovec/irlctrl/commit/f99e7228084283972fc22401087aed1a43865d30))
* **control-server:** show overlays list before the editor ([208adb9](https://github.com/majklovec/irlctrl/commit/208adb9475f4ae81bda2bfd1fc5fa0d38f3202bc))
* **control-server:** z-order arrows in Elements header, drop Inspector title ([d86a244](https://github.com/majklovec/irlctrl/commit/d86a244b83ebda8d100848a201550d059b745a38))
* enhance overlay element bindings and styling ([ac8bdd6](https://github.com/majklovec/irlctrl/commit/ac8bdd660ca7b3ca8ce9d1048b97b772dcd367b9))
* **overlays:** add chat and iframe elements with corresponding properties and UI integration ([4854942](https://github.com/majklovec/irlctrl/commit/4854942d1ed51a69ee1b07426087998a748094c6))
* **overlays:** implement toolbar with undo/redo and element addition buttons ([8503475](https://github.com/majklovec/irlctrl/commit/85034756a2bc46a0b43e90689565de4297d47c25))
* **overlays:** inline Runtime URL icons in header row; chevron before element name ([6860e65](https://github.com/majklovec/irlctrl/commit/6860e65716cf9355302b3196f26fe5df53694842))
* **overlays:** replace Assets panel with per-image-element upload; icon buttons in Runtime URL card ([880ea0b](https://github.com/majklovec/irlctrl/commit/880ea0b09135b5847d7fc218ab94cf7ecec47f9e))
* **overlays:** white collapse chevron; keep only forward/backward z-order ([ec99a38](https://github.com/majklovec/irlctrl/commit/ec99a38a8ebb7055df9b8427695589f11570dcaf))
* **toolbar:** add zoom in/out buttons to editor toolbar and update styles ([e313ee8](https://github.com/majklovec/irlctrl/commit/e313ee8a13a6d26ccd586e62ee8f7dea4eab960f))
* **ui:** component library — one file per component, new primitives ([e3fd4ee](https://github.com/majklovec/irlctrl/commit/e3fd4ee78fe2473389d8f4aea033785b14374e4d))


### BREAKING CHANGES

* device RPC methods/events `srtla.*` are now `relay.*`,
the status carries `state.relay` / `relayTarget` / `relayOptions` /
`summary.relay` instead of the `srtla*` keys, the capability is
`stream.relay`, and the module ids `srtla` / `obs-controller` are `relay` /
`obs` (settings slices, dashboard action ids, i18n keys). Devices and the
control server must be upgraded together; stored device configs and
dashboards are migrated automatically on first start.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>

# [1.21.0](https://github.com/majklovec/irlctrl/compare/v1.20.0...v1.21.0) (2026-10-30)


### Bug Fixes

* **chat:** add support for Kick emotes with valid image URLs in chat ([0e3b81a](https://github.com/majklovec/irlctrl/commit/0e3b81a81f069a251f44d3000529921ed21feb09))


### Features

* **routing:** implement default route failover and enhance interface display ([f250756](https://github.com/majklovec/irlctrl/commit/f250756a928552ab772c5137d15f24ddfafc6c21))

# [1.20.0](https://github.com/majklovec/irlctrl/compare/v1.19.0...v1.20.0) (2026-10-30)


### Features

* **chat:** add OBS overlay support with token authentication ([34d2ea0](https://github.com/majklovec/irlctrl/commit/34d2ea0a1508c8a17b40b93a3dbf437aca9cb2db))

# [1.19.0](https://github.com/majklovec/irlctrl/compare/v1.18.0...v1.19.0) (2026-10-30)


### Features

* **broadcaster:** add new streaming profiles for audio-only, copy, and re-encoding formats ([8ed4d75](https://github.com/majklovec/irlctrl/commit/8ed4d75480a482b76c7c2ba034d1a14f5b98a91d))

# [1.18.0](https://github.com/majklovec/irlctrl/compare/v1.17.0...v1.18.0) (2026-10-29)


### Features

* **chat:** add message timestamps feature with localization support ([0703e5a](https://github.com/majklovec/irlctrl/commit/0703e5a20d4dfc4d8068dd7b268309894037de05))

# [1.17.0](https://github.com/majklovec/irlctrl/compare/v1.16.0...v1.17.0) (2026-10-29)


### Features

* **table:** align table text to the center for improved readability ([fa0f372](https://github.com/majklovec/irlctrl/commit/fa0f3726e3f9bad8dd89819b323935faa92a9297))

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
