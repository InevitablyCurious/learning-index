GOAL: We are building a fully functional backgammon game in Node + TypeScript that runs on localhost. This is the final chunk (6 of 6). All components exist: engine (`src/game.ts`), AI (`src/ai.ts`), server (`src/server.ts`), frontend (`public/`).

TASK: Wire everything together and verify the product end to end. The acceptance bar is a complete product with **0 errors**.

Play it for real, with tools — drive the API, load the page in a browser, and put the game through the situations a player will hit. `DEBUG_API=1` with `/api/debug/roll` and `/api/debug/state` lets you script dice and positions where that is faster than playing to them.

Fix every defect you find.

When you are done: stop any server processes you started, and leave the repo in a state where `npm start` alone runs the product.

**Write in chunks:** never emit more than ~150 lines in a single write/edit tool call — build large files up in ~150-line chunks across several calls, never one giant call.
