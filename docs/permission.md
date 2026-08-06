# Permission model

| Verb | Covers |
|---|---|
| read | list, get, search, attachments, headers, folders |
| draft | create and update drafts |
| send | send a draft |
| organize | move (including junk/archive), mark read/unread |
| delete | move to Trash |

Effective permissions on a mailbox are the union of the mailbox's `public` list and the key's explicit grant. Every mailbox-scoped tool takes an optional `mailbox` parameter, defaulting to the key's `default_mailbox`; `list_accounts` is not mailbox-scoped.
