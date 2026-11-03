# Security

## Reviews

| Date | Review | Scope | Result |
|---|---|---|---|
| 2026-11-03 | AI scan by [AuditAgent](https://auditagent.nethermind.io) (Nethermind Security) | `programs/offchange_escrow/src/lib.rs` at `a3d27f7` | **88/100 quality, low risk.** 0 high, 1 medium, 1 low, 1 info; 12 invariants generated. [Report](security/2026-11-03-auditagent-scan.pdf) |

AuditAgent is an automated, AI-generated review. Its report was not checked by Nethermind's
security team and is not a security audit. No manual third-party audit has been done yet.

## Findings from the 2026-11-03 scan

### Medium: `init_config` could be front-run to take the admin role

`init_config` accepts any signer as the first admin. On mainnet the config was initialised by the
deployer, whose key is also the program's upgrade authority, so the role cannot be taken in this
deployment. Config: [`ASZwj24RR4amJU2ZEWjugTSfFgFe1tp5QnFPNZE2gFcc`](https://solscan.io/account/ASZwj24RR4amJU2ZEWjugTSfFgFe1tp5QnFPNZE2gFcc).
The next upgrade binds `init_config` to the upgrade authority in code.

**Status:** not exploitable on mainnet; code fix planned.

### Low: an empty fee wallet would make small fills fail

Crediting a fee below the rent minimum to an empty system account fails the transaction. The fee
wallet is ours and is kept above the rent minimum. A failed fill rolls back whole, so no escrowed
funds are at risk.

**Status:** mitigated operationally.

### Info: `set_config` can hand the admin role to an unusable address

`set_config` replaces the admin in one step, without the successor signing. A mistaken address
would lock configuration changes; makers can still cancel.

**Status:** acknowledged. A two-step handover comes with the move to a multisig.

## Reporting a vulnerability

Please report privately through this repository's **Security → Report a vulnerability** tab rather
than in a public issue.
