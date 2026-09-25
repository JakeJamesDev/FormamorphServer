# Spec: Blank Entity Art (server part)

Status: ready-for-agent
Status note: The full spec lives in the Formamorph repo at `docs-internal/specs/blank-entity-art/spec.md`. This folder holds the one server ticket.

## Summary

The client draws its own picture for an entity published without art. For that, the server must tell a supplied thumbnail apart from its own stand-in. Today the server copies `assets/placeholders/entity.png` into the listing's thumbnail at publish, and the two look the same to the client.

This part adds a `placeholder` flag to listings and backfills it on existing rows. See [issues/04-placeholder-flag-and-backfill.md](issues/04-placeholder-flag-and-backfill.md).
