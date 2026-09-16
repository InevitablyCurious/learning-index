# Reference, not given to the model

`CONTRACT.md` is the master specification for the backgammon task: the full
interface and every behavioural requirement, kept for us and for the grading
suite. It used to sit in `scaffold/`, which meant it was copied into the
model's work folder and read as part of the task.

It moved out on 2026-09-15 (Jerry). What the model is given is the six build
prompts in `../prompts/`, and those carry the fixed contact points the grading
tests depend on — file and function names, board and state shapes, routes, page
tags, and the exact wording tests search for. Everything a competent developer
should work out (the rules of backgammon, how to structure the engine, how to
make the AI strong or fast) is deliberately NOT there.

If you change what the tests require, change the prompts too; this file is the
record of intent, not a delivery surface.
