# Tools

| Tool | Description |
|---|---|
| `list_accounts` | List accessible mailboxes, their permissions, and the default mailbox. |
| `list_folders` | List folders and identify special roles such as inbox, junk, trash, archive, drafts, and sent. |
| `list_messages` | List messages with concise metadata and snippets; defaults to the newest 20 unread inbox messages. |
| `search_messages` | Search one folder by text, sender, subject, or date range. |
| `get_message` | Read a cleaned message with its envelope and authentication summary, with optional raw headers. |
| `get_attachment` | Fetch one attachment as text or base64, subject to the 10 MB cap. |
| `create_draft` | Create a fresh or server-threaded reply draft without sending it. |
| `update_draft` | Update supplied draft fields while preserving the others, and return the current draft ID. |
| `send_draft` | Send an existing draft, which is the only way MailMCP sends mail. |
| `move_message` | Move messages to a folder or to junk, archive, or inbox. |
| `mark_read` | Mark messages as read. |
| `mark_unread` | Mark messages as unread. |
| `delete_message` | Move messages to Trash without permanently deleting them. |
