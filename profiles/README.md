# Profiles

A **profile** tells the orchestrator how to brief its PM / developer / QA
agents for your tech stack. Pick one with `--profile <name>` (or `ORCH_PROFILE`);
the default is [`software`](./software.js).

```bash
node orchestrate.js --epic ./epic.md                      # software (default)
node orchestrate.js --epic ./epic.md --profile salesforce # Salesforce DX
```

## Shipped profiles
- **[`software.js`](./software.js)** — generic; works for any codebase. The default.
- **[`salesforce.js`](./salesforce.js)** — a worked example of specialising to a
  stack (Apex/LWC/metadata, `sf` test commands, visual-QA against mockups).

## Write your own
Copy `software.js` to `profiles/<your-stack>.js` and edit the fields. Any
`{PROJECT}` placeholder is replaced with the absolute project path at runtime.

| Field | Used for |
|---|---|
| `name` | profile id (must match the filename) |
| `stackLabel` | fills the PM prompt: *"…PROJECT MANAGER for **{stackLabel}**…"* |
| `taskDescriptionHint` | guides how concrete each task description must be |
| `devRole` | the developer agent's opening role line |
| `devGuidance` | the working agreement (conventions, testing, "don't deploy to prod") |
| `qaRole` | the QA agent's opening role line |
| `qaCommandsHint` | how the QA agent should verify (your test/build/lint commands) |
| `visualQA` | optional extra QA step (e.g. screenshot-vs-mockup). `""` to skip |
| `examplePlan` | the task graph shown by `--dry-run` (so people can see the loop) |

That's the whole contract — a profile is just a plain object. Nothing else in
the orchestrator is stack-specific.
