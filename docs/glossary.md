# Glossary

Words as they appear on screen, and their technical counterparts in this specification.

| On screen | Technical term | Meaning |
|-----------|----------------|---------|
| Workspace | `workspace` | One person's or team's store of projects, rules and history. The isolation boundary |
| Project | `project` | A unit of ongoing work with its own folders, facts and rules |
| Project fact | `project.facts` | A human-confirmed attribute of a project (customer, sector) that rules can be scoped by |
| Folder | `folder_binding` | A registered folder on a device, tied to a project |
| Area | `area` | A sub-folder of a project with extra rules or a different default work type |
| Work type | `work_type` | The kind of thing being produced; defines which fields rules can talk about |
| Correction | `correction` | What a person said was wrong, kept verbatim |
| Rule | `rule`, `rule_revision` | A reviewed requirement derived from a correction; edits create new revisions |
| (behind "Details") | typed rule | The structured form of a rule that the product evaluates: a check type from a fixed list plus its settings. The sentence on screen is generated from it |
| Kind (Exact / Trusted source / Person confirms / AI opinion) | `method`: `deterministic`, `source_backed`, `attested`, `model_review` | How a rule's answer is known |
| Must fix / Note | `enforcement`: `block`, `warn` | What happens when a rule is not met |
| On / On trial / Paused / Retired | `status`: `active`, `trial`, `suspended`, `retired` | Lifecycle state of a rule (`candidate` and `rejected` appear only in review queues) |
| Example (blocks / allows) | `case` (`negative` / `positive`) | A stored test of a rule with an expected result |
| Tried on existing work | backtest, dry run | Evaluating a candidate rule on existing artifacts without consequence |
| Trusted source | `source`, `source_snapshot` | A reference list someone vouches for, and one immutable imported version of it |
| File, document, piece of work | `artifact`, `artifact_version` | A tracked piece of work, and one exact content of it identified by hash |
| Check (Check 1, Check 2…) | `run` | One evaluation of one artifact version for one action |
| Ready / Needs changes / Couldn't verify | `verdict`: `ready`, `needs_changes`, `could_not_verify` | The overall result of a check |
| Passed, Needs changes, Couldn't verify, Does not apply, Skipped by exception, Conflict | `outcome`: `pass`, `fail`, `unknown` / `error`, `not_applicable`, `waived`, `conflict` | The result for one rule in one check |
| Finding | `finding` | One located problem: where, found, expected |
| Suggested fix | `fix_proposal` | Proposed edits or instructions; never applied automatically |
| Change | `change` | The transition between two versions, with a diff and attribution |
| Parts that could not be read | coverage gap | Content-bearing components an adapter did not fully read |
| Confirmation | `attestation` | A named person's confirmation, bound to an exact version |
| Exception | `exception` | A recorded, expiring waiver of one rule in one scope |
| Timeline | `trace` | Everything about one artifact heading toward one action |
| Journey | (derived) | The path from one correction through rules, runs, changes and outcomes |
| Activity | event ledger view | What was added, changed, paused, approved, blocked |
| Valid until… | `receipt` | Signed evidence that a version met the rules for an action; expires; not permission |
| Approve | `approval` | A person's decision that an action may happen, bound to a version and recipient |
| Send, Release, Export | `action_request`, `execution` | A consequential action performed by a gateway adapter |
| Gated / Advisory / Observed / Not covered | coverage label; integration tier | How far the product's control actually reaches for an action. "Gated" comes with a qualifier: exclusive route, by convention, or same-account |
| Brief | `brief` | The advisory summary of context and rules given to an assistant at session start |
| Rules as of… | `policy_rev` | The workspace's policy revision in force at a moment |
| Learning (Off / Suggest / Learn quietly / Learn and enforce) | `learning_policy.mode`: `off`, `suggest`, `quiet`, `auto_low_risk` | A project's standing setting for what may be noticed and what may turn on by itself |
| Learning setting, standing permission | `learning_policy`; delegation | A person's recorded, revocable decision that low-risk tested rules may activate in one project without a per-rule click |
| Approved by … / Learned / Learned, then kept | `authority.kind`: `individual_approval`, `delegated_learning`; `authority.confirmed` | On whose authority a rule is in force |
| Shadow (note only) | `status: trial` | Evaluated and recorded on every check, shown as a note, cannot block. Used for trials and for automatically paused learned rules |
| Captured / Relayed / Not captured | capture coverage label | Whether a surface has a durable capture adapter, only an assistant's best-effort relay, or nothing |
| Captured, Identified, Compiled, Tested, On | pipeline stage: `captured`, `identified`, `compiled`, `tested`, `activated` | How far an item got between being received and becoming a rule |
| (behind "Details") | `capture_event`, `capture_stream`, cursor | One delivered event; one adapter's sequence of them; the highest sequence number safely received with nothing missing below it |
| Something you said or changed | `signal`; `trust`: `user_direct`, `assistant_relayed`, `observed_edit`, `untrusted_content` | An event identified as possibly carrying a correction, and how far its origin can be trusted |
| One attempt at one piece of work | `episode` | All messages, retries and edits about one artifact in one attempt; counts once as support |
| Learning notice | (rendered from `learning_decision.rationale`) | "Learned for *project*: *rule*. Because you said …" with Undo. Not to be confused with a validation receipt |
| Learning queue; Needs you | `inbox_item` | Where items the procedure could not settle wait for a person |
| Undo / Keep / Don't learn this | `rule.retired`; `rule.confirmed`; `suppression` | Remove a learned rule; make it person-approved; stop the same thing being raised again |
| Paused automatically | `rule.auto_paused` | A learned, unconfirmed rule moved to shadow after a contradiction or disputes |
| Details: IDs | `run_id`, `trace_id`, `event_id`, hashes | Identifiers for support, audit and re-running |

Identifier prefixes used in examples: `ws_` workspace, `prj_` project, `fld_` folder binding, `area_` area, `usr_` person, `agt_` assistant client, `ses_` session, `cor_` correction, `rul_` rule, `case_` example, `src_` source, `snap_` snapshot, `map_` field mapping, `art_` artifact, `run_` run, `trc_` trace, `fnd_` finding, `fix_` fix proposal, `chg_` change, `att_` attestation, `exc_` exception, `rcp_` receipt, `act_` action request, `apr_` approval, `adp_` adapter, `evt_` event, `lrn_` learning policy, `str_` capture stream, `cap_` capture event, `sig_` signal, `epi_` episode, `evl_` candidate evaluation, `dec_` learning decision, `inb_` inbox item, `sys_` product component.
