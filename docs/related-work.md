# Related work

> Surveyed in October 2026. Work on agent memory moves fast; corrections and additions are welcome.

Learning-Index asks three questions (see the [methodology](methodology.md)): does a memory system
make an agent's work better; as memory grows, where does it turn from helping to hurting; and how
does memory respond when the job changes. This page sets out what existing work already measures,
what it does not, and where Learning-Index fits.

## Conversational memory benchmarks

The benchmarks memory products report on ask questions about long conversations.

- [LoCoMo](https://arxiv.org/abs/2402.17753) (2024): very long, many-session conversations between
  two personas, with questions on single-hop, multi-hop, temporal, open-domain and adversarial
  recall.
- [LongMemEval](https://arxiv.org/abs/2410.10813) (2024): questions over long chat histories,
  testing information extraction, multi-session reasoning, temporal reasoning, knowledge updates and
  abstention.
- [MemoryAgentBench](https://arxiv.org/abs/2507.05257) (2025): incremental multi-turn interactions,
  testing accurate retrieval, test-time learning, long-range understanding and conflict resolution.

Products publish their results on these: [Mem0](https://arxiv.org/abs/2504.19413) on LoCoMo, with
latency and the tokens memory adds per question; [Zep](https://arxiv.org/abs/2501.13956) on Deep
Memory Retrieval and LongMemEval; [Letta](https://arxiv.org/abs/2310.08560) (the MemGPT team) on
multi-session recall tasks.

The numbers are contested. Zep publicly
[disputed](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
how Mem0's paper had configured Zep on LoCoMo. Letta
[reported](https://www.letta.com/blog/benchmarking-ai-agent-memory) that an agent that simply stores
conversation histories in files scores 74.0% on LoCoMo, above Mem0's reported 68.5%. A
[2026 diagnostic study](https://arxiv.org/abs/2603.02473) found that the retrieval method mattered
far more than how memories were written, and that storing raw chunks, with no model calls at all,
matched or beat Mem0-style fact extraction. Together these suggest the benchmarks reward retrieval
more than memory.

**What these benchmarks do not do:** run an agent's work, or price what memory costs inside a
working agent.

## Agents that learn from experience

Research on agents that learn from their own past comes closer to the question.

**Methods.** [Reflexion](https://arxiv.org/abs/2303.11366) (2023) retries the same task, carrying
the agent's written reflections forward. [ExpeL](https://arxiv.org/abs/2308.10144) (2023) distils
insights from past tasks. [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) (2024) reuses
workflows from past web tasks. [Dynamic Cheatsheet](https://arxiv.org/abs/2504.07952) (2025) keeps
an evolving memory across a stream of problems: on Game of 24, GPT-4o's success rose from 10% to 99%
once it found a Python solution and reused it. [ReasoningBank](https://arxiv.org/abs/2509.25140)
(2025) distils strategies from successes and failures, and reports higher success and fewer steps
on web and software-engineering tasks. [ACE](https://arxiv.org/abs/2510.04618) (2025) evolves a
playbook of strategies, and reports lower adaptation latency and rollout cost.

**Benchmarks.**

- [Evo-Memory](https://arxiv.org/abs/2511.20857) (2025) runs more than ten memory modules over
  streams of tasks, programming among them.
- [EvoMemBench](https://arxiv.org/abs/2605.18421) (2026) compares fifteen memory methods with
  long-context baselines. The long-context baselines stay highly competitive, and no single kind of
  memory works everywhere.
- [SWE-Bench-CL](https://arxiv.org/abs/2507.00014) (2025) orders real GitHub issues by time and
  measures forgetting, transfer and tool-use efficiency with memory on and off.
- [AgentCL](https://arxiv.org/abs/2606.02461) (2026) builds task streams in which later tasks depend
  on earlier ones, and finds that memory can make agents worse on streams where nothing transfers.
- [MemOp](https://arxiv.org/abs/2606.05646) (2026) scores memory for software-engineering agents by
  its effect downstream, reporting success, efficiency and compute cost.
- [Memory Transfer Learning](https://arxiv.org/abs/2604.14004) (2026) finds that coding memories
  transfer across domains as high-level insights, while low-level traces often hurt.

**Memory can hurt.** A [study of experience-following](https://arxiv.org/abs/2505.16067) (2025)
found that agents copy what a similar past record did, so errors in memory propagate and compound as
the agent's own outputs flow back in. A [study of memory retention](https://arxiv.org/abs/2606.29178)
(2026) found retrieval precision falling as unfiltered, noisy memory grew.

**What this work does not do:** let third-party memory systems plug in unchanged — almost all of it
tests the authors' own methods — or follow one model through a long series, against its own
no-memory baseline, to find where growing memory turns.

## Memory for coding agents, tested by running the work

- **AMB** ([announcement](https://discuss.huggingface.co/t/open-call-test-your-agent-memory-layer-on-an-adversarial-coding-benchmark/179762),
  [repository](https://github.com/GiulioDER/agent-memory-bench), September 2026) is the closest
  project: an open, preregistered benchmark of pluggable memory layers for Claude Code, graded by
  executable checks, with a no-memory arm and an arm that has the same instructions but no memory.
  It plants absent, stale, superseded, contradictory, adjacent and irrelevant memories. By its
  author's account it currently tests the read path, with memories written by hand, and does not
  yet test memory learned from the agent's own work across sessions.
- [Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) (2026) found that repository context
  files given to coding agents did not raise task success, and raised inference cost by more than
  20%.

## What memory costs

Weighing cost alongside accuracy has been standard advice in agent evaluation since
[AI Agents That Matter](https://arxiv.org/abs/2407.01502) (2024); the
[Holistic Agent Leaderboard](https://arxiv.org/abs/2510.11977) (2025) reports cost across 21,730
agent runs. Studies of coding agents add what matters for memory:

- Agentic coding uses about 1,000 times more tokens than code chat, input tokens drive the cost, and
  two runs of the same task can differ thirty-fold in tokens
  ([How Do AI Agents Spend Your Money?](https://arxiv.org/abs/2604.22750), 2026).
- Cutting tokens is not cutting cost. Compression that removed 38.4% of tool-output tokens raised
  Claude Code's billed cost by 6.8%, because prompt-cache creation and reads dominate the input side
  ([Token Reduction Is Not Cost Reduction](https://arxiv.org/abs/2607.12161), 2026).
- Equal token budgets do not mean equal delivered context, or equal management cost
  ([Measure Before You Manage](https://arxiv.org/abs/2608.31057), 2026).

So memory's cost has to include the context it adds on every turn, read back from cache, and the
work the memory system does on its own.

## Memory under change

Stale memory is studied, but in question-and-answer and decision tests:

- [STALE](https://arxiv.org/abs/2605.06527) (2026): 400 scenarios in which a later observation
  quietly invalidates an earlier memory; the best model evaluated reached 55.2%.
- [StateMemBench](https://arxiv.org/abs/2608.19652) (2026): multi-session scenarios graded on
  whether answers reflect the current state or a superseded one. Hard for memory systems, retrieval
  and long context alike.
- [MemStrata](https://arxiv.org/abs/2606.26511) (2026): when a function is renamed or a version is
  bumped, plain retrieval serves the superseded value 15–40% of the time.
- [The Memory Trust Gap](https://arxiv.org/abs/2609.01852) (2026): models relied on a stale stored
  value 92–100% of the time, at every model size tested.
- [When Stale Constraints Go Unchecked](https://arxiv.org/abs/2608.25553) (2026): sixteen models
  rarely re-checked an inherited constraint that read as settled, and made stale-consistent
  decisions in about three-quarters of episodes after it had been withdrawn — the "negative
  knowledge" problem.

Conversational benchmarks touch change as knowledge updates (LongMemEval) and conflict resolution
(MemoryAgentBench), and AMB plants stale memories by hand. None measures what happens when memory a
system learned from real work meets a job that has changed, by running the work that follows.

## Where Learning-Index fits

| | Conversational benchmarks | Experience-learning work | AMB | Learning-Index |
|---|---|---|---|---|
| Judged by running the work | No — answers to questions | Often | Yes | Yes |
| Memory learned from the agent's own work | No | Yes | Not yet | Yes |
| Any memory system plugs in unchanged | Vendors run their own | Mostly the authors' own methods | Yes | Yes |
| A long series against the same model's no-memory baseline | No | Streams of different tasks | Not a series | Yes |
| Cost, including re-read context and memory's own work | Tokens per question, at most | Steps or compute, in some | Not described | Yes |
| Memory under change, in executed work | Knowledge updates in conversation | No | Stale memories planted by hand | Question 3 |

As of October 2026 we found no benchmark that does all of the following. Learning-Index is built to:

1. Read back memory that a system learned from the agent's own executed work, over a long series,
   measured against the same model's no-memory baseline (questions 1 and 2).
2. Price that memory in tokens — including the context it adds on every turn and the system's own
   background work — and find where its gains turn into losses.
3. Change the job on purpose, and measure how the memory responds by running the work that follows
   (question 3).
4. Let any memory system plug in unchanged, in an open harness, with every run fingerprinted.

AMB and Learning-Index are complementary: AMB tests the read path under planted conditions;
Learning-Index tests the write-and-read loop under real ones.
