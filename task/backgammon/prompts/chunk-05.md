TASK: Wire everything together and verify the product end to end. The acceptance bar is a complete product with **0 errors**.
- A full human-vs-AI game is playable to completion, reaching a `winner` with a valid `winType`, with no server exceptions.
- On load, the difficulty control shows the difficulty the game is actually running at.
- If you reload during the computer's turn, the computer finishes its turn.
- If you reload while the computer's double offer is on screen, the offer shows again so you can accept or decline it.

Play it for real, with tools — drive the API, load the page in a browser, and put the game through the situations a player will hit. `DEBUG_API=1` with `/api/debug/roll` and `/api/debug/state` lets you script dice and positions where that is faster than playing to them.

Fix every defect you find.

When you are done: stop any server processes you started, and leave the repo in a state where `npm start` alone runs the product.
