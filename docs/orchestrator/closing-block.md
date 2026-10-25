# Closing block list rules

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a child report holds a list, or when `report` is null and `raw` carries the response.

Each value of `report.notes` and `report.deferred` is one line, the label plain at column 0. A `- `
list or an ordered `N. ` list (a `-` or a number and a period at column 0, exactly one space U+0020, then the item) that directly follows a report
label line is that label's value, or joins the value that line already holds:
the markers drop and the items join into one line with `; ` (issues #846, #879,
and #915). A list under `Blockers: none` therefore reads `none; <item>`, never
`none`. The reviewer `Verdict:` line is no report label, so a list after it
stays unparseable. One nesting level folds too:
a sub-item line (spaces U+0020 up to the column where the parent item text starts, so two after `- ` and three after `1. `, then a `-`, one space U+0020, then the
item) directly after a `- ` or `N. ` item joins into that item with `, `, and several
consecutive sub-items under one parent all fold into it, so the lines `- a`,
two spaces then `- b`, and two spaces then `- c` read `a, b, c` (issues #870 and #915). A sub-item under `1. a` takes three spaces, so `1. a` and `   - b` read `a, b`.
An indented non-list line (ASCII spaces or tabs, then text) directly after an item or its sub-items folds into that item with a space, like a Markdown lazy continuation, so `- a`, `  - b`, and `  more` read `a, b more` (issue #1082). An indented line that opens with a report label name or `Verdict` and a colon never folds, so the items after it stay unparseable lists. An indented list line there is no continuation and stays unparseable.
The run ends at the first line that is not a `- ` or `N. ` item, a sub-item of the item above it, or an indented continuation line of that item, so a blank line or unindented prose between
the label and the list breaks it. One shape with prose folds too: a blank line after the label
line (or after its folded list), then one prose line, then a `- ` list directly under that line (dash items only: an ordered list there stays unparseable).
The prose and its list join the value of the label just above, as `; <prose>: <items>` (the prose
loses a trailing colon first), so `Why: x`, a blank line, `Design settled:`, and `- a` read
`x; Design settled: a` (issue #898). The prose line must not start with whitespace (a nonbreaking or ideographic
space counts), `*`, `_`, a backtick, `>`, or `#`, must not be a list, and must not hold a report label name or `Verdict`, in
any case, followed by any run of `*`, `_`, or backtick marks (or none), whitespace (or none), and a colon, anywhere in the line. So a
`*` line (issue #275), a decorated or malformed label, and a `Verdict` line never introduce the
list. A `- ` item or sub-item that opens with a bold report label name, for example
`- **Notes:** ran`, is item text when it sits inside a run that folds under a label
(issue #1006). The same line outside such a run, and any other decorated label,
makes the block unparseable. A prose line directly after the label with no blank line,
a blank line between the prose and its list, a second prose line before the list, prose after
the reviewer `Verdict:` line, and a later repeat of the label stay unparseable. Any other list in the closing block, for
example bullets after the reviewer `Verdict:` line, a list outside any label,
a bullet with no space after the marker (`-item`, `*item`) or a separator
other than one space (a tab, a nonbreaking space, two spaces) even under an
empty label, a `*` or `+` bullet, an `N)` item, an ordered item that a blank line or prose separates from its label, a bold heading line that groups a `- ` list with no label directly above it (the parent prompt may format its own blockers as an ordered list, and a child that mirrors that shape must still put the list under a label), an indented bullet that is
not one nested level (no parent item, a second level, another indent width or
marker), makes the block unparseable, so the list surfaces
through `raw` instead of being dropped. An indented label or a decorated label
does the same. This covers a label occurrence that a later repeat shadows, which
also drops a list that the repeat shadows. A non-list line, for example a closing
sentence, does not make the block unparseable. A `*` line is not always a
list, and one shape is the case that matters here: a `*` line whose closing
`*` a letter precedes, where the character right after the close is not a word
character or `*`, and where nothing glued from that character on is a letter
or an ASCII digit, for example `*file*` or `*use a* b`. Such a line is
dropped without `raw` under any label, and every matching line in the block
drops the same way, so the block still parses with the text gone (issue #275,
accepted gap).
A child is told to write no block line that starts with `*`. Every other `*`
line either is a list and blanks the block, for example `*item`, `* item`, or
`*file*.mjs`, or is not a list and drops as prose, for example `**bold** note`.
