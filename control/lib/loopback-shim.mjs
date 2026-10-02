// LOOPBACK BIND SHIM — preloaded with `node --import` ahead of the untrusted
// app's entrypoint (see the spawn in control/play.mjs).
//
// The rendered app reads only PORT and calls `server.listen(PORT)` with no
// host, which binds every interface and makes an untrusted build reachable
// from the LAN. There is no env-var lever and the app's source is not ours to
// patch, so the prototype is: listen(port[, cb]) becomes
// listen(port, "127.0.0.1", cb). Calls that already name a host are untouched.

import net from "node:net";

const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(...args) {
  // The all-interfaces forms are exactly the ones with a numeric port and no
  // host string: listen(port) and listen(port, cb). Path, handle, options and
  // explicit-host calls pass through unchanged.
  if (typeof args[0] === "number" && typeof args[1] !== "string") {
    args.splice(1, 0, "127.0.0.1");
  }
  return originalListen.apply(this, args);
};
