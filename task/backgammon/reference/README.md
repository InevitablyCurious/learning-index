# Reference, not given to the model

`CONTRACT.md` was the master specification for the backgammon task: the full
interface and every behavioural requirement. It moved out of `scaffold/` on
2026-09-15 and was retired entirely on 2026-09-19, when its rules were
relocated into the five build prompts in `../prompts/`.

The five build prompts in `../prompts/` are now the complete specification —
file and function names, board and state shapes, routes, page tags, the exact
wording tests search for, and the full rules of backgammon (movement, hitting,
bar entry, bear-off, dice usage, the higher-die rule, the doubling cube, win
classification). There is no separate spec file any more.

If you change what the tests require, change the prompts too.
