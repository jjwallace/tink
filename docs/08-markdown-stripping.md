# Markdown Stripping

Before text is sent to TTS, all markdown syntax is stripped so the voice reads clean natural language.

## What Gets Stripped

- Bold (`**text**`), italic (`*text*`), underline (`__text__`)
- Inline code (backticks) and code blocks (triple backticks)
- Headings (`# heading` → just the heading text)
- Links (`[text](url)` → keeps "text", removes URL)
- Images (`![alt](url)` → removed entirely)
- HTML tags (`<div>` etc)
- Blockquote markers (`>`)
- List markers (`-`, `*`, `1.`)
- Horizontal rules (`---`, `***`)
- Extra whitespace collapsed

## Implementation

The `strip_markdown` function in `tts.rs` processes the text before sentence splitting. It uses simple string operations rather than a full markdown parser, which handles the most common patterns without adding a dependency.
