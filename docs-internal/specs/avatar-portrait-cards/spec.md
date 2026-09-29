# Spec: Avatar Portrait Cards (server part)

Status: ready-for-agent
Status note: The full spec lives in the Formamorph repo at `docs-internal/specs/avatar-portrait-cards/spec.md`. This folder holds the one server ticket.

## Summary

The client draws Morph art for an Avatar published without art. For that, the server must flag an Avatar's stand-in thumbnail the way it already flags an entity's. Today only the entity kind sets `placeholder`, so an Avatar's copy of the silhouette looks like real art to the client.

This part turns the flag on for the `model` kind and backfills existing rows. See [issues/01-flag-avatar-stand-ins.md](issues/01-flag-avatar-stand-ins.md).
