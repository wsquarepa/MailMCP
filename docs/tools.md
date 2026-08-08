# Tools

| Tool | Description |
|---|---|
| `list_accounts` | List accessible mailboxes, their permissions, and the default mailbox. |
| `list_folders` | List folders and identify special roles such as inbox, junk, trash, archive, drafts, and sent. |
| `list_messages` | List messages with concise metadata and snippets; defaults to the newest 20 unread inbox messages. |
| `search_messages` | Search one folder by text, sender, subject, or date range. |
| `get_message` | Read a message with its envelope and authentication summary; the body arrives as markdown with links preserved, `raw` returns the unconverted stored body, and `body_offset` pages bodies past the 30k-character window. Optional raw headers. |
| `get_attachment` | Fetch one attachment as text or base64, subject to the 10 MB cap. |
| `create_draft` | Create a fresh or server-threaded reply draft without sending it; attachments are passed by reference. |
| `update_draft` | Update supplied draft fields while preserving the others, and return the current draft ID; providing attachments replaces the set. |
| `send_draft` | Send an existing draft, which is the only way MailMCP sends mail. |
| `move_message` | Move messages to a folder or to junk, archive, or inbox. |
| `mark_read` | Mark messages as read. |
| `mark_unread` | Mark messages as unread. |
| `delete_message` | Move messages to Trash without permanently deleting them. |

## Outgoing attachments

Attachment bytes never travel through tool arguments. Each `attachments` entry in `create_draft` and `update_draft` is one of:

- `{ filename, mime_type, upload_id }` attaches bytes staged beforehand over HTTP: `POST /upload` with the raw file as the request body and the same bearer token, answered with `{ upload_id, size, expires_at }`. Uploads are capped at 3 MB each, expire after 30 minutes, are visible only to the key that staged them, and count toward a 30 MB per-key quota of live staged bytes. Staged uploads are lost on server restart.
- `{ source_message_id, source_index, filename? }` copies an attachment from an existing message in the same mailbox (indexes come from `get_message`); requires `read` permission. `filename` overrides the source's name.

A single call accepts at most 10 attachment entries, and every outgoing attachment is capped at 3 MB regardless of source.
