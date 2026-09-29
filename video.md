# YouTube kit

## Title options

1. My On-Call AI Agent Stopped Repeating Failed Fixes (Hindsight Memory)
2. Right Fix First Try: 0% → 70% With Agent Memory
3. Why Your AI On-Call Assistant Keeps Saying "Restart the Pods"
4. I Gave My Incident Agent a Memory: Here's What Changed
5. Agent Memory vs Plain LLM: A Live On-Call Incident Test

## Description

At 2:47am, a plain LLM will happily tell you to restart the pods, even when the last post-mortem says that didn't help. Déjà Vu is an on-call agent that remembers every past incident with Hindsight agent memory: what the root cause was, the exact runbook fix that worked, which fixes failed, and who resolved it.

In this video:
- The same alert diagnosed side by side, without memory and with memory
- INC-2369: a generic "roll back the deploy" vs PayNest's actual runbook `RB-PG-07`
- The feedback loop: mark a fix as failed, re-run, and watch the agent switch to `RB-REL-02`
- The Memory Inspector: every recalled memory, observation and cited incident
- The learning curve from an empty memory bank

Results (40 incidents replayed chronologically from an empty bank):
- Right fix first try: 0% without memory → 70% with memory (82% on repeat failures)
- Already-failed fixes recommended again: 9 → 2
- Root-cause family accuracy: roughly even (88% vs 90%). Guessing the category was never the hard part.

🔗 Live demo: https://deja-vu-lake.vercel.app
💻 Code: https://github.com/SANTHOSHINI-CHIDIRALA/deja-vu
🧠 Hindsight (agent memory): https://github.com/vectorize-io/hindsight
📖 Hindsight docs: https://hindsight.vectorize.io/

Suggested chapters (adjust to the final cut):
0:00 The 2:47am problem
0:15 Same alert, two agents
0:50 Memory Inspector: what it actually used
1:15 "This suggestion failed" → the agent adapts
1:55 A red herring: GC pauses that were really a bank timeout
2:30 Learning curve: right fix first try, 0% → 70%
2:55 Takeaways

Built with Next.js, TypeScript, Groq and Hindsight.

#AIAgents #AgentMemory #Hindsight #LLM #SRE #OnCall

## Thumbnail prompt (Nano Banana)

> A dark, cinematic YouTube thumbnail, 16:9, 1280×720. Left half: a tired on-call engineer's face lit by a laptop screen at night, a red PagerDuty-style alert glowing "SEV1 · 2:47 AM". Right half: a sleek dark ops-console split into two panels: the left panel greyed out with a crossed-out line "restart the pods ✕", the right panel glowing amber with a clean terminal line "RB-PG-07: pnctl db pool-cap" and a small green checkmark. Between them, a bold amber arrow. Big, heavy, high-contrast headline text across the top: "IT REMEMBERED THE FIX". Small secondary text bottom-right: "0% → 70%". Style: modern tech YouTube thumbnail, crisp, high contrast, amber (#f5a524) and deep navy (#0a0d12) palette, subtle glow, no clutter, text large enough to read on a phone. No logos, no real people's likeness.
