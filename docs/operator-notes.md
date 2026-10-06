# Notes from the operator

Learning-Index was built with AI coding agents, iteration by iteration, and I was the conductor of
that orchestration. These notes set out the choices I made along the way, and what operating the
benchmark has demanded.

**1. Why backgammon.** Backgammon was a prime candidate for the challenge precisely because it is
not novel. The game goes back centuries and its rules are written down everywhere, so any model
should already carry its mechanics in its training data. That is the point: when a model fails
here, it should be failing to build the software, not failing to know the game.

**2. Balance.** This system works because of balance. The challenge must not be too hard, and it
must not be too easy. Too easy, and the results hit a ceiling: the first build passes every check,
and nothing is left to fix. Too hard, and they hit a floor: the model never reaches green, and no
chain finishes. Between the two lies the surface area the benchmark needs: room for problems to
occur, and for each failure-to-green to run its course. That surface is the basis of everything
the benchmark measures.

**3. Determinism.** The hardest problem has been determinism. Variance is inherent in an agentic
system — the model samples, and no two runs are alike — but some of it can be eliminated. No LLM
acts as a judge anywhere in the benchmark: the grader runs the game, and each check passes or
fails. And the loop of trial, problem, prompt and resolution is choreographed the way a person
would speak to an agent in a coding session. What is still broken reaches the model in a player's
words, and the same failure is always told the same way. The variance that remains belongs to the
model, not to the instrument.

**4. Calibration.** Much of the work has been calibration, done by hand, in three steps. First, the
grader against the game: I play it myself and confirm that the grader passes what works and fails
what does not. Second, the grader against the prompt: what the grader finds, and what I find by
playing, must match what the model is told at prompt time. Third, the prompt against the answer:
does it give the fix away, or leave the model with information too ambiguous to act on? Each step
is an exercise in balance, and I am the key component in it. Agents do not yet know how to prompt
this way: to describe a problem as a player meets it, precisely enough to act on, without handing
over the fix.

**5. Context.** Context in this system is managed with care. Too much compression gave poor
results: after each summary, the agent could no longer gauge where it had been, or which fixes it
had already attempted. The result was a problem-fix oscillation, in which the model fixed a
problem, broke it, and fixed it again, round after round. Compression now happens only at fixed
points between build steps. Troubleshooting rounds keep their full history, and when a context
fills, the chain continues in a fresh context rather than a summarised one.
