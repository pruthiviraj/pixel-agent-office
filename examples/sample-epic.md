# Epic: Add a tiered discount engine to checkout

> An epic is just a plain-English description of the work. The PM agent reads
> it and breaks it into parallel dev + QA tasks. Keep it outcome-focused; let
> the team decide the breakdown.

## Goal
Customers should get an automatic discount based on cart total, with the rule
set configurable by an admin and every applied discount auditable.

## What "done" looks like
- An admin can define tiered rules (e.g. spend ≥ $100 → 10% off, ≥ $250 → 15%).
- Checkout applies the single best-matching tier to the cart total.
- The checkout summary shows the applied rule name and the amount saved.
- Every applied discount is recorded for reporting, and rolls up per order.
- Rules and the engine are covered by tests; boundaries (exactly $100) are correct.

## Out of scope
- Coupon codes / per-customer discounts (a later epic).
- Currency/locale handling beyond the existing setup.

## Notes
- Follow the existing project conventions and test setup.
- Prefer extending existing services over introducing new patterns.
