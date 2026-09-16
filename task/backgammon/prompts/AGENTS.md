# Notes

- Everything you need is in this folder; stay in it.
- If a tool call is denied, accept it and find another way.
- Keep each write or edit under ~150 lines; build big files in several passes.
- Each command runs in its own session: a server started with a plain `&` is killed when that command ends, and a later request to it gets an empty reply.
- Start servers detached so they survive: `node -e "require('node:child_process').spawn('node',['src/server.ts'],{stdio:'ignore',detached:true}).unref()"`. Stop them with `kill <pid>`. Or start and test in the same command.
- Playwright and Chromium are installed globally: use `require('playwright')` and the bare `playwright` command. There is no network, so never install packages.
- Give every test and server run a timeout.
