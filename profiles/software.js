/**
 * Profile: software (the default)
 * ------------------------------------------------------------------
 * A profile tells the orchestrator how to talk to its PM / developer /
 * QA agents for a given tech stack. This generic "software" profile
 * works for any codebase. Copy it to make your own (see profiles/README.md).
 *
 * Placeholders: any `{PROJECT}` in a string is replaced with the absolute
 * path of the project the agents are working in.
 */
module.exports = {
  name: "software",

  // Used in the PM planning prompt: "...PROJECT MANAGER for {stackLabel} at ..."
  stackLabel: "a software project",

  // Hint injected into the task "description" field the PM must produce.
  taskDescriptionHint: "concrete and implementation-specific",

  // Developer agent role + working agreement.
  devRole:
    "You are a SOFTWARE DEVELOPER agent on a team, working in the project at {PROJECT}.",
  devGuidance:
    "Follow the repo's existing conventions and any README / CONTRIBUTING / AGENTS.md / CLAUDE.md. " +
    "Write or update tests where relevant. Keep the change scoped to this task. " +
    "Do not deploy to production or push to remote unless the task explicitly says so.",

  // QA agent role + what "verify" means for this stack.
  qaRole: "You are a QA / TEST agent, working in the project at {PROJECT}.",
  qaCommandsHint:
    "the project's own test, build and lint commands (e.g. `npm test`, `pytest`, `go test ./...`, `make check`, eslint)",

  // Optional extra QA instructions (e.g. visual/screenshot checks). Empty = skip.
  visualQA: "",

  // Shown by `--dry-run` so people can see the loop with no API spend.
  examplePlan: {
    summary:
      "Add a tiered discount engine to checkout — rules model, service, UI hook, audit.",
    tasks: [
      {
        id: "T1",
        title: "Discount rule data model",
        description:
          "Define the data model + migration for tiered discount rules (threshold, percent, priority).",
        components: ["models/DiscountRule", "migrations/"],
        acceptance: ["migration applies cleanly", "rules uniquely keyed by (threshold, priority)"],
        deps: [],
        qa: { title: "validate schema/migration", checks: ["apply migration on a scratch DB", "unit test the model"] },
      },
      {
        id: "T2",
        title: "DiscountService",
        description:
          "Pure service that selects the best matching tier for a cart total; fully unit-tested incl. boundaries.",
        components: ["services/DiscountService"],
        acceptance: ["correct tier at boundaries", ">=90% branch coverage"],
        deps: ["T1"],
        qa: { title: "run DiscountService tests", checks: ["npm test -- DiscountService"] },
      },
      {
        id: "T3",
        title: "Checkout summary hook",
        description: "Surface the applied discount + savings line in the checkout summary component.",
        components: ["ui/CheckoutSummary"],
        acceptance: ["shows applied rule + amount", "no layout regression"],
        deps: ["T2"],
        qa: { title: "component render test", checks: ["npm test -- CheckoutSummary"] },
      },
      {
        id: "T4",
        title: "Discount audit log",
        description: "Record each applied discount for reporting and roll it up per order.",
        components: ["services/AuditLog"],
        acceptance: ["one record per applied discount", "order rollup total matches"],
        deps: ["T2"],
        qa: { title: "audit + rollup tests", checks: ["npm test -- AuditLog"] },
      },
    ],
  },
};
