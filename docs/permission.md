# Permission model

| Verb | Covers |
|---|---|
| read | list, get, search, attachments (including source-copying them into drafts), headers, folders |
| draft | create and update drafts, stage attachment bytes via POST /upload |
| send | send a draft |
| organize | move (including junk/archive), mark read/unread |
| delete | move to Trash |

Effective permissions on a mailbox are the union of the mailbox's `public` list and the key's explicit grant. Every mailbox-scoped tool takes an optional `mailbox` parameter, defaulting to the key's `default_mailbox`; `list_accounts` is not mailbox-scoped. The `/upload` endpoint accepts any key holding `draft` on at least one mailbox.
