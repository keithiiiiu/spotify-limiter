/* Runs in the PAGE's own JS world (manifest "world": "MAIN") before Spotify's scripts.
 * Stops the browser from opening picture-in-picture automatically (when you switch
 * tab / window while music plays). Manual PiP (the student clicking the button)
 * still works and is counted by content.js. */
(function () {
  'use strict';
  // Self-contained on purpose (no config.js here): it runs on every site the
  // manifest lists, which are all music sites.

  try {
    // 1) Auto-PiP is triggered via the Media Session "enterpictureinpicture" action.
    //    Refuse to register a handler for it, so the browser has nothing to call.
    const proto = window.MediaSession && window.MediaSession.prototype;
    if (proto && !proto.__slGuard) {
      const orig = proto.setActionHandler;
      Object.defineProperty(proto, 'setActionHandler', {
        configurable: true,
        writable: true,
        value: function (action, handler) {
          if (action === 'enterpictureinpicture') {
            try { return orig.call(this, action, null); } catch (e) { return undefined; }
          }
          return orig.call(this, action, handler);
        },
      });
      Object.defineProperty(proto, '__slGuard', { value: true });
    }
  } catch (e) { /* ignore */ }

  try {
    // 2) Belt and braces: a PiP window may only be opened by a real user gesture.
    const dpip = window.documentPictureInPicture;
    if (dpip && typeof dpip.requestWindow === 'function') {
      const open = dpip.requestWindow.bind(dpip);
      dpip.requestWindow = function (opts) {
        if (navigator.userActivation && !navigator.userActivation.isActive) {
          return Promise.reject(new DOMException('Picture-in-picture needs a user gesture.', 'NotAllowedError'));
        }
        return open(opts);
      };
    }
  } catch (e) { /* ignore */ }
})();
