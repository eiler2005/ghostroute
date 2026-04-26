# Shared Helpers

This directory contains internal helper libraries used by multiple operational
modules. It is not a user-facing module in the public taxonomy.

- `lib/router-health-common.sh` is shared by verification, health and traffic
  reports.
- `lib/device-labels.sh` is shared by traffic and DNS forensics reports.

Stable compatibility source paths remain available under `scripts/lib/*`.
