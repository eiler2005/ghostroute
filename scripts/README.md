# Common Scripts

`scripts/` is reserved for repository-wide utilities that do not have a clear
module owner.

Module-owned commands must live under `modules/<module>/bin`, router runtime
scripts under `modules/<module>/router`, VPS runtime scripts under
`modules/<module>/vps`, and shared helpers under `modules/shared/lib`.

This directory is not an alias layer. Do not add shortcuts here for module
commands; document and call the module-native path instead.
