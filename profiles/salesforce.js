/**
 * Profile: salesforce  (example of adapting the office to a specific stack)
 * ------------------------------------------------------------------
 * This is the profile the office was originally built with — a Salesforce
 * DX (Apex / LWC / metadata) project. Use it as a worked example of how
 * much a profile can specialise the agents:  `--profile salesforce`.
 */
module.exports = {
  name: "salesforce",

  stackLabel: "a Salesforce (SFDX) project",
  taskDescriptionHint: "Salesforce-specific (Apex classes / LWC / triggers / metadata)",

  devRole:
    "You are a SALESFORCE DEVELOPER agent on a team, working in the SFDX project at {PROJECT}.",
  devGuidance:
    "Follow the repo's existing conventions and CLAUDE.md. One trigger per object delegating to a handler; " +
    "bulkify everything (no SOQL/DML in loops); use `with sharing` unless there's a documented reason not to; " +
    "write meaningful Apex tests (positive + negative + 200-record bulk; aim well above 75% coverage). " +
    "Do not deploy to production.",

  qaRole:
    "You are a SALESFORCE QA / TEST agent, working in the SFDX project at {PROJECT}.",
  qaCommandsHint:
    "`sf apex run test -l RunLocalTests`, `npm run test:unit` (LWC Jest), eslint, and " +
    "`sf project deploy start --dry-run -l RunLocalTests` (check-only validate)",

  visualQA:
    "VISUAL QA (only if this task builds or changes a UI screen): deploy the component, run the repo's " +
    "screenshot script (e.g. `node scripts/screenshot-*.js`), open the produced `shots/*.png`, and COMPARE it " +
    "against the referenced mockup/spec page. FAIL if any specified panel is missing, mis-laid-out, " +
    "wrong-colored, or otherwise deviates from the spec.",

  examplePlan: {
    summary:
      "Weighted cutoff / eligibility engine + Coordinator generator on the existing Shortlist model.",
    tasks: [
      {
        id: "T1",
        title: "Weighted criteria model on Shortlist__c",
        description:
          "Store a weighted rule set (criterion/operator/threshold/weight, totalling 100%) + aggregate config; add a small child object if needed.",
        components: ["Shortlist__c", "Shortlist_Criteria__c"],
        acceptance: ["weights validated to 100%", "schema deploys check-only"],
        deps: [],
        qa: { title: "validate cutoff schema", checks: ["sf project deploy start --dry-run -l RunLocalTests"] },
      },
      {
        id: "T2",
        title: "Weighted eligibility engine (ShortlistService)",
        description:
          "Compute the weighted aggregate per Application__c, apply gates + cutoff, rank; bulk-safe via Batch/Queueable.",
        components: ["ShortlistController.cls", "ShortlistService.cls", "ShortlistServiceTest.cls"],
        acceptance: ["aggregate math correct", "bulk-safe over 200+ apps", ">=75% coverage"],
        deps: ["T1"],
        qa: { title: "run ShortlistService tests", checks: ["sf apex run test -t ShortlistServiceTest -l RunLocalTests"] },
      },
      {
        id: "T3",
        title: "Live impact preview",
        description:
          "Read-only Apex returning eligible count, pass rate and ranked applicants with per-criterion pass/fail; commits nothing; governor-safe.",
        components: ["ShortlistController.cls", "AdmissionControllersTest.cls"],
        acceptance: ["preview count = post-publish count", "no DML in preview"],
        deps: ["T2"],
        qa: { title: "verify preview matches publish", checks: ["sf apex run test -t AdmissionControllersTest"] },
      },
      {
        id: "T4",
        title: "Cutoff Generator LWC + publish/notify",
        description:
          "cutoffEligibilityGenerator LWC: rule builder, live preview, Approve→Publish→Notify; publish de-dupes criteria, advances Applications, reuses notifications.",
        components: ["cutoffEligibilityGenerator", "ShortlistController.cls"],
        acceptance: ["publish idempotent/de-duped", "notify fires once", "publish blocked when invalid"],
        deps: ["T2"],
        qa: { title: "jest + publish/notify tests", checks: ["npm run test:unit", "sf apex run test -t ShortlistControllerTest"] },
      },
    ],
  },
};
