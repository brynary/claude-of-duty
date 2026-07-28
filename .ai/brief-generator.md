# Generate the shared agent brief

You are the parent agent preparing this repository for a dynamic workflow that
runs multiple implementation agents in parallel.

## Goal

Create or update `.ai/AGENT_BRIEF.md`. The result is the binding shared contract
that every workflow agent reads before its specialized prompt.

The brief must capture facts and rules shared by all agents. Keep subsystem
assignments and implementation details in `.ai/workflow.js`; do not duplicate
them in the shared brief.

Do not launch the workflow or implement any subsystem while performing this
task.

## Inputs

Use these sources:

1. The current user's top-level project request and acceptance criteria.
2. All applicable repository instruction files and current session
   instructions.
3. `.ai/workflow.js`, especially its agent labels, ownership boundaries,
   phases, and verification expectations.
4. The repository's source, configuration, package manifest, lockfile, and
   validation tools.
5. `.ai/VISUAL_RUBRIC.md` and similar project-specific acceptance documents.
6. The existing `.ai/AGENT_BRIEF.md`, if present. Treat it as a draft to verify,
   not as an authoritative source.

If the top-level project request is unavailable, ask the user for it before
writing the brief.

## Inspect before writing

Read enough of the repository to establish:

- The project's purpose, technology, and measurable quality bar.
- The public interfaces between subsystems and the system lifecycle.
- The files that define shared types, events, configuration, deterministic
  behavior, fixed test or capture scenarios, and service registration.
- The dependency versions and scripts actually present in `package.json` and
  the lockfile.
- The workflow's file-ownership boundaries and which files no parallel agent
  owns.
- Which validation commands are safe while agents run concurrently. Avoid
  commands that contend for a shared output directory, port, snapshot, or other
  mutable resource.
- Performance budgets, determinism requirements, asset restrictions, and
  browser/runtime constraints that are supported by repository evidence.
- Existing uncommitted work. Treat changes outside this task as belonging to
  the user or other agents.

Prefer repository-relative paths. Do not inspect or reproduce secrets,
credentials, generated build output, dependency source trees, or unrelated
user files.

## Resolve conflicts

Follow higher-priority user and repository instructions first. Reconcile the
workflow against the current source rather than assuming either is current.

Do not silently invent a rule when sources disagree. Put a conservative,
non-destructive rule in the brief when possible and report the unresolved
conflict to the user. Never broaden an agent's file ownership based on an
assumption.

## Required contents

Write the brief in plain language, using this structure when applicable:

1. **Mission** — what all agents are collectively building and the shared
   acceptance standard.
2. **Read these first** — a short list of exact repository files that define
   the cross-system contract, with one sentence explaining each.
3. **Shared architecture** — lifecycle, service boundaries, event flow, units,
   coordinate conventions, determinism, and other facts every subsystem must
   honor.
4. **Parallel-work rules** — edit only assigned files, preserve other work,
   avoid shared mutable outputs, and coordinate through existing interfaces.
5. **Dependencies and assets** — exact available packages and the rules for
   adding dependencies, fetching resources, or generating assets.
6. **Quality and performance bar** — concrete, project-specific failure modes
   and budgets supported by the request or repository.
7. **Verification** — exact commands each agent may safely run, including how
   to distinguish errors in owned files from transient errors caused by other
   agents.
8. **Completion report** — what each agent must report: files changed, major
   techniques, checks run, limitations, and assumptions other systems must
   honor.

Also include a concise protected-files rule for shared files that parallel
agents must not edit. Derive it from the workflow and architecture; do not
guess.

## Accuracy and style

- Make the brief self-contained, concise, and operational.
- Include only shared rules. A rule relevant to one subsystem belongs in that
  subsystem's workflow prompt.
- Copy exact commands, paths, package names, and versions from the repository.
- Use repository-relative paths and avoid machine-specific absolute paths.
- Do not claim that a tool, service, test, or asset exists without verifying
  it.
- Do not preserve stale details merely because they appear in the previous
  brief.
- Explain unusual restrictions briefly so agents understand the race or
  failure they prevent.
- Avoid motivational filler and vague standards such as "make it good."
- Keep the document short enough that every agent can read it before starting.

## Validate the result

Before finishing:

1. Confirm every referenced file exists.
2. Confirm every command and dependency matches the current repository.
3. Compare ownership and protected-file rules with `.ai/workflow.js`.
4. Check that the brief does not assign implementation work or contradict an
   agent's specialized prompt.
5. Review the diff for `.ai/AGENT_BRIEF.md` only.

Write only `.ai/AGENT_BRIEF.md`. Do not modify `.ai/workflow.js`, application
code, dependency files, or Git history. In the final response, summarize the
brief's source inputs and list any unresolved conflicts or missing information.
