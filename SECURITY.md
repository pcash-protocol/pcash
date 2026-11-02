# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue or pull request for one.

Say which part is affected (the circuits, the node, the SDK and wallet, the marketplace contracts, or the website), how to reproduce it, and what an attacker could do with it.

The most serious kind is a soundness bug: a proof the rules forbid that a node still accepts. Balances are private, so value created that way would not show in any public figure. Report these even when you are unsure they can be exploited.

PCASH has no operator who can pause the network. A fix to consensus ships as a new release that nodes choose to run ([protocol specification](docs/protocol-spec.md), §3.2).

## Security review

[`docs/security.md`](docs/security.md), which the website also shows, describes how PCASH is reviewed. The current review, its report and what it found are in [pcash-protocol/audits](https://github.com/pcash-protocol/audits).
