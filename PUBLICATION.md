# Public snapshot scope

This repository starts with an experimental source snapshot from local revision `9e20efb`. The earlier local development history is retained locally and is not uploaded: it contains machine-specific evidence paths and internal host/thread identifiers.

The public snapshot removes those identifying documentation fields, excludes common local credential/host-state files in .gitignore, and adds this publication note and architecture diagrams. Plugin runtime source and test logic are unchanged. Two existing test files have one extra terminal newline removed for a clean initial commit. Fabricated test keys, identities and loopback services are fixtures; they cannot authenticate to a real configured owner or Oracle account.

Private BB thread storage, deployment archives, installed plugin data, real control roots, account/session files, authentication screenshots, node_modules and generated dist bundles are outside this repository. Historical evidence documents retain their original scope; references to local-only evidence or previous local revisions are not publicly reproducible release attestations.

Local controlled validation and build success do not establish actual iPhone control, real OCI CLI/Console authentication, production task consumption, or complete state rollback. This publication is source sharing, not a marketplace or npm release.
