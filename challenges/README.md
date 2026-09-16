# Challenges

A challenge is what the benchmark builds and grades. Backgammon is the example
that ships with this repo (`task/backgammon/`); it is not the system.

**A challenge is its own git repo.** Nothing here tracks yours — this directory
is ignored, so `git clone` your challenge into it and the benchmark will not try
to own it:

```
cd challenges
git clone <your-challenge-repo> my-challenge
```

Then point a run at it:

```
export BENCH_TASK_DIR=$(pwd)/challenges/my-challenge
```

Unset, the benchmark runs its own backgammon example.

`TEMPLATE/` is a skeleton to copy as the starting point for a new challenge
repo. Its README explains what each piece is for and which parts the grading
suite has to provide.
