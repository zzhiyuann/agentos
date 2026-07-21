# Generic Completion Grading Rubric

Used by the headless grader when an issue has no cached structured spec
(acceptance criteria). Grade the attempt 0-10 against these criteria:

## Completeness (0-3)
- Does the handoff address everything the issue title/description asked for?
- Are all stated deliverables actually present (files, fixes, documents)?
- Were any parts of the task silently dropped or deferred without a tracked issue?

## Correctness (0-3)
- Does the diff (when present) plausibly implement what the handoff claims?
- Are there obvious bugs, dead code paths, or contradictions between the
  handoff narrative and the actual changes?
- For non-code work: is the deliverable internally consistent and specific?

## Verification (0-2)
- Did the agent describe how the work was tested/verified (tests run,
  commands executed, output checked)?
- Is the verification appropriate for the blast radius of the change?

## Handoff Quality (0-2)
- Is the handoff specific (what changed, where, why) rather than generic?
- Are follow-ups tracked as issue keys instead of vague prose suggestions?

## Verdict
- `pass`: score >= 6 and no critical gaps (missing deliverable, untested
  risky change, claims contradicted by the diff).
- `fail`: anything else. The critique must state concretely what the agent
  must do to pass.
