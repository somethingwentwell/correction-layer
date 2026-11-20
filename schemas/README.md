# Proposed schemas

> **Proposed, not implemented.** These JSON Schemas describe the contracts this design intends. No software produces or consumes them yet. They exist so that the design is concrete enough to criticize, and so that the example files can be checked for internal consistency.

| Schema | Describes | Explained in | Example |
|--------|-----------|--------------|---------|
| [common.schema.json](common.schema.json) | Shared definitions: identifiers, hashes, timestamps, actors, locations, typed values, the predicate grammar | — | — |
| [rule.schema.json](rule.schema.json) | One immutable revision of a rule | [Architecture §4](../docs/03-architecture.md#4-the-rule-model) | [current price](../examples/sales-proposal/rule-current-price.json), [customer currency](../examples/sales-proposal/rule-customer-currency.json), [bank details](../examples/vendor-payments/rule-bank-details.json) |
| [correction.schema.json](correction.schema.json) | A person's correction, verbatim | [Architecture §6](../docs/03-architecture.md#6-from-correction-to-active-rule) | [correction](../examples/sales-proposal/correction.json) |
| [source-snapshot.schema.json](source-snapshot.schema.json) | A trusted source and one snapshot | [Architecture §8](../docs/03-architecture.md#8-trusted-sources) | [price list](../examples/sales-proposal/source-snapshot.json) |
| [artifact.schema.json](artifact.schema.json) | A normalized artifact with provenance and coverage | [Formats §3](../docs/05-formats.md#3-the-normalized-artifact) | [proposal v1](../examples/sales-proposal/artifact-v1.json) |
| [folder-marker.schema.json](folder-marker.schema.json) | The pointer file in a registered folder | [Context §3](../docs/04-context-and-scope.md#3-registering-folders) | [marker](../examples/sales-proposal/folder-marker.json) |
| [context.schema.json](context.schema.json) | Resolved context and the session brief | [Context §4, §9](../docs/04-context-and-scope.md#4-resolving-context) | [session start](../examples/sales-proposal/context.json) |
| [run.schema.json](run.schema.json) | One check, with a result for every in-scope rule | [Observability §6](../docs/02-observability.md#6-why-did-this-check-run-or-not-run) | [check 1](../examples/sales-proposal/run-1-needs-changes.json), [check 3](../examples/sales-proposal/run-3-ready.json), [payments check 2](../examples/vendor-payments/run-2-could-not-verify.json) |
| [receipt.schema.json](receipt.schema.json) | A validation receipt | [Enforcement §3](../docs/06-enforcement-and-integration.md#3-validation-receipts) | [receipt](../examples/sales-proposal/receipt.json) |
| [action-request.schema.json](action-request.schema.json) | An action request, its approval and execution | [Enforcement §4–5](../docs/06-enforcement-and-integration.md#4-approval-is-separate-from-validation) | [send request](../examples/sales-proposal/action-request.json) |
| [event.schema.json](event.schema.json) | One ledger event | [Observability §4](../docs/02-observability.md#4-the-event-model) | — |
| [event-log.schema.json](event-log.schema.json) | An exported, contiguous segment of the ledger | [Observability §4](../docs/02-observability.md#4-the-event-model) | [timeline](../examples/sales-proposal/events.json) |

Not yet specified as schemas: exception, attestation, fix proposal, change and trace. They are described in prose and appear inside event payloads ([Open questions Q21](../docs/10-open-questions.md)).

## Conventions

- **Dialect.** JSON Schema draft 2020-12, restricted to a small subset (`type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `enum`, `const`, `pattern`, `minimum`, `maximum`, `anyOf`, `allOf`, `$ref`) so that the dependency-free checker in [`tools/check_repo.py`](../tools/check_repo.py) can validate the examples.
- **Versioning.** Every record carries `schema_version` (for example `cl.run/1`). Additions within a major version are backward compatible.
- **Identifiers.** A lowercase prefix, an underscore, then 6 to 26 letters or digits (`rul_PRICECUR`). Real identifiers would be random; the examples use readable ones. Prefixes are listed in the [glossary](../docs/glossary.md).
- **Time.** UTC, RFC 3339, second precision, with a `Z` suffix. The display timezone travels separately as an IANA name.
- **Hashes.** `sha256:` followed by 64 hexadecimal digits. In the examples, content hashes are digests of descriptive labels because no real files exist.
- **Numbers that matter** (money, quantities) are decimal strings, never binary floating point.
- **Example files** name their schema in `"$schema"` and carry a `"_note"` stating that they are proposed and illustrative. Both properties exist only for this repository.

## The ledger hash chain (proposed)

For each event, in `seq` order:

```text
payload_digest = "sha256:" + hex( SHA-256( canonical(payload) ) )
hash           = "sha256:" + hex( SHA-256( prev_hash + "\n" + canonical(event without "hash" and "payload") ) )
```

`canonical(x)` is JSON with object keys sorted, no insignificant whitespace, and UTF-8 encoding. `prev_hash` is the previous event's `hash`. Because the chain covers `payload_digest` and not the payload, an evidence payload can be erased under retention rules (`payload` becomes null and `payload_state` becomes `erased`) without breaking verification of the envelopes.

The example timeline's chain is real in this sense: `python3 tools/check_repo.py` recomputes and verifies it. A production design would also need a precisely specified canonicalization (for example RFC 8785) and signed anchors; see [Security §7](../docs/07-security-and-governance.md#7-ledger-integrity-backup-export-and-import).
