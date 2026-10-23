# WhatsApp gateway

The active provider is **Go WhatsApp v9.6.0** from
https://github.com/aldinokemal/go-whatsapp-web-multidevice.

The application uses its pinned upstream container image, not a second vendored application.
See [the migration and feature map](../docs/GOWA-MIGRATION.md) and
[the upstream contract and license](../docs/gateway/).

The former OpenWA source has been removed from the working tree. Git history and the named
legacy data volume preserve rollback material; this change does not delete stored sessions.
