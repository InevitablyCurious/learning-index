# Notes

## The project
- Everything you need is in this folder; stay in it. Nothing outside it is yours to change.
- If a tool call is denied, accept it and find another way.
- There is no network. Everything the project needs is already installed — never install packages.

## Writing files
- Keep each write or edit under ~150 lines; build big files in several passes.
- If a write fails or looks truncated, re-apply only the missing part.

## How commands run on this machine
- Each command runs in its own shell session. When the command returns, everything it started is stopped with it — including a server started with `&`.
- A command that never returns is cut off after about 90 seconds. A server run in the foreground (`node src/server.ts`, or piped into `head`) never returns, so it always hits that limit.
- If you set a timeout on a command, give it enough time to finish; a timeout shorter than the work just cuts the work off.

## Running the server for testing
Start, test and stop in one command:
```
node --experimental-strip-types src/server.ts > /tmp/server.log 2>&1 &
PID=$!
for i in $(seq 1 30); do curl -s localhost:8002/health >/dev/null && break; sleep 0.2; done
curl -s -X POST localhost:8002/api/new -H 'content-type: application/json' -d '{}'
kill $PID
```

## Stopping a server
- Stop it by its PID: `kill $PID`.
- Never stop processes by matching a name. `pkill -f node` also kills the shell your command is running in, and `pkill -f server.ts` matches the very command that contains it — either way the command hangs for two minutes and does nothing.
- If port 8002 is still taken, find the server's PID with `ps -eo pid,args | grep "[s]rc/server.ts"` and kill that PID.
- To run a second copy alongside, set another port: `PORT=8003 node --experimental-strip-types src/server.ts`.

## Checking the page in a browser
- Playwright and Chromium are installed globally. Load them with `require('playwright')` and run with plain `node`, not `npx`.
- In the same command as the server (above), put the browser check between starting it and `kill $PID`, pointed at `http://127.0.0.1:8002/`:
```
node -e "
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on('console', m => console.log('console:', m.text()));
  await p.goto('http://127.0.0.1:8002/');
  console.log(await p.title());
  await b.close();
})();"
```
- What the server returns is not what a player sees. Check anything visual — pieces moving, the cube, pip counts, the end of a game — in the browser, not only through the API.

## Before you say it works
- Give every test and server run a way to finish, and stop what you started.
