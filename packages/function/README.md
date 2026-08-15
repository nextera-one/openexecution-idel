# @openexecution/function

Phase 1 IDEL function runtime: loader, admission, and composition executor.

Conforms to `idel-function-v1` in the OpenExecution standards repository.

## What it does

```
load *.func.idel  ->  digest  ->  handles  ->  execute steps  ->  receipt
```

- **Loader** (`loadFunction`) accepts only the closed Phase 1 composition set —
  `input(…)`, `step(…)[.field(…)]`, `execution.actor`, `equal`, `empty`, and
  literals. Anything resembling an expression language is a load error, and
  `function.pure` is refused as reserved for Phase 2.
- **Mode ceiling** is enforced at load time: `function.query` may declare only
  read effects, `function.workflow` only invoke effects.
- **Handles** (`buildHandles`) are built solely from `allow.effect.*` blocks.
  A function with no write effect holds no write handle, so an undeclared
  write is unrepresentable rather than merely detected.
- **Admission** (`runRequest`) runs nonce -> expiry -> digest -> capabilities
  -> atomic nonce consumption -> inputs, failing closed at the first gate. A
  nonce is consumed only after authorization succeeds, so a denied request
  cannot burn it, while concurrent identical requests cannot both execute.
- **Receipts** are IDEL Structure documents whose digest covers their own
  canonical bytes; all attacker-controlled strings use the Structure encoder,
  and `verifyReceipt` recomputes the digest and detects tampering.
- **Admission audit** is mandatory and independent of function-declared
  effects. Every success or refusal appends its sealed receipt digest to the
  caller-provided audit sink before `runRequest` returns.

## Adapters

`MemoryStore` and `MemoryEvidence` are development stand-ins for dobase and
OpenLogs, implementing the same `DataStore` / `EvidenceSink` interfaces the
governed engines must. A function that runs against them runs unchanged
against the real engines; only durability and signing differ.

Refusals are outcomes, not exceptions: `runRequest` returns a receipt with
`outcome: "refused"` and a typed reason.
