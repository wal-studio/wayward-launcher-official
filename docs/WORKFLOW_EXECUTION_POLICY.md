# WORKFLOW EXECUTION POLICY

## End-to-end responsibility and time discipline
- Own routine investigation and execution through verified completion. Do not stop after an investigation summary, job launch, build, upload, or download.
- Track async job/run IDs and poll them; inspect logs and artifacts as soon as available.
- While a job runs, perform independent safe work. Avoid idle waiting and unnecessary broad reruns.
- Reuse verified evidence. Do not repeat checks without a concrete reason.
- Do not send progress-only updates in place of work or ask the user to monitor routine progress.

## CI and artifacts
On failure, identify the first failing job/step, retrieve full relevant logs, test reports, crash output, and diagnostic artifacts, then isolate code/config/environment/permission/quota causes. Fix in-scope causes and rerun the smallest sufficient set.
For artifacts, list and retrieve relevant outputs; inspect contents, existence, size, integrity, and downloadability. A workflow upload message is not proof that an artifact is accessible. Report build success and upload failure separately.

## User involvement
Do not delegate repository inspection, branch checks, log retrieval, test analysis, builds, packaging, or artifact checks when tools and permissions allow agent execution. Request only indispensable user action involving physical hardware, account approval, unavailable credentials, or an explicitly reserved decision. Ask one specific actionable question.

## Project and ownership boundaries
Keep Android, PC Host, infrastructure, and other workstreams isolated. Verify cross-project interfaces without editing code owned by another workstream. Preserve all existing work, data, configuration, and history. No force-push, destructive reset, unauthorized merge, release, deployment, or production mutation.

## Final report
State repository, branch, baseline and final SHA; changed files; exact checks and outcomes; CI run identifiers; artifact locations and verified links; unperformed checks with reasons; remaining risks/blockers. Never claim unobserved success.

## Official release branch — explicit authorization required
- Official Android release baseline: `release/android-diagnostics-retention-1.0.0`, code baseline commit `2af1eaa688fb30dfbbd9b5a23b82210631f58c4e` (2026-11-20; diagnostics stack-retention strengthening). Treat this exact source state as the current release reference point. Policy-only commits may be added without changing the pinned code baseline.
- The release branch, release source, release configuration, release tests, version metadata, build/package outputs, and release validation workflows are read-only by default. Do not edit, refactor, reformat, cherry-pick into, merge into, rebuild, rerun tests against, or otherwise operate on the release version unless the user explicitly says that the release version is to be modified or tested.
- A request to work on Android generally, a development branch, PC pairing, diagnostics, or another feature is NOT authorization to touch the official release branch/version.
- Perform ongoing implementation and ordinary regression testing on a separate development/work branch. Keep development-only features (including PC pairing, which is not part of the public Android release) out of release validation.
- If explicit release work is authorized, limit the scope to the named modification or test, preserve the pinned baseline and unrelated release content, and report the exact branch, commit, files, and checks. Do not infer permission for additional release changes or tests.
- This rule is a hard boundary for all subsequent work and takes precedence over generic workflow instructions. If uncertain whether a request authorizes release work, do not touch the release branch/version; ask one concise clarification.
