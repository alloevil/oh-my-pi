# Outcome label queue

Pre-labeled by deterministic heuristics (in-flight ending → abandoned;
unverified tail → partial; ≥2 warn findings → partial; else done). The
suggestion is a starting point, not a verdict — correct any row that
misremembers reality, then run its command (edit the outcome word first if
the suggestion is wrong). Relabeling later is fine: last label wins.

This queue is the unblocking prerequisite for the offline-judge tier
(semantic error detection: task regression, instruction violations,
fabricated claims). Regenerate anytime by re-running the pre-label probe.

---

- **_019fbb57-325a-7000-b9b9-c630e73d79f** (347 msgs) — "当前项目有优化的点吗"
  - suggest: **done** (verified/quiet ending)
  - confirm: `omp label done /Users/allo/.omp/agent/sessions/-weibo-chat-auto/2026-08-01T03-21-21-754Z_019fbb57-325a-7000-b9b9-c630e73d79f2.jsonl`
- **_019fa2f0-9821-7000-b125-0afafe16410** (2043 msgs) — "hi"
  - suggest: **abandoned** (ends mid-turn)
  - confirm: `omp label abandoned /Users/allo/.omp/agent/sessions/-Downloads/2026-07-27T09-38-24-417Z_019fa2f0-9821-7000-b125-0afafe16410a.jsonl`
- **_019fc2d0-dd96-7000-a3d9-acab855c93f** (77 msgs) — "你看下这篇论文 agent harness:a survey"
  - suggest: **abandoned** (ends mid-turn)
  - confirm: `omp label abandoned /Users/allo/.omp/agent/sessions/-Downloads/2026-08-02T14-11-35-958Z_019fc2d0-dd96-7000-a3d9-acab855c93fa.jsonl`
- **_019fa764-c105-7000-b621-c1329473d20** (151 msgs) — "目前你使用的web search是什么"
  - suggest: **partial** (3 warn findings)
  - confirm: `omp label partial /Users/allo/.omp/agent/sessions/-Downloads/2026-07-28T06-23-45-925Z_019fa764-c105-7000-b621-c1329473d20e.jsonl`
- **_019fad8b-2447-7000-b72f-13a6d53c06e** (88 msgs) — "mac上的邮件，该怎么整理"
  - suggest: **done** (verified/quiet ending)
  - confirm: `omp label done /Users/allo/.omp/agent/sessions/-Downloads/2026-07-29T11-03-24-999Z_019fad8b-2447-7000-b72f-13a6d53c06e1.jsonl`
- ~~_019fac75-730d-7000-ab46-05190f8fb6b~~ — already labeled
- **_019fb22c-f1a1-7000-9361-b99a6a25b6b** (861 msgs) — "我现在有一个痛点，本地安装了codex claud code omp等，都会使用，但目前管理session比较困难"
  - suggest: **abandoned** (ends mid-turn)
  - confirm: `omp label abandoned /Users/allo/.omp/agent/sessions/-Downloads/2026-07-30T08-38-37-729Z_019fb22c-f1a1-7000-9361-b99a6a25b6bb.jsonl`
- **_019fbb56-9d9e-7000-97ac-4b3ce551444** (213 msgs) — "看下当前项目，有需要优化的点吗"
  - suggest: **done** (verified/quiet ending)
  - confirm: `omp label done /Users/allo/.omp/agent/sessions/-Documents-xiaomi-TabCraft/2026-08-01T03-20-43-678Z_019fbb56-9d9e-7000-97ac-4b3ce551444a.jsonl`
- **_019fc2c6-df48-7000-97d1-4de167ed5f2** (101 msgs) — "当前项目有哪些问题"
  - suggest: **abandoned** (ends mid-turn)
  - confirm: `omp label abandoned /Users/allo/.omp/agent/sessions/-foodmap/2026-08-02T14-00-41-032Z_019fc2c6-df48-7000-97d1-4de167ed5f2f.jsonl`
- **_019fb5d6-39c9-7000-9f81-605343704fa** (297 msgs) — "看下当前目录"
  - suggest: **partial** (2 warn findings)
  - confirm: `omp label partial /Users/allo/.omp/agent/sessions/-Documents-personal-resume/2026-07-31T01-42-23-433Z_019fb5d6-39c9-7000-9f81-605343704fad.jsonl`
